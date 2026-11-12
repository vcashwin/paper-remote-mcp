import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './server.js';

const S1 = { cookies: [{ name: 'D7pPzj4phQRAjBC01', value: 'one', domain: '.paper.design' }] };
const S2 = { cookies: [{ name: 'D7pPzj4phQRAjBC01', value: 'two', domain: '.paper.design' }] };
const ok = (text) => ({ content: [{ type: 'text', text }] });

/** A fake engine; `behave(call)` decides what a call does. */
function fakeEngine(name, behave = () => ok(name)) {
  const engine = {
    name,
    closed: false,
    calls: [],
    cookies: null,
    async catalog() {
      return { tools: [{ name: `${name}-tool` }], instructions: name };
    },
    async call(c) {
      engine.calls.push(c.tool);
      return behave(c);
    },
    async session() {
      return engine.cookies ?? engine.startedWith;
    },
    async close() {
      engine.closed = true;
    },
  };
  return engine;
}

/** Runtime on a random port with fake engines. */
async function start(t, { liteBehave, browserBehave, liteBoot, signIn, browserIdleMs } = {}) {
  const made = { lite: [], browser: [] };
  const runtime = createRuntime({
    log: () => {},
    loadLite: async () => ({
      LITE_TOOLS: new Set(['get_basic_info', 'write_html']),
      async createLiteEngine({ session }) {
        if (liteBoot) await liteBoot();
        const e = Object.assign(fakeEngine('lite', liteBehave), { startedWith: session });
        made.lite.push(e);
        return e;
      },
    }),
    createBrowser: async ({ session }) => {
      const e = Object.assign(fakeEngine('browser', browserBehave), { startedWith: session });
      made.browser.push(e);
      return e;
    },
    signIn,
    browserIdleMs,
  });
  await new Promise((r) => runtime.server.listen(0, r));
  const url = `http://127.0.0.1:${runtime.server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(url + path, { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  t.after(() => runtime.close());
  return { url, post, made };
}

test('routes lite tools to lite and the rest to the browser', async (t) => {
  const rt = await start(t);
  const a = await rt.post('/call', { session: S1, tool: 'get_basic_info', args: {} });
  assert.equal(a.body.engine, 'lite');
  assert.equal(a.body.session, undefined);
  const b = await rt.post('/call', { session: S1, tool: 'get_screenshot', args: {} });
  assert.equal(b.body.engine, 'browser');
  assert.deepEqual(b.body.result, ok('browser'));
  const h = await (await fetch(rt.url + '/healthz')).json();
  assert.deepEqual(h, { ok: true, engines: { lite: 'ready', browser: 'running' } });
});

test('falls back to the browser when lite fails, but not on tool errors', async (t) => {
  const rt = await start(t, {
    liteBehave: (c) => {
      if (c.tool === 'write_html') throw Object.assign(new Error('no layout'), { code: 'unsupported' });
      return { content: [{ type: 'text', text: 'bad node' }], isError: true };
    },
  });
  const a = await rt.post('/call', { session: S1, tool: 'write_html', args: {} });
  assert.equal(a.body.engine, 'browser');
  const b = await rt.post('/call', { session: S1, tool: 'get_basic_info', args: {} });
  assert.equal(b.body.engine, 'lite');
  assert.equal(b.body.result.isError, true);
});

test('lite that cannot boot leaves the browser serving everything', async (t) => {
  const rt = await start(t, { liteBoot: () => Promise.reject(Object.assign(new Error('x'), { code: 'unavailable' })) });
  const a = await rt.post('/call', { session: S1, tool: 'get_basic_info', args: {} });
  assert.equal(a.body.engine, 'browser');
  assert.equal((await (await fetch(rt.url + '/healthz')).json()).engines.lite, 'failed');
  const c = await rt.post('/catalog', { session: S1 });
  assert.equal(c.body.instructions, 'browser');
});

test('auth → 401 and limit → 429, without fallback', async (t) => {
  const rt = await start(t, {
    liteBehave: (c) => {
      throw Object.assign(new Error('nope'), { code: c.tool === 'write_html' ? 'limit' : 'auth' });
    },
  });
  const a = await rt.post('/call', { session: S1, tool: 'get_basic_info', args: {} });
  assert.equal(a.status, 401);
  assert.equal(a.body.error.code, 'auth');
  const b = await rt.post('/call', { session: S1, tool: 'write_html', args: {} });
  assert.equal(b.status, 429);
  assert.equal(rt.made.browser.length, 0);
  const c = await rt.post('/call', { tool: 'get_basic_info', args: {} });
  assert.equal(c.status, 401);
  const d = await rt.post('/call', { session: S1, args: {} });
  assert.equal(d.status, 400);
});

test("Paper's weekly-limit result → 429 with Paper's text", async (t) => {
  const text = 'Weekly MCP limit reached. It resets tomorrow.';
  const rt = await start(t, { browserBehave: () => ({ content: [{ type: 'text', text }], isError: true }) });
  const r = await rt.post('/call', { session: S1, tool: 'export', args: {} });
  assert.equal(r.status, 429);
  assert.deepEqual(r.body.error, { code: 'limit', message: text });
});

test('analytics cookie churn is not a session change', async (t) => {
  const rt = await start(t);
  await rt.post('/call', { session: S1, tool: 'get_basic_info', args: {} });
  rt.made.lite[0].cookies = { cookies: [...S1.cookies, { name: '__cf_bm', value: 'x', domain: '.paper.design' }] };
  const r = await rt.post('/call', { session: S1, tool: 'get_basic_info', args: {} });
  assert.equal(r.body.session, undefined);
});

test('closes the browser after it sits idle', async (t) => {
  const rt = await start(t, { browserIdleMs: 30 });
  await rt.post('/call', { session: S1, tool: 'export', args: {} });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rt.made.browser[0].closed, true);
  assert.equal((await (await fetch(rt.url + '/healthz')).json()).engines.browser, 'stopped');
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
  await Promise.all([1, 2, 3, 4].map(() => rt.post('/call', { session: S1, tool: 'export', args: {} })));
  assert.equal(max, 1);
  assert.equal(rt.made.browser.length, 1);
});

test('reports renewed cookies, keeps engines across the renewal, restarts on a different session', async (t) => {
  const rt = await start(t);
  await rt.post('/call', { session: S1, tool: 'get_basic_info', args: {} });
  const renewed = { cookies: [{ name: 'D7pPzj4phQRAjBC01', value: 'one-renewed', domain: '.paper.design' }] };
  rt.made.lite[0].cookies = renewed;
  const a = await rt.post('/call', { session: S1, tool: 'get_basic_info', args: {} });
  assert.deepEqual(a.body.session, renewed);
  const b = await rt.post('/call', { session: renewed, tool: 'get_basic_info', args: {} });
  assert.equal(b.body.session, undefined);
  assert.equal(rt.made.lite.length, 1);
  await rt.post('/call', { session: S2, tool: 'get_basic_info', args: {} });
  assert.equal(rt.made.lite.length, 2);
  assert.equal(rt.made.lite[0].closed, true);
});

test('sign-in endpoints drive one step machine', async (t) => {
  const seen = [];
  const rt = await start(t, {
    signIn: () => ({
      async start(email) {
        seen.push(['start', email]);
        return { step: 'password' };
      },
      async continue(value) {
        seen.push(['continue', value]);
        return value === 'right'
          ? { step: 'done', session: S1, user: { id: 'user_1', email: 'a@b.c' } }
          : { step: 'password', message: 'Incorrect password' };
      },
      async close() {},
    }),
  });
  assert.equal((await rt.post('/signin/continue', { value: 'x' })).status, 400);
  assert.equal((await rt.post('/signin/start', {})).status, 400);
  assert.deepEqual((await rt.post('/signin/start', { email: 'a@b.c' })).body, { step: 'password' });
  assert.deepEqual((await rt.post('/signin/continue', { value: 'wrong' })).body, { step: 'password', message: 'Incorrect password' });
  const done = await rt.post('/signin/continue', { value: 'right' });
  assert.equal(done.body.step, 'done');
  assert.equal(done.body.user.id, 'user_1');
  assert.equal((await rt.post('/signin/continue', { value: 'again' })).status, 400);
});

test('rejects bodies over 4 MB and bad JSON', async (t) => {
  const rt = await start(t);
  const big = await fetch(rt.url + '/call', { method: 'POST', body: 'x'.repeat(4 * 1024 * 1024 + 1) });
  assert.equal(big.status, 413);
  const bad = await fetch(rt.url + '/call', { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
});
