import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const configPath = process.env.DSH_VSCODE_BRIDGE_FILE || join(homedir(), '.dsh', 'vscode-bridge.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const base = config.url;

async function post(body, token = config.token) {
  const res = await fetch(`${base}/dsh-vscode/attach`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function openSse(sessionId) {
  const url = new URL('/dsh-vscode/events', base);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('channel', config.channel);
  url.searchParams.set('token', config.token);
  const controller = new AbortController();
  const events = [];
  const waiters = [];
  const ready = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    assert.equal(res.status, 200, `SSE status ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let at;
          while ((at = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const event = {};
            for (const line of frame.split('\n')) {
              if (line.startsWith(':')) continue;
              const colon = line.indexOf(':');
              if (colon === -1) continue;
              const field = line.slice(0, colon);
              const value = line.slice(colon + 1).trimStart();
              if (field === 'event') event.event = value;
              else if (field === 'data') event.data = value;
              else if (field === 'id') event.id = value;
            }
            if (event.event !== undefined) {
              const parsed = { ...event, json: event.data ? JSON.parse(event.data) : undefined };
              events.push(parsed);
              for (const waiter of waiters.splice(0)) waiter(parsed);
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error('stream error', error);
      }
    })();
    return res;
  })();

  return {
    controller,
    ready,
    events,
    waitFor(eventName, predicate = () => true, timeoutMs = 4000) {
      const existing = events.find((event) => event.event === eventName && predicate(event));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${eventName}`)), timeoutMs);
        const check = (event) => {
          if (event.event === eventName && predicate(event)) {
            clearTimeout(timer);
            resolve(event);
          } else {
            waiters.push(check);
          }
        };
        waiters.push(check);
      });
    },
    close() {
      controller.abort();
    },
  };
}

const samplePath = join(process.cwd(), 'README.md');
const spacedPath = join(process.cwd(), 'path with spaces', 'demo.ts');

// 1. Unauthorized request is rejected.
{
  const result = await post({ kind: 'file', absolutePath: samplePath }, 'wrong-token');
  assert.equal(result.status, 401);
  console.log('PASS unauthorized rejected');
}

// 2. Queue while no SSE client is connected. Skip this when a real DSH page is
// connected: the Host would deliver the test attachment into that composer.
let queuedId;
{
  const health = await (await fetch(`${base}/dsh-vscode/health`)).json();
  if (health.clients === 0) {
    const result = await post({ kind: 'selection', absolutePath: samplePath, startLine: 3, endLine: 7 });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.queued, true);
    queuedId = result.body.id;
    console.log('PASS queued while disconnected', result.body);
  } else {
    console.log(`SKIP queue test: ${health.clients} real DSH client(s) connected`);
  }
}

// 3. Connecting flushes the queue.
const sse = openSse('bridge-test-session');
await sse.ready;
{
  const hello = await sse.waitFor('hello');
  assert.equal(hello.json.sessionId, 'bridge-test-session');
  if (queuedId !== undefined) {
    const queued = await sse.waitFor('attachment', (event) => event.json.id === queuedId);
    assert.equal(queued.json.text, `@${samplePath} (lines 3-7)`);
    console.log('PASS queued attachment flushed on connect:', queued.json.text);
  }
}

// 4. Live delivery.
{
  const result = await post({
    kind: 'file',
    absolutePath: spacedPath,
    relativePath: 'path with spaces/demo.ts',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.delivered, true);
  const event = await sse.waitFor('attachment', (candidate) => candidate.json.id === result.body.id);
  assert.equal(
    event.json.text,
    `@"${spacedPath}"`,
  );
  console.log('PASS live attachment with quoted path:', event.json.text);
}

// 5. Directory reference gets a trailing slash.
{
  const result = await post({ kind: 'directory', absolutePath: process.cwd() });
  assert.equal(result.status, 200);
  const event = await sse.waitFor('attachment', (candidate) => candidate.json.id === result.body.id);
  assert.equal(event.json.text, `@${process.cwd().replace(/[\\/]+$/u, '')}/`);
  console.log('PASS directory reference:', event.json.text);
}

// 6. Health reflects the connected client.
{
  const res = await fetch(`${base}/dsh-vscode/health`);
  const health = await res.json();
  assert.ok(health.clients >= 1, `expected at least one client, got ${health.clients}`);
  assert.equal(health.sessionId, 'bridge-test-session');
  console.log('PASS health:', health);
}

sse.close();
console.log('ALL BRIDGE HOST TESTS PASSED');
