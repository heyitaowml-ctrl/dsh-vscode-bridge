const Module = require('node:module');
const path = require('node:path');

const workspaceRoot = process.cwd();
const filePath = path.join(workspaceRoot, 'dsh-vscode-bridge', 'README.md');
const commands = new Map();
const messages = [];

class Uri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = fsPath;
  }
}

const vscode = {
  version: '1.99.0-integration-test',
  Uri,
  FileType: { File: 1, Directory: 2 },
  workspace: {
    getConfiguration: () => ({
      get: (key) => {
        if (key === 'url') return '';
        if (key === 'token') return '';
        if (key === 'tokenFile') return '';
        return '';
      },
    }),
    getWorkspaceFolder: () => ({ uri: { fsPath: workspaceRoot } }),
    fs: {
      stat: async (uri) => ({
        type: uri.fsPath.endsWith('dsh-vscode-bridge') ? 2 : 1,
      }),
    },
  },
  window: {
    activeTextEditor: {
      document: { uri: new Uri(filePath), languageId: 'markdown' },
      selection: {
        isEmpty: false,
        start: { line: 2, character: 0 },
        end: { line: 4, character: 0 },
      },
    },
    setStatusBarMessage: (message, timeout) => {
      messages.push({ type: 'status', message, timeout });
      console.log(`[status] ${message}`);
      return { dispose() {} };
    },
    showErrorMessage: async (...args) => {
      messages.push({ type: 'error', args });
      console.error('[error]', ...args);
      return undefined;
    },
    showInformationMessage: async (...args) => {
      messages.push({ type: 'info', args });
      console.log('[info]', ...args);
      return undefined;
    },
    createOutputChannel: () => ({
      appendLine: (line) => console.log(`[channel] ${line}`),
      dispose() {},
    }),
  },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler);
      return { dispose() {} };
    },
    executeCommand: async () => undefined,
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  const extension = require('../vscode-dsh-bridge/extension.js');
  const context = { subscriptions: [] };
  extension.activate(context);

  if (!commands.has('dsh.sendSelection')) throw new Error('dsh.sendSelection was not registered');
  if (!commands.has('dsh.sendFile')) throw new Error('dsh.sendFile was not registered');
  if (!commands.has('dsh.showStatus')) throw new Error('dsh.showStatus was not registered');
  console.log('registered commands:', [...commands.keys()].join(', '));

  await commands.get('dsh.sendSelection')();
  await new Promise((resolve) => setTimeout(resolve, 800));

  await commands.get('dsh.sendFile')(new Uri(filePath));
  await new Promise((resolve) => setTimeout(resolve, 800));

  await commands.get('dsh.sendFile')(new Uri(path.join(workspaceRoot, 'dsh-vscode-bridge')));
  await new Promise((resolve) => setTimeout(resolve, 800));

  const failures = messages.filter((entry) => entry.type === 'error');
  if (failures.length > 0) throw new Error('extension reported an error');
  const statuses = messages.filter((entry) => entry.type === 'status').map((entry) => entry.message);
  if (statuses.length !== 3) throw new Error(`expected 3 status messages, received ${statuses.length}`);
  if (!statuses[0].includes('README.md:L3-L4')) throw new Error(`unexpected selection status: ${statuses[0]}`);
  if (!statuses[1].includes('README.md')) throw new Error(`unexpected file status: ${statuses[1]}`);
  if (!statuses[2].includes('dsh-vscode-bridge/')) throw new Error(`unexpected directory status: ${statuses[2]}`);
  console.log('PASS extension commands produced:');
  for (const status of statuses) console.log(`  - ${status}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
