import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * DSH VSCode Bridge (Host half).
 *
 * The VSCode extension POSTs a selection/file reference to /dsh-vscode/attach.
 * The browser half of this plugin keeps an SSE stream open and inserts the
 * reference text into the current composer through InputActions.
 */

export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-vscode';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUEUE = 100;
const MAX_HISTORY = 50;
const HEARTBEAT_MS = 20_000;
const PUBLISH_RETRY_MS = 100;
const PUBLISH_MAX_ATTEMPTS = 100;

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
      res.write(`event: hello\ndata: ${JSON.stringify({
        connected: true,
        sessionId: sessionId ?? null,
        queued: queue.length,
        attachments: sequence,
        lastAttachAt: lastAttachAt ?? null,
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

  const handleConfig = (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    const expected = origin();
    const originHeader = req.headers.origin;
    const referer = req.headers.referer;
    const site = req.headers['sec-fetch-site'];
    const sameOrigin = expected !== undefined
      && (originHeader === expected
        || (typeof referer === 'string' && (referer === expected || referer.startsWith(`${expected}/`)))
        || site === 'same-origin');
    // The Desktop renderer uses the dsh-app:// scheme. Its protocol handler
    // forwards every non-asset request to this server with the Host-issued
    // authentication cookie, but strips Origin and Sec-Fetch-Site.
    const desktopForwarded = typeof req.headers.cookie === 'string'
      && req.headers.cookie !== ''
      && (typeof referer === 'string' ? referer.startsWith('dsh-app://app/') : true);
    if (!sameOrigin && !desktopForwarded) {
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
    sendJson(res, 200, {
      ok: true,
      version: 1,
      clients: clients.size,
      queued: queue.length,
      sessionId: lastSessionId ?? null,
      configFetches,
      attachments: sequence,
      lastAttachAt: lastAttachAt ?? null,
    });
  };

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/attach`, handler: handleAttach }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/events`, handler: handleEvents }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/config`, handler: handleConfig }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/health`, handler: handleHealth }),
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
