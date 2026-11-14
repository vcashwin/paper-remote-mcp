// node --test runtime/server.test.js: the container API against fake engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './server.js';

const S1 = { cookies: [{ name: 'D7pPzj4phQRAjBC01', value: 'one', domain: '.paper.design' }] };
const S2 = { cookies: [{ name: 'D7pPzj4phQRAjBC01', value: 'two', domain: '.paper.design' }] };
const FILE = '01KQ3Z0ZJ9W4P8V6X2N7T5R3MB';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
/** @param {string} text */
const ok = (text) => ({ content: [{ type: 'text', text }] });
/** @param {string} code */
const fails = (code) => Object.assign(new Error(code), { code });
const fileTool = { inputSchema: { properties: { fileId: {} } } };
const TOOLS = [
  { name: 'get_basic_info', ...fileTool },
  { name: 'write_html', ...fileTool },
  { name: 'get_screenshot', ...fileTool },
  { name: 'open_file', ...fileTool },
  { name: 'export', ...fileTool },
  { name: 'list_resources', inputSchema: { properties: {} } },
];

/**
 * @typedef {{ name: string, closed: boolean, stale: boolean, calls: any[], startedWith: any, cookies: any,
 *   catalogClients: any[], catalog(c: any): Promise<any>, call(c: any): Promise<any>, session(): any,
 *   close(): Promise<void> }} Fake
 */

/** A fake engine; `behave(call, engine)` decides what a call does. @param {string} name @param {any} session */
function fakeEngine(name, session, behave = (/** @type {any} */ c, /** @type {Fake} */ e) => ok(name)) {
  /** @type {Fake} */
  const engine = {
    name,
    closed: false,
    stale: false,
    calls: [],
    startedWith: session,
    cookies: null,
    catalogClients: [],
    async catalog(clientInfo) {
      engine.catalogClients.push(clientInfo);
      return { tools: TOOLS, instructions: name };
    },
    async call(c) {
      engine.calls.push(c);
      return behave(c, engine);
    },
    session: () => engine.cookies ?? engine.startedWith,
    async close() {
      engine.closed = true;
    },
  };
  return engine;
}

/**
 * Runtime on a random port with fake engines.
 * @param {import('node:test').TestContext} t
 * @param {{ liteBehave?: any, browserBehave?: any, liteBoot?: (n: number, s: any) => any,
 *   browserIdleMs?: number, liteRetryMs?: number, liteMaxAgeMs?: number }} [o]
 */
