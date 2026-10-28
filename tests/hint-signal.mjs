// Isolated harness for the modified Host half: no DSH process involved.
// Uses a temp bridge file so the running DSH instance's token is untouched.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const bridgeFile = join(tmpdir(), `dsh-vscode-test-${process.pid}.json`);
process.env.DSH_VSCODE_BRIDGE_FILE = bridgeFile;

const routes = new Map();
const ctx = {
  webServer: {
    getOrigin: () => 'http://127.0.0.1:59999',
    register: ({ path, handler }) => {
      routes.set(path, handler);
      return () => routes.delete(path);
    },
    tapIndex: () => () => {},
  },
  effect: (fn) => {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject: () => {},
  logger: { info: () => {}, warn: () => {} },
};

const mod = await import(new URL('../dsh-vscode-bridge/index.js', import.meta.url).href);
mod.apply(ctx);

assert.ok(routes.has('/dsh-vscode/health'), 'health route registered');
assert.ok(routes.has('/dsh-vscode/attach'), 'attach route registered');

// Minimal req/res doubles that speak the shape the handlers use.
function fakeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    destroyed: false,
    writableEnded: false,
    chunks,
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers ?? {});
    },
    write(text) {
      chunks.push(String(text));
      return true;
    },
    end(text) {
      if (text !== undefined) chunks.push(String(text));
      this.writableEnded = true;
    },
    on() {},
  };
}

function callHealth() {
  const res = fakeRes();
  routes.get('/dsh-vscode/health')({ method: 'GET', url: '/dsh-vscode/health', headers: {} }, res);
  return JSON.parse(res.chunks.join(''));
}

// 1. Fresh state: nothing has ever been attached.
const first = callHealth();
console.log('fresh health:', JSON.stringify(first));
assert.equal(first.attachments, 0, 'fresh Host reports 0 attachments');
assert.equal(first.lastAttachAt, null, 'fresh Host reports null lastAttachAt');

// The Host writes its own token file; read it to talk to the routes.
await new Promise((r) => setTimeout(r, 200));
const config = JSON.parse(await readFile(bridgeFile, 'utf8'));
assert.ok(config.token && config.channel, 'bridge file written');

// 2. A POST from the extension must bump the counter and stamp lastAttachAt.
const attachRes = fakeRes();
await routes.get('/dsh-vscode/attach')(
  {
    method: 'POST',
    url: '/dsh-vscode/attach',
    headers: { authorization: `Bearer ${config.token}` },
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(JSON.stringify({ absolutePath: 'C:/x/y.ts', kind: 'selection', startLine: 3, endLine: 5 })));
      if (event === 'end') handler();
      return this;
    },
  },
  attachRes,
);
const attachBody = JSON.parse(attachRes.chunks.join(''));
console.log('attach response:', JSON.stringify(attachBody));
assert.equal(attachBody.ok, true);

const after = callHealth();
console.log('health after one attach:', JSON.stringify(after));
assert.equal(after.attachments, 1, 'counter increments');
assert.ok(typeof after.lastAttachAt === 'string' && after.lastAttachAt.length > 0, 'lastAttachAt stamped');

// 3. The SSE hello frame must carry both fields, so the client can decide.
const eventsRes = fakeRes();
const url = `/dsh-vscode/events?channel=${config.channel}&token=${config.token}&sessionId=test-session`;
routes.get('/dsh-vscode/events')({ method: 'GET', url, headers: {}, on() { return this; } }, eventsRes);
await new Promise((r) => setTimeout(r, 100));
const stream = eventsRes.chunks.join('');
const helloLine = stream.split('\n').find((line) => line.startsWith('data: ') && line.includes('"connected"'));
assert.ok(helloLine, 'hello frame emitted');
const hello = JSON.parse(helloLine.slice(6));
console.log('hello frame:', JSON.stringify(hello));
assert.equal(hello.attachments, 1, 'hello reports attachments');
assert.ok(hello.lastAttachAt, 'hello reports lastAttachAt');

console.log('\nPASS: host half reports extension connectivity');
process.exit(0);
