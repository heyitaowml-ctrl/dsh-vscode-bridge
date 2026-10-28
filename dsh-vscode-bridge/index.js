import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * DSH VSCode Bridge (Host half).
 *
 * The VSCode extension POSTs a selection/file reference to /dsh-vscode/attach.
 * The browser half of this plugin keeps an SSE stream open and inserts the
 * reference text into the current composer through InputActions.
 */

export const inject = ['webServer'];

// Exported for tests: the CLI search order is the part most likely to break on a
// machine we cannot reproduce (custom install dir, no PATH, portable build).
export { resolveCli, detectExtension };

const ROUTE_PREFIX = '/dsh-vscode';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUEUE = 100;
const MAX_HISTORY = 50;
const HEARTBEAT_MS = 20_000;
const PUBLISH_RETRY_MS = 100;
const PUBLISH_MAX_ATTEMPTS = 100;

// The VSIX that ships inside this npm package, used by the one-click install.
const VSIX_FILENAME = 'dsh-vscode-bridge.vsix';
const INSTALL_TIMEOUT_MS = 60_000;
const INSTALL_OUTPUT_MAX = 2_000;
// Remembers, across DSH restarts, that this machine has the extension. Lives next
// to vscode-bridge.json so a profile reset wipes both together.
const STATE_FILENAME = 'vscode-bridge-state.json';
// How long a filesystem probe of the extension directory is reused.
const DETECT_TTL_MS = 5_000;
// `<publisher>.dsh-vscode-bridge-<version>` — the folder VS Code unpacks a VSIX into.
// Anchored at the end on purpose: a renamed leftover (`…1.0.1.bak`), a `.disabled`
// copy or an interrupted install must not count as an installed extension.
const EXTENSION_DIR_PATTERN = /^.+\.dsh-vscode-bridge-(\d+\.\d+\.\d+)$/u;
// `<publisher>.dsh-vscode-bridge` — how extensions.json spells the id.
const EXTENSION_ID_PATTERN = /\.dsh-vscode-bridge$/u;
// `code` first: it is what both the Microsoft build and most forks put on PATH.
// The other two cover Insiders and VSCodium users who have no plain `code`.
const CLI_NAMES = ['code', 'code-insiders', 'codium'];

/**
 * Absolute fallbacks for the CLI when it is not on PATH. A portable or custom
 * install (for example C:\_User\APPs\Microsoft VS Code) is invisible to us, which
 * is exactly why PATH is tried first and this list is only a net.
 */
function cliCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const out = [];
    const push = (base, ...rest) => {
      if (typeof base === 'string' && base !== '') out.push(join(base, ...rest));
    };
    push(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
    push(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd');
    push(env.ProgramFiles, 'Microsoft VS Code', 'bin', 'code.cmd');
    push(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'bin', 'code.cmd');
    push(env.ProgramFiles, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd');
    return out;
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
      join(homedir(), 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
    ];
  }
  return [
    '/usr/bin/code',
    '/usr/local/bin/code',
    '/snap/bin/code',
    '/usr/share/code/bin/code',
    '/var/lib/flatpak/exports/bin/com.visualstudio.code',
  ];
}

const EDITOR_REFERENCES_PROMPT = [
  '## VSCode references',
  'A message may contain a reference added from VSCode, written as `@<absolute path>` or',
  '`@"<absolute path>"` and optionally followed by `(line N)` or `(lines A-B)`. The path is',
  'absolute on the host. When a line marker is present, read that inclusive range from the',
  'file (use the read tool with offset/limit) before answering; do not claim to have',
  'inspected the file otherwise.',
].join('\n');

function bridgeFilePath() {
  return process.env.DSH_VSCODE_BRIDGE_FILE || join(homedir(), '.dsh', 'vscode-bridge.json');
}

/** Sidecar state file; overridable so tests can stay isolated. */
function bridgeStateFile(bridgeFile) {
  return process.env.DSH_VSCODE_BRIDGE_STATE || join(dirname(bridgeFile), STATE_FILENAME);
}

/** Extension directories to inspect, in order. Override for other editors/tests. */
function extensionRoots(home = homedir(), env = process.env) {
  const override = env.DSH_VSCODE_EXTENSION_DIRS;
  if (typeof override === 'string' && override.trim() !== '') {
    return override.split(/[;,]/u).map((entry) => entry.trim()).filter((entry) => entry !== '');
  }
  return [
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.vscode-oss', 'extensions'),
    join(home, '.cursor', 'extensions'),
    join(home, '.windsurf', 'extensions'),
  ];
}

/**
 * Read one editor's `extensions.json` registry.
 *
 * This file — not the folder layout — is what VS Code considers installed. A
 * `code --install-extension` that never completed can leave the unpacked folder
 * behind with no registry entry, and trusting the folder reports "installed" for
 * an extension the editor does not have.
 */
function readExtensionRegistry(root) {
  try {
    // Strip a leading BOM: Windows editors add one, and JSON.parse rejects it.
    const raw = readFileSync(join(root, 'extensions.json'), 'utf8').replace(/^\uFEFF/u, '');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Look for the unpacked extension on disk.
 *
 * Three outcomes, because "not found" is only trustworthy when we actually had a
 * place to look:
 *   installed — a registry entry names it (or, without a registry, a matching folder)
 *   absent    — an editor exists and does not have it, even if leftover folders do
 *   unknown   — no editor directory exists at all (or the scan failed), so the
 *               caller must fall back to remembered state instead of guessing
 *
 * `registered: false` on an installed result means only the folder matched, i.e.
 * the editor has not recorded the extension and its commands will not load.
 */
function detectExtension(roots = extensionRoots()) {
  const leftoverFolders = [];
  let looked = 0;

  for (const root of roots) {
    let dirs;
    try {
      dirs = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    looked += 1;

    const registry = readExtensionRegistry(root);
    if (registry !== undefined) {
      const hit = registry.find((entry) => typeof entry?.identifier?.id === 'string'
        && EXTENSION_ID_PATTERN.test(entry.identifier.id.toLowerCase()));
      if (hit !== undefined) {
        const relative = typeof hit.relativeLocation === 'string' ? hit.relativeLocation : '';
        return {
          state: 'installed',
          registered: true,
          root,
          path: relative !== '' ? join(root, relative) : join(root),
          version: typeof hit.version === 'string' ? hit.version : undefined,
        };
      }
      // The registry is authoritative for this editor: no entry means absent,
      // which is exactly what turns a half-finished install into a visible hint.
      continue;
    }

    for (const entry of dirs) {
      if (entry.isDirectory() && EXTENSION_DIR_PATTERN.test(entry.name)) {
        leftoverFolders.push({ root, name: entry.name });
      }
    }
  }

  if (leftoverFolders.length > 0) {
    // An editor with no registry at all: the folder is the only evidence we have.
    const first = leftoverFolders[0];
    const version = EXTENSION_DIR_PATTERN.exec(first.name)?.[1];
    return {
      state: 'installed',
      registered: false,
      root: first.root,
      path: join(first.root, first.name),
      version,
    };
  }

  return { state: looked > 0 ? 'absent' : 'unknown' };
}

/** Directory of this package — where the bundled VSIX lives. */
const packageDir = () => dirname(fileURLToPath(import.meta.url));

/** Keep CLI output small enough to travel in a JSON response. */
const clamp = (text) => {
  if (typeof text !== 'string') return '';
  return text.length > INSTALL_OUTPUT_MAX ? `${text.slice(0, INSTALL_OUTPUT_MAX)}…` : text;
};

/**
 * Default value of a Windows registry key, or undefined.
 *
 * `reg.exe` is the only registry access Node has without a native module, so this
 * costs one short-lived process — and only on the fallback path, after PATH lookup
 * has already failed.
 */
function regDefault(key) {
  try {
    const out = execFileSync('reg.exe', ['query', key, '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    const match = /REG_\w+\s+(.+?)\s*$/mu.exec(out);
    return match === null ? undefined : match[1].trim();
  } catch {
    return undefined;
  }
}

/**
 * Locate a CLI through the Windows registry.
 *
 * VS Code writes `App Paths\Code.exe` for both the user and the system installer,
 * pointing at wherever the user chose to install — including paths that never
 * reached PATH (a custom folder, a portable install with the shell integration
 * skipped). The `bin\code.cmd` shim always sits beside the executable.
 */
function cliFromWindowsRegistry() {
  if (process.platform !== 'win32') return undefined;
  for (const hive of ['HKCU', 'HKLM']) {
    const exe = regDefault(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe`);
    if (typeof exe === 'string' && exe !== '') {
      const cmd = join(dirname(exe), 'bin', 'code.cmd');
      return cmd;
    }
  }
  return undefined;
}

/**
 * Find a VS Code CLI, in the order that is most likely to be right:
 *
 *   1. DSH_VSCODE_CLI — an explicit path, for anything we cannot discover
 *   2. the Host's own resolution — it knows the scrubbed PATH the rest of DSH uses
 *   3. the Windows registry — the only source that knows about custom install dirs
 *   4. well-known absolute locations — a last net for portable/odd installs
 */
async function resolveCli(subprocess) {
  const override = process.env.DSH_VSCODE_CLI;
  if (typeof override === 'string' && override.trim() !== '') {
    const candidate = override.trim();
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Fall through: a stale override must not disable the other strategies.
    }
  }

  if (typeof subprocess?.resolveExecutable === 'function') {
    for (const name of CLI_NAMES) {
      try {
        const found = await subprocess.resolveExecutable(name);
        if (typeof found === 'string' && found !== '') return found;
      } catch {
        // Not resolvable here; try the next name.
      }
    }
  }

  const fromRegistry = cliFromWindowsRegistry();
  if (fromRegistry !== undefined) {
    try {
      if ((await stat(fromRegistry)).isFile()) return fromRegistry;
    } catch {
      // The registry can point at something uninstalled; keep going.
    }
  }

  for (const candidate of cliCandidates()) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Absent; keep probing.
    }
  }
  return undefined;
}

function tokenMatches(expected, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(candidate, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/iu.exec(header);
  return match?.[1]?.trim() ?? '';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('body_too_large'));
        try {
          req.destroy();
        } catch {
          // The peer may already be gone.
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text === '' ? {} : JSON.parse(text));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('aborted')));
  });
}

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(body);
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  } catch {
    // The request was aborted; there is no response to write.
  }
}

function toLine(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < 1 || number > 10_000_000) return undefined;
  return number;
}

function cleanSessionId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 200) return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined;
  return trimmed;
}

function quotePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    throw new Error('invalid_path');
  }
  if (/[\u0000-\u001f\u007f"]/u.test(path)) {
    throw new Error('unsupported_path_characters');
  }
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}

function formatAttachmentText(item) {
  let path = item.absolutePath;
  if (item.kind === 'directory') {
    path = `${path.replace(/[\\/]+$/u, '')}/`;
  }
  const reference = quotePath(path);
  if (item.kind === 'selection' && item.startLine !== undefined) {
    const suffix = item.startLine === item.endLine
      ? `line ${item.startLine}`
      : `lines ${item.startLine}-${item.endLine}`;
    return `${reference} (${suffix})`;
  }
  return reference;
}

function normalizeAttachment(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body_must_be_object');
  }
  const absolutePath = body.absolutePath;
  if (typeof absolutePath !== 'string' || absolutePath.trim() === '' || absolutePath.length > 4096) {
    throw new Error('invalid_absolute_path');
  }
  if (/[\u0000-\u001f\u007f"]/u.test(absolutePath)) {
    throw new Error('unsupported_path_characters');
  }

  const kind = body.kind === 'directory'
    ? 'directory'
    : body.kind === 'selection' ? 'selection' : 'file';

  let startLine;
  let endLine;
  if (kind === 'selection') {
    startLine = toLine(body.startLine);
    endLine = toLine(body.endLine ?? body.startLine);
    if (startLine === undefined) throw new Error('invalid_start_line');
    if (endLine === undefined || endLine < startLine) throw new Error('invalid_end_line');
  }

  const item = {
    absolutePath,
    kind,
    ...(startLine === undefined ? {} : { startLine, endLine }),
  };
  if (typeof body.relativePath === 'string' && body.relativePath.length <= 4096) {
    item.relativePath = body.relativePath;
  }
  if (typeof body.workspaceRoot === 'string' && body.workspaceRoot.length <= 4096) {
    item.workspaceRoot = body.workspaceRoot;
  }
  if (typeof body.languageId === 'string' && body.languageId.length <= 80) {
    item.languageId = body.languageId;
  }
  if (typeof body.vscodeVersion === 'string' && body.vscodeVersion.length <= 40) {
    item.vscodeVersion = body.vscodeVersion;
  }
  return item;
}

function injectBridgeConfig(html, token, channel) {
  const value = JSON.stringify({ token, channel }).replaceAll('<', '\\u003c');
  const script = `<script>globalThis.__DSH_VSCODE_BRIDGE__=${value};</script>`;
  if (/<head(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/iu, (open) => `${open}${script}`);
  }
  return `${script}${html}`;
}

export function apply(ctx) {
  const token = randomBytes(24).toString('hex');
  const channel = randomBytes(12).toString('hex');
  const clients = new Map();
  const queue = [];
  const history = [];
  const bridgeFile = bridgeFilePath();
  const stateFile = bridgeStateFile(bridgeFile);

  // Whether this machine has ever had the extension must survive a restart:
  // `sequence` resets to 0 on every start, so using it alone made the hint
  // reappear on every launch even with the extension installed and working.
  let extensionSeenAt;
  let extensionInstalledAt;
  try {
    // Strip a leading BOM: Windows editors add one, and JSON.parse rejects it.
    // Without this a hand-edited state file silently reads as "no extension".
    const state = JSON.parse(readFileSync(stateFile, 'utf8').replace(/^\uFEFF/u, ''));
    if (typeof state?.extensionSeenAt === 'string') extensionSeenAt = state.extensionSeenAt;
    if (typeof state?.extensionInstalledAt === 'string') extensionInstalledAt = state.extensionInstalledAt;
  } catch {
    // No state file yet (or it is unreadable): the extension is unknown.
  }

  // Probe results are cached briefly: detection reads a directory, and both
  // /health and every SSE hello ask for the answer.
  let detected;
  let detectedAt = 0;
  const currentExtension = (force = false) => {
    const now = Date.now();
    if (!force && detected !== undefined && now - detectedAt < DETECT_TTL_MS) return detected;
    detected = detectExtension();
    detectedAt = now;
    return detected;
  };

  /**
   * Whether the extension should be considered present.
   *
   * Order matters. A reference that arrived in this very session is proof; then a
   * filesystem hit; then absence — which is only trustworthy when there was an
   * editor directory to look in; and only then the remembered state, for editors
   * whose layout we do not know.
   *
   * Checking `sequence` first keeps a working extension visible if a probe fails;
   * checking `absent` before the state file is what makes deleting the extension
   * bring the hint back instead of staying silent forever.
   */
  const extensionKnown = (force = false) => {
    if (sequence > 0) return true;
    const probe = currentExtension(force);
    if (probe.state === 'installed') return true;
    if (probe.state === 'absent') return false;
    return extensionSeenAt !== undefined || extensionInstalledAt !== undefined;
  };

  const persistState = () => {
    const payload = JSON.stringify({
      extensionSeenAt: extensionSeenAt ?? null,
      extensionInstalledAt: extensionInstalledAt ?? null,
      updatedAt: new Date().toISOString(),
    }, null, 2);
    void (async () => {
      try {
        await mkdir(dirname(stateFile), { recursive: true });
        await writeFile(stateFile, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        warn(`cannot write ${stateFile}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  };

  let sequence = 0;
  let lastClientId;
  let lastSessionId;
  let lastAttachAt;
  let published = false;
  let publishing = false;
  let publishAttempts = 0;
  let publishTimer;
  let disposed = false;
  let configFetches = 0;
  let installing = false;

  const info = (...args) => {
    try {
      ctx.logger?.info?.('[dsh-vscode-bridge]', ...args);
    } catch {
      // Logging must never break the bridge.
    }
  };
  const warn = (...args) => {
    try {
      ctx.logger?.warn?.('[dsh-vscode-bridge]', ...args);
    } catch {
      // Logging must never break the bridge.
    }
  };
  const origin = () => {
    try {
      return ctx.webServer.getOrigin();
    } catch {
      return undefined;
    }
  };

  const removeClient = (id) => {
    const client = clients.get(id);
    if (client === undefined) return;
    clearInterval(client.heartbeat);
    clients.delete(id);
    try {
      client.res.end();
    } catch {
      // The socket is already closed.
    }
    if (lastClientId === id) {
      const remaining = [...clients.values()];
      const last = remaining[remaining.length - 1];
      lastClientId = last?.id;
      lastSessionId = last?.sessionId;
    }
  };

  const pushHistory = (item) => {
    history.push(item);
    while (history.length > MAX_HISTORY) history.shift();
  };

  const enqueue = (item) => {
    queue.push(item);
    while (queue.length > MAX_QUEUE) queue.shift();
  };

  const writeEvent = (client, item) => {
    if (client.res.destroyed || client.res.writableEnded) return false;
    try {
      client.res.write(`id: ${String(item.seq)}\nevent: attachment\ndata: ${JSON.stringify(item)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  const flushQueue = (client) => {
    if (queue.length === 0) return;
    const pending = queue.splice(0, queue.length);
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      if (!writeEvent(client, item)) {
        queue.unshift(...pending.slice(index));
        return;
      }
      pushHistory(item);
    }
  };

  const deliver = (item) => {
    const candidates = [...clients.values()];
    if (candidates.length === 0) {
      enqueue(item);
      return { delivered: false, queued: true };
    }
    const preferred = (lastClientId === undefined ? undefined : clients.get(lastClientId))
      ?? candidates[candidates.length - 1];
    if (preferred === undefined || !writeEvent(preferred, item)) {
      if (preferred !== undefined) removeClient(preferred.id);
      enqueue(item);
      return { delivered: false, queued: true };
    }
    pushHistory(item);
    return { delivered: true, queued: false };
  };

  const removeBridgeFile = async () => {
    try {
      const text = await readFile(bridgeFile, 'utf8');
      const current = JSON.parse(text);
      if (current?.token === token) await rm(bridgeFile, { force: true });
    } catch {
      // The file may be absent, unreadable, or owned by another instance.
    }
  };

  const publishBridgeFile = async () => {
    if (published || publishing || disposed) return;
    const url = origin();
    if (url === undefined) {
      if (publishTimer === undefined && publishAttempts < PUBLISH_MAX_ATTEMPTS) {
        publishAttempts += 1;
        publishTimer = setTimeout(() => {
          publishTimer = undefined;
          void publishBridgeFile();
        }, PUBLISH_RETRY_MS);
      } else if (publishAttempts >= PUBLISH_MAX_ATTEMPTS) {
        warn('web server origin is still unavailable; token file was not written');
      }
      return;
    }
    publishing = true;
    try {
      await mkdir(dirname(bridgeFile), { recursive: true });
      const payload = {
        version: 1,
        url,
        token,
        channel,
        profile: process.env.DSH_PROFILE ?? null,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      };
      await writeFile(bridgeFile, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      published = true;
      info(`ready at ${url} (config: ${bridgeFile})`);
    } catch (error) {
      warn(`cannot write ${bridgeFile}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      publishing = false;
    }
  };

  const handleAttach = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!tokenMatches(token, bearerToken(req))) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid_body' });
      return;
    }
    let attachment;
    try {
      attachment = normalizeAttachment(body);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid_attachment' });
      return;
    }

    sequence += 1;
    const item = {
      id: String(sequence),
      seq: sequence,
      receivedAt: new Date().toISOString(),
      source: 'vscode',
      ...attachment,
    };
    item.text = formatAttachmentText(item);
    lastAttachAt = item.receivedAt;
    if (extensionSeenAt === undefined) {
      extensionSeenAt = item.receivedAt;
      persistState();
    }
    const outcome = deliver(item);
    void publishBridgeFile();
    info(`attachment ${item.id}: ${item.kind} ${item.absolutePath}${item.startLine === undefined ? '' : ` lines ${item.startLine}-${item.endLine}`} delivered=${String(outcome.delivered)}`);
    sendJson(res, 200, {
      ok: true,
      id: item.id,
      delivered: outcome.delivered,
      queued: outcome.queued,
      clients: clients.size,
    });
  };

  const handleEvents = (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_url' });
      return;
    }
    if (url.searchParams.get('channel') !== channel
      || !tokenMatches(token, url.searchParams.get('token') ?? '')) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    const sessionId = cleanSessionId(url.searchParams.get('sessionId'));

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const client = {
      id: randomBytes(8).toString('hex'),
      res,
      sessionId,
      connectedAt: Date.now(),
      heartbeat: undefined,
    };
    client.heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        removeClient(client.id);
        return;
      }
      try {
        res.write(': ping\n\n');
      } catch {
        removeClient(client.id);
      }
    }, HEARTBEAT_MS);
    client.heartbeat.unref?.();

    clients.set(client.id, client);
    lastClientId = client.id;
    lastSessionId = sessionId;
    info(`SSE client ${client.id} connected for session ${sessionId ?? '(unknown)'}`);

    try {
      // Force a fresh probe: each page load is exactly when a freshly uninstalled
      // (or reinstalled) extension should be noticed.
      const probe = currentExtension(true);
      res.write(`event: hello\ndata: ${JSON.stringify({
        connected: true,
        sessionId: sessionId ?? null,
        queued: queue.length,
        attachments: sequence,
        lastAttachAt: lastAttachAt ?? null,
        extensionKnown: extensionKnown(true),
        extensionState: probe.state,
        extensionRegistered: probe.registered ?? null,
        extensionPath: probe.path ?? null,
        extensionVersion: probe.version ?? null,
        extensionSeenAt: extensionSeenAt ?? null,
        extensionInstalledAt: extensionInstalledAt ?? null,
      })}\n\n`);
    } catch {
      removeClient(client.id);
      return;
    }

    const lastEventId = Number(req.headers['last-event-id'] ?? '0');
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      for (const item of history) {
        if (item.seq > lastEventId) writeEvent(client, item);
      }
    }
    flushQueue(client);

    const cleanup = () => {
      removeClient(client.id);
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  };

  /**
   * True for requests the DSH page itself makes: same origin, or the Desktop
   * protocol handler forwarding with the Host-issued authentication cookie.
   * The Desktop renderer uses the dsh-app:// scheme and strips Origin and
   * Sec-Fetch-Site, so the cookie is the only evidence left.
   */
  const trustedPageRequest = (req) => {
    const expected = origin();
    const originHeader = req.headers.origin;
    const referer = req.headers.referer;
    const site = req.headers['sec-fetch-site'];
    const sameOrigin = expected !== undefined
      && (originHeader === expected
        || (typeof referer === 'string' && (referer === expected || referer.startsWith(`${expected}/`)))
        || site === 'same-origin');
    const desktopForwarded = typeof req.headers.cookie === 'string'
      && req.headers.cookie !== ''
      && (typeof referer === 'string' ? referer.startsWith('dsh-app://app/') : true);
    return sameOrigin || desktopForwarded;
  };

  const handleConfig = (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!trustedPageRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    configFetches += 1;
    sendJson(res, 200, { ok: true, version: 1, token, channel });
  };

  const handleHealth = (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    void publishBridgeFile();
    // ?refresh=1 skips the probe cache, so the UI's 重新检测 button gets a real answer.
    let force = false;
    try {
      force = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1';
    } catch {
      // A malformed query is not worth rejecting the whole request for.
    }
    const probe = currentExtension(force);
    sendJson(res, 200, {
      ok: true,
      version: 1,
      clients: clients.size,
      queued: queue.length,
      sessionId: lastSessionId ?? null,
      configFetches,
      attachments: sequence,
      lastAttachAt: lastAttachAt ?? null,
      extensionKnown: extensionKnown(force),
      extensionState: probe.state,
      extensionRegistered: probe.registered ?? null,
      extensionPath: probe.path ?? null,
      extensionVersion: probe.version ?? null,
      extensionSeenAt: extensionSeenAt ?? null,
      extensionInstalledAt: extensionInstalledAt ?? null,
    });
  };

  /**
   * One-click install of the companion VS Code extension.
   *
   * Deliberately POST + page-trust only: this runs a local binary, so it must
   * never be reachable from another origin, and it never runs unless the user
   * clicked a button (no install-time side effects, which every plugin review
   * treats as a red flag).
   */
  const handleInstallExtension = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method_not_allowed' });
      return;
    }
    if (!trustedPageRequest(req)) {
      sendJson(res, 403, { ok: false, code: 'forbidden' });
      return;
    }
    if (installing) {
      sendJson(res, 409, { ok: false, code: 'already_running' });
      return;
    }

    const vsix = join(packageDir(), VSIX_FILENAME);
    try {
      const info = await stat(vsix);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      sendJson(res, 200, {
        ok: false,
        code: 'vsix_missing',
        message: `this package is missing its bundled VSIX (${VSIX_FILENAME}); install the extension manually`,
      });
      return;
    }

    const subprocess = (() => {
      try {
        return typeof ctx.get === 'function' ? ctx.get('subprocess') : ctx.subprocess;
      } catch {
        return undefined;
      }
    })();

    const cli = await resolveCli(subprocess);
    if (cli === undefined) {
      sendJson(res, 200, {
        ok: false,
        code: 'cli_not_found',
        message: 'no VS Code command line found; install the extension manually or add `code` to PATH',
        tried: [...CLI_NAMES, ...cliCandidates()],
      });
      return;
    }

    if (typeof subprocess?.spawn !== 'function') {
      sendJson(res, 200, {
        ok: false,
        code: 'spawn_unavailable',
        cli,
        message: 'this Host does not expose the subprocess service; install the extension manually',
      });
      return;
    }

    // A .cmd/.bat shim cannot be executed directly: Windows needs cmd.exe /c.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(cli);
    const argv = needsShell
      ? [process.env.ComSpec ?? 'cmd.exe', '/c', cli, '--install-extension', vsix, '--force']
      : [cli, '--install-extension', vsix, '--force'];

    installing = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INSTALL_TIMEOUT_MS);
    timer.unref?.();
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: packageDir(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 * 1024 },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: 5_000,
        signal: controller.signal,
      });
      const outcome = await handle.done;
      const stdout = clamp(handle.collected?.stdout?.readFrom(0)?.text ?? '');
      const stderr = clamp(handle.collected?.stderr?.readFrom(0)?.text ?? '');
      const ok = outcome?.exitCode === 0;
      let verified;
      if (ok) {
        // Drop the cached probe so the next hello/health sees the new folder, and
        // remember the install in case this editor lives outside the roots we scan.
        detected = undefined;
        detectedAt = 0;
        if (extensionInstalledAt === undefined) {
          extensionInstalledAt = new Date().toISOString();
          persistState();
        }
        verified = currentExtension(true);
      }
      info(`one-click install ${ok ? 'succeeded' : 'failed'} via ${cli} (exit ${String(outcome?.exitCode ?? null)})`);

      // `code --install-extension` can copy the files and still leave the editor's
      // registry untouched (it happened on this machine). Say so instead of
      // claiming success, otherwise the user is left with a ghost folder and a
      // hint that never comes back.
      const registered = verified === undefined ? null : verified.state === 'installed' && verified.registered === true;
      const ghost = ok && registered === false;
      sendJson(res, 200, {
        ok: ok && !ghost,
        code: ghost ? 'installed_not_registered' : ok ? 'installed' : 'install_failed',
        extensionState: verified?.state ?? null,
        extensionRegistered: registered,
        cli,
        exitCode: outcome?.exitCode ?? null,
        stdout,
        stderr,
        message: ghost
          ? 'VSIX 已解包，但 VS Code 没有登记它：请先启动一次 VS Code，再回到这里重新检测'
          : ok
            ? 'installed — reload the VS Code window to pick up the DSH commands'
            : '`code --install-extension` returned a non-zero exit code',
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      warn(`one-click install failed: ${error instanceof Error ? error.message : String(error)}`);
      sendJson(res, 200, {
        ok: false,
        code: aborted ? 'timeout' : 'spawn_failed',
        cli,
        message: aborted
          ? `giving up after ${INSTALL_TIMEOUT_MS} ms`
          : error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
      installing = false;
    }
  };

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/attach`, handler: handleAttach }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/events`, handler: handleEvents }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/config`, handler: handleConfig }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/health`, handler: handleHealth }),
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/install-extension`,
        handler: (req, res) => {
          void handleInstallExtension(req, res).catch((error) => {
            warn(`install route failed: ${error instanceof Error ? error.message : String(error)}`);
            try {
              sendJson(res, 500, { ok: false, code: 'internal_error' });
            } catch {
              // The response may already be gone.
            }
          });
        },
      }),
      ctx.webServer.tapIndex((html) => injectBridgeConfig(html, token, channel)),
    ];
    return () => {
      disposed = true;
      if (publishTimer !== undefined) clearTimeout(publishTimer);
      for (const disposer of disposers) {
        try {
          disposer();
        } catch {
          // Disposal is best-effort.
        }
      }
      for (const id of [...clients.keys()]) removeClient(id);
      queue.length = 0;
      history.length = 0;
      void removeBridgeFile();
    };
  }, 'dsh-vscode-bridge routes');

  ctx.inject(['systemPrompt'], (child) => {
    child.effect(
      () => child.systemPrompt.section({
        name: 'vscode-references',
        order: 810,
        text: EDITOR_REFERENCES_PROMPT,
      }),
      'dsh-vscode-bridge prompt',
    );
  });

  void publishBridgeFile();
}