async function start(t, { liteBehave, browserBehave, liteBoot, browserIdleMs, liteRetryMs, liteMaxAgeMs } = {}) {
  /** @type {{ lite: Fake[], browser: Fake[] }} */
  const made = { lite: [], browser: [] };
  let boots = 0;
  const runtime = createRuntime({
    log: quiet,
    loadLite: async () => ({
      LITE_TOOLS: new Set(['get_basic_info', 'write_html', 'open_file', 'list_resources']),
      async createLiteEngine({ session }) {
        await liteBoot?.(boots++, session);
        const e = fakeEngine('lite', session, liteBehave);
        made.lite.push(e);
        return e;
      },
    }),
    createBrowser: async ({ session }) => {
      const e = fakeEngine('browser', session, browserBehave);
      made.browser.push(e);
      return e;
    },
    browserIdleMs,
    liteRetryMs,
    liteMaxAgeMs,
  });
  await new Promise((r) => runtime.server.listen(0, () => r(null)));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (runtime.server.address()).port}`;
  /** @param {string} path @param {unknown} body @returns {Promise<{ status: number, body: any }>} */
  const post = async (path, body) => {
    const res = await fetch(url + path, { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  /** @param {string} tool @param {object} [args] */
  const call = (tool, args = {}, session = S1) => post('/call', { session, tool, args });
  const health = async () => (await (await fetch(url + '/healthz')).json()).engines;
  t.after(() => runtime.close());
  return { url, post, call, health, made };
}

test('routes lite tools to lite and the rest to the browser; no session in responses', async (t) => {
  const rt = await start(t);
  const a = await rt.call('get_basic_info');
  assert.equal(a.body.engine, 'lite');
  assert.equal('session' in a.body, false);
  const b = await rt.call('get_screenshot');
  assert.equal(b.body.engine, 'browser');
  assert.deepEqual(b.body.result, ok('browser'));
  assert.deepEqual(await rt.health(), { lite: 'ready', browser: 'running' });
});

test('/catalog passes clientInfo through to Paper', async (t) => {
  const rt = await start(t);
  const clientInfo = { name: 'claude-code', transport: 'http' };
  const c = await rt.post('/catalog', { session: S1, clientInfo });
  assert.deepEqual(c.body, { tools: TOOLS, instructions: 'lite' });
  assert.deepEqual(rt.made.lite[0].catalogClients, [clientInfo]);
});

test('unknown tools are a tool error, without starting Chromium', async (t) => {
  const rt = await start(t);
  const r = await rt.call('make_coffee');
  assert.deepEqual(r.body.result, { content: [{ type: 'text', text: 'Unknown tool: make_coffee' }], isError: true });
  assert.equal(rt.made.browser.length, 0);
});

test('a failure after a call reached lite is final: no browser retry; tool errors pass through', async (t) => {
  const rt = await start(t, {
    liteBehave: (/** @type {any} */ c) => {
      if (c.tool === 'write_html') throw fails('timeout');
      return { content: [{ type: 'text', text: 'bad node' }], isError: true };
    },
  });
  const a = await rt.call('write_html');
  assert.equal(a.status, 500);
  assert.equal(a.body.error.code, 'internal');
  assert.equal(rt.made.browser.length, 0);
  const b = await rt.call('get_basic_info');
  assert.equal(b.body.engine, 'lite');
  assert.equal(b.body.result.isError, true);
});

test('lite that cannot boot leaves the browser serving, and is retried after the backoff', async (t) => {
  const rt = await start(t, { liteRetryMs: 40, liteBoot: (n) => (n === 0 ? Promise.reject(fails('internal')) : null) });
  const a = await rt.call('get_basic_info');
  assert.equal(a.body.engine, 'browser');
  assert.equal((await rt.health()).lite, 'failed');
  assert.equal((await rt.post('/catalog', { session: S1 })).body.instructions, 'browser');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await rt.call('get_basic_info')).body.engine, 'lite');
});

test('stale lite (call never reached Paper) is replaced and the call runs on the new engine', async (t) => {
  const rt = await start(t, {
    liteBehave: (/** @type {any} */ c, /** @type {Fake} */ e) => {
      if (e === rt.made.lite[0] && c.tool === 'write_html') throw ((e.stale = true), fails('unavailable'));
      return ok('lite');
    },
  });
  await rt.call('get_basic_info');
  const r = await rt.call('write_html');
  assert.equal(r.body.engine, 'lite');
  assert.equal(rt.made.lite.length, 2);
  assert.equal(rt.made.lite[0].closed, true);
  assert.equal(rt.made.lite[1].calls[0].tool, 'write_html');
  assert.equal(rt.made.browser.length, 0);
});

test('stale lite whose replacement cannot boot falls back to the browser', async (t) => {
  const rt = await start(t, {
    liteBoot: (n) => (n > 0 ? Promise.reject(fails('internal')) : null),
    liteBehave: (/** @type {any} */ c) => (c.tool === 'write_html' ? Promise.reject(fails('unavailable')) : ok('lite')),
  });
  await rt.call('get_basic_info');
  assert.equal((await rt.call('write_html')).body.engine, 'browser');
});

test('a crashed lite reads cold and is recreated on the next call', async (t) => {
  const rt = await start(t);
  await rt.call('get_basic_info');
  rt.made.lite[0].stale = true; // what the engine sets when its child exits
  assert.equal((await rt.health()).lite, 'cold');
  assert.equal((await rt.call('get_basic_info')).body.engine, 'lite');
  assert.equal(rt.made.lite.length, 2);
});

test('a different session from the caller does not restart engines; the browser starts on lite cookies', async (t) => {
  const rt = await start(t);
  await rt.call('get_basic_info');
  const renewed = { cookies: [{ name: 'D7pPzj4phQRAjBC01', value: 'one-renewed', domain: '.paper.design' }] };
  rt.made.lite[0].cookies = renewed;
  await rt.call('get_basic_info', {}, S2);
  await rt.call('get_screenshot', {}, S2);
  assert.equal(rt.made.lite.length, 1);
  assert.deepEqual(rt.made.browser[0].startedWith, renewed);
});

test('signed out mid-life: engines reboot from the caller session and the call is retried once', async (t) => {
  const rt = await start(t, {
    liteBehave: (/** @type {any} */ c, /** @type {Fake} */ e) => {
      if (e === rt.made.lite[0] && c.tool === 'list_resources') throw fails('auth');
      return ok('lite');
    },
  });
  await rt.call('get_basic_info');
  const r = await rt.call('list_resources', {}, S2);
  assert.equal(r.status, 200);
  assert.equal(rt.made.lite[0].closed, true);
  assert.deepEqual(rt.made.lite[1].startedWith, S2);
});

test('auth that persists → 401; limit → 429; no browser fallback; missing session → 401', async (t) => {
  const rt = await start(t, {
    liteBehave: (/** @type {any} */ c) => {
      throw fails(c.tool === 'write_html' ? 'limit' : 'auth');
    },
  });
  const a = await rt.call('get_basic_info');
  assert.equal(a.status, 401);
  assert.equal(a.body.error.code, 'auth');
  assert.equal(rt.made.lite.length, 2);
  const b = await rt.call('write_html');
  assert.equal(b.status, 429);
  assert.equal(rt.made.browser.length, 0);
  assert.equal((await rt.post('/call', { tool: 'get_basic_info', args: {} })).status, 401);
  assert.equal((await rt.post('/call', { session: S1, args: {} })).status, 400);
});

test("Paper's weekly-limit result → 429 with Paper's text", async (t) => {
  const text = 'Weekly MCP limit reached. It resets tomorrow.';
  const rt = await start(t, { browserBehave: () => ({ content: [{ type: 'text', text }], isError: true }) });
  const r = await rt.call('export');
  assert.equal(r.status, 429);
  assert.deepEqual(r.body.error, { code: 'limit', message: text });
});

test('the current file carries across engines when a call omits fileId', async (t) => {
  const rt = await start(t);
  await rt.call('get_screenshot'); // nothing known yet: nothing injected
  assert.equal(rt.made.browser[0].calls[0].args.fileId, undefined);
  await rt.call('open_file', { fileId: FILE });
  await rt.call('export', { nodes: {} });
  assert.equal(rt.made.browser[0].calls[1].args.fileId, FILE);
  await rt.call('list_resources'); // no fileId in its schema
  assert.equal('fileId' in rt.made.lite[0].calls.at(-1).args, false);
});

test('closes the browser after it sits idle', async (t) => {
  const rt = await start(t, { browserIdleMs: 30 });
  await rt.call('export');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rt.made.browser[0].closed, true);
  assert.equal((await rt.health()).browser, 'stopped');
});

test('calls run one at a time', async (t) => {
  let running = 0;
  let max = 0;
  const rt = await start(t, {
    browserBehave: async () => {
      max = Math.max(max, ++running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return ok('done');
    },
  });
  await Promise.all([1, 2, 3, 4].map(() => rt.call('export')));
  assert.equal(max, 1);
  assert.equal(rt.made.browser.length, 1);
});

test('the lite engine is recycled after liteMaxAgeMs (day-long children abort mid-call)', async (t) => {
  const rt = await start(t, { liteMaxAgeMs: 60 });
  await rt.call('get_basic_info');
  assert.equal(rt.made.lite.length, 1);
  await new Promise((r) => setTimeout(r, 90));
  await rt.call('get_basic_info');
  assert.equal(rt.made.lite.length, 2, 'a fresh engine boots past the age cap');
  assert.equal(rt.made.lite[0].closed, true, 'and the old one is closed');
});

test('no sign-in endpoints: sign-in is Paper OAuth on the Worker, not the container', async (t) => {
  const rt = await start(t);
  for (const path of ['/signin/start', '/signin/continue']) {
    const res = await rt.post(path, {});
    assert.equal(res.status, 404, path);
    assert.equal(res.body.error.code, 'bad_request', path);
  }
});

test('rejects bodies over 4 MB and bad JSON', async (t) => {
  const rt = await start(t);
  const big = await fetch(rt.url + '/call', { method: 'POST', body: 'x'.repeat(4 * 1024 * 1024 + 1) });
  assert.equal(big.status, 413);
  const bad = await fetch(rt.url + '/call', { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
});
