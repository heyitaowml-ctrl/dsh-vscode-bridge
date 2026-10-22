const vscode = require('vscode');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const OUTPUT_NAME = 'DSH Bridge';
const DEFAULT_BRIDGE_FILE = path.join(os.homedir(), '.dsh', 'vscode-bridge.json');
const ATTACH_PATH = '/dsh-vscode/attach';
const HEALTH_PATH = '/dsh-vscode/health';
const REQUEST_TIMEOUT_MS = 5000;

class BridgeError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = options.status;
  }
}

let output;

function log(line) {
  output?.appendLine(`[${new Date().toISOString()}] ${line}`);
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\./u.test(host);
}

function normalizeBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new BridgeError('BAD_URL', `DSH 地址不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BridgeError('BAD_URL', `DSH 地址必须使用 http 或 https：${raw}`);
  }
  if (!isLoopback(url.hostname)) {
    throw new BridgeError('NON_LOOPBACK', `拒绝向非本机地址发送桥接令牌：${url.hostname}`);
  }
  return url.origin;
}

async function readBridgeConfig() {
  const config = vscode.workspace.getConfiguration('dsh.bridge');
  const configuredUrl = String(config.get('url') ?? '').trim();
  const configuredToken = String(config.get('token') ?? '').trim();
  const configuredFile = String(config.get('tokenFile') ?? '').trim();
  const envFile = String(process.env.DSH_VSCODE_BRIDGE_FILE ?? '').trim();

  const candidates = [...new Set(
    [envFile, configuredFile, DEFAULT_BRIDGE_FILE]
      .filter((candidate) => candidate !== '')
      .map((candidate) => path.resolve(expandHome(candidate))),
  )];

  let fileData;
  let usedFile;
  let lastFileError;
  for (const candidate of candidates) {
    try {
      const text = await fs.readFile(candidate, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object') {
        lastFileError = new BridgeError('BAD_CONFIG', `桥接配置文件格式不正确：${candidate}`);
        continue;
      }
      fileData = parsed;
      usedFile = candidate;
      break;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (error instanceof SyntaxError) {
        lastFileError = new BridgeError('BAD_CONFIG', `桥接配置文件不是合法 JSON：${candidate}`);
      } else {
        lastFileError = new BridgeError('READ_CONFIG', `无法读取桥接配置文件 ${candidate}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const rawUrl = configuredUrl || (typeof fileData?.url === 'string' ? fileData.url : '');
  const token = configuredToken || (typeof fileData?.token === 'string' ? fileData.token : '');

  if (rawUrl === '') {
    throw new BridgeError(
      'NO_CONFIG',
      lastFileError?.message
        ?? `未找到 DSH 桥接配置。请确认 DSH 正在运行，并且已安装 VSCode Bridge 插件。查找位置：${candidates.join('、')}`,
    );
  }
  if (token === '') {
    throw new BridgeError(
      'NO_TOKEN',
      `未找到 DSH 桥接令牌。请先启动或刷新 DSH，然后重试。配置文件：${usedFile ?? candidates[0]}`,
    );
  }

  return {
    baseUrl: normalizeBaseUrl(rawUrl),
    token,
    file: usedFile,
  };
}

function requestJson(baseUrl, pathname, options = {}) {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const body = options.body;
  const token = options.token;

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(pathname, baseUrl);
    } catch (error) {
      reject(new BridgeError('BAD_URL', `无法构造 DSH 请求地址：${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const transport = target.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { accept: 'application/json' };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = String(payload.length);
    }
    if (token) headers.authorization = `Bearer ${token}`;

    const hostname = target.hostname.replace(/^\[|\]$/gu, '');
    const request = transport.request({
      protocol: target.protocol,
      hostname,
      port: target.port === '' ? undefined : target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          response.destroy(new BridgeError('RESPONSE_TOO_LARGE', 'DSH 返回了过大的响应'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        if (text !== '') {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
        }
        if (response.statusCode !== 200) {
          const detail = typeof parsed?.error === 'string' ? parsed.error : `HTTP ${response.statusCode}`;
          reject(new BridgeError('HTTP_ERROR', `DSH 返回错误：${detail}`, { status: response.statusCode }));
          return;
        }
        resolve(parsed);
      });
      response.on('error', reject);
    });

    request.on('timeout', () => {
      request.destroy(new BridgeError('TIMEOUT', '连接 DSH 超时'));
    });
    request.on('error', (error) => {
      if (error instanceof BridgeError) {
        reject(error);
        return;
      }
      if (error?.code === 'ECONNREFUSED') {
        reject(new BridgeError('ECONNREFUSED', `无法连接 DSH（${baseUrl}）`));
        return;
      }
      reject(error);
    });
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function describeError(error) {
  if (error instanceof BridgeError) {
    if (error.code === 'ECONNREFUSED') return `${error.message}，请先启动 DSH。`;
    if (error.code === 'TIMEOUT') return '连接 DSH 超时，请确认 DSH 正在运行。';
    if (error.status === 401) return 'DSH 桥接令牌已失效，请重启 DSH 或刷新 DSH 页面后重试。';
    return error.message;
  }
  if (error?.code === 'ECONNREFUSED') return '无法连接 DSH，请先启动 DSH。';
  return error instanceof Error ? error.message : String(error);
}

function isRetryable(error) {
  return error instanceof BridgeError
    && ['ECONNREFUSED', 'TIMEOUT', 'NO_TOKEN', 'NO_CONFIG', 'READ_CONFIG'].includes(error.code);
}

async function executeWithFeedback(operation) {
  try {
    await operation();
  } catch (error) {
    const message = describeError(error);
    const actions = isRetryable(error) ? ['重试', '打开设置'] : ['打开设置'];
    const choice = await vscode.window.showErrorMessage(message, ...actions);
    if (choice === '重试') {
      await executeWithFeedback(operation);
    } else if (choice === '打开设置') {
      await vscode.commands.executeCommand('dsh.openSettings');
    }
  }
}

function frameLabel(payload) {
  const name = path.basename(payload.absolutePath) || payload.absolutePath;
  if (payload.kind === 'directory') return `${name}/`;
  if (payload.kind === 'selection' && payload.startLine !== undefined) {
    return payload.startLine === payload.endLine
      ? `${name}:L${payload.startLine}`
      : `${name}:L${payload.startLine}-L${payload.endLine}`;
  }
  return name;
}

async function sendPayload(payload) {
  const bridge = await readBridgeConfig();
  log(`POST ${bridge.baseUrl}${ATTACH_PATH} ${payload.kind} ${payload.absolutePath}${payload.startLine === undefined ? '' : ` L${payload.startLine}-${payload.endLine}`}`);
  const result = await requestJson(bridge.baseUrl, ATTACH_PATH, {
    method: 'POST',
    token: bridge.token,
    body: payload,
  });
  log(`accepted id=${result.id ?? '?'} delivered=${result.delivered === true} queued=${result.queued === true} clients=${result.clients ?? '?'}`);

  const label = frameLabel(payload);
  if (result.queued === true) {
    void vscode.window.setStatusBarMessage(`$(warning) DSH 尚未打开，已排队：${label}`, 5000);
  } else {
    void vscode.window.setStatusBarMessage(`$(check) 已添加到 DSH 对话：${label}`, 3000);
  }
}

function workspaceRelative(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder === undefined) return undefined;
  return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
}

function workspaceRoot(uri) {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
}

async function sendUri(uri, languageId) {
  if (!(uri instanceof vscode.Uri) || uri.scheme !== 'file') {
    throw new BridgeError('NOT_FILE', '只能发送本地文件或目录。');
  }
  let stat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (error) {
    throw new BridgeError('STAT_FAILED', `无法读取 ${uri.fsPath}：${error instanceof Error ? error.message : String(error)}`);
  }
  const directory = (stat.type & vscode.FileType.Directory) !== 0;
  await sendPayload({
    kind: directory ? 'directory' : 'file',
    absolutePath: uri.fsPath,
    relativePath: workspaceRelative(uri),
    workspaceRoot: workspaceRoot(uri),
    ...(directory || languageId === undefined ? {} : { languageId }),
    vscodeVersion: vscode.version,
  });
}

async function sendActiveFile() {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    throw new BridgeError('NO_EDITOR', '请先打开一个文件。');
  }
  await sendUri(editor.document.uri, editor.document.languageId);
}

async function sendSelection() {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    throw new BridgeError('NO_EDITOR', '请先打开一个文件并选中代码。');
  }
  if (editor.selection.isEmpty) {
    await sendUri(editor.document.uri, editor.document.languageId);
    return;
  }
  if (editor.document.uri.scheme !== 'file') {
    throw new BridgeError('NOT_FILE', '只能发送本地文件中的选中代码。');
  }

  const selection = editor.selection;
  const startLine = selection.start.line + 1;
  let endLine = selection.end.line + 1;
  if (selection.end.character === 0 && selection.end.line > selection.start.line) {
    endLine -= 1;
  }
  if (endLine < startLine) endLine = startLine;

  await sendPayload({
    kind: 'selection',
    absolutePath: editor.document.uri.fsPath,
    relativePath: workspaceRelative(editor.document.uri),
    workspaceRoot: workspaceRoot(editor.document.uri),
    startLine,
    endLine,
    languageId: editor.document.languageId,
    vscodeVersion: vscode.version,
  });
}

async function showStatus() {
  const bridge = await readBridgeConfig();
  const health = await requestJson(bridge.baseUrl, HEALTH_PATH);
  const connected = health.clients > 0;
  const detail = connected
    ? `已连接 ${health.clients} 个 DSH 会话，排队 ${health.queued ?? 0} 条。`
    : `当前没有打开的 DSH 对话，排队 ${health.queued ?? 0} 条。`;
  log(`health ${JSON.stringify(health)} config=${bridge.file ?? '(settings)'}`);
  await vscode.window.showInformationMessage(`DSH 桥接：${detail} 服务：${bridge.baseUrl}`);
}

function activate(context) {
  output = vscode.window.createOutputChannel(OUTPUT_NAME);
  context.subscriptions.push(output);
  log('extension activated');

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.sendSelection', () => executeWithFeedback(sendSelection)),
    vscode.commands.registerCommand('dsh.sendFile', (uri) => executeWithFeedback(async () => {
      if (uri instanceof vscode.Uri) {
        await sendUri(uri);
      } else {
        await sendActiveFile();
      }
    })),
    vscode.commands.registerCommand('dsh.showStatus', () => executeWithFeedback(showStatus)),
    vscode.commands.registerCommand('dsh.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'dsh.bridge');
    }),
  );
}

function deactivate() {
  log('extension deactivated');
}

module.exports = { activate, deactivate };
