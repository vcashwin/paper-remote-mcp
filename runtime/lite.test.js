// node --test runtime/lite.test.js
// Live part (spends weekly MCP quota: list_resources, update_pages):
//   PAPER_SESSION_FILE=/path/to/session.json (Playwright cookie array) node --test runtime/lite.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOOKS, LITE_TOOLS, createLiteEngine, toHappyCookie, toPlaywrightCookie } from './lite.js';
import { meterMock, paperCookies, parseFileId } from './paper.js';

const SCRATCH = 'paper-remote-mcp scratch (ASH-259)';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

test('parseFileId accepts ids, routes and URLs', () => {
  const id = '01KQ3Z0ZJ9W4P8V6X2N7T5R3MB';
  assert.equal(parseFileId(id), id);
  assert.equal(parseFileId(`https://app.paper.design/file/${id}?page=1`), id);
  assert.equal(parseFileId(`/file/${id}`), id);
  assert.equal(parseFileId('nope'), null);
  assert.equal(parseFileId(undefined), null);
});

test('paperCookies keeps the app session, drops AuthKit and analytics cookies', () => {
  const keep = [
    { name: 'D7pPzj4phQRAjBC01', domain: '.paper.design' },
    { name: '__Host-b', domain: 'api.paper.design' },
  ];
  const drop = [
    { name: 'wos-session', domain: 'login.paper.design' },
    { name: 'ph_phc_x_posthog', domain: '.paper.design' },
    { name: 'x', domain: '.example.com' },
  ];
  assert.deepEqual(paperCookies([...keep, ...drop]), keep);
});

test('cookies round-trip between Playwright and happy-dom shapes', () => {
  const cookies = [
    {
      name: 'a',
      value: '1',
      domain: '.paper.design',
      path: '/',
      expires: 1893456000,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    {
      name: '__Host-b',
      value: '2',
      domain: 'api.paper.design',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    },
  ];
  for (const c of cookies) assert.deepEqual(toPlaywrightCookie(toHappyCookie(c)), c);
  assert.equal(toHappyCookie(cookies[1]).domain, '', 'host-only cookie stays host-only');
});

test("Paper's modules may import only Paper's modules", async () => {
  const { resolve, load } = await import('data:text/javascript,' + encodeURIComponent(HOOKS));
  const paper = { parentURL: 'https://app.paper.design/assets/main.js' };
  const ours = { parentURL: 'file:///app/lite.js' };
  const next = (/** @type {string} */ s) => ({ url: `next:${s}` });
  assert.equal((await resolve('./x.js', paper, next)).url, 'https://app.paper.design/assets/x.js');
  assert.equal((await resolve('node:fs', ours, next)).url, 'next:node:fs');
  for (const s of ['node:fs', 'fs', 'happy-dom', 'data:text/javascript,1']) {
    await assert.rejects(resolve(s, paper, next), /refusing import/, s);
  }
  await assert.rejects(load('https://evil.example/x.js', {}, next), /refusing to load/);
});

test('meterMock serves a synthetic /meter/balance and passes other requests through', async () => {
  const g = /** @type {any} */ (globalThis);
  const realFetch = g.fetch;
  const w = /** @type {any} */ ({ fetch: async () => new Response('real', { status: 202 }) });
  const saved = { window: g.window, XMLHttpRequest: g.XMLHttpRequest };
  g.window = w;
  g.XMLHttpRequest = class {};
  try {
    meterMock();
    const body = await (await w.fetch('https://workers.paper.design/meter/balance')).json();
    assert.equal(body.manaUsed, 0);
    assert.equal(body.manaCap, 20);
    assert.equal(body.mcpUsed, 1);
    assert.equal(body.mcpCap, 10000);
    assert.ok(body.serverClock > Date.now(), 'serverClock runs ahead of the client clock');
    assert.equal((await w.fetch('https://api.paper.design/auth/me')).status, 202, 'other URLs pass through');
    // globalThis.fetch is wrapped too (the registrator snapshot case), without double-wrapping window.fetch.
    const body2 = await (await g.fetch('https://workers.paper.design/meter/balance')).json();
    assert.equal(body2.mcpCap, 10000);
    w.__apiMocker.reset();
    assert.equal(g.fetch, realFetch, 'reset restores globalThis.fetch');
  } finally {
    g.fetch = realFetch;
    if (saved.window === undefined) delete g.window;
    else g.window = saved.window;
    if (saved.XMLHttpRequest === undefined) delete g.XMLHttpRequest;
    else g.XMLHttpRequest = saved.XMLHttpRequest;
  }
});

test('layout/raster tools are never routed to the lite engine', () => {
  for (const t of ['get_screenshot', 'export', 'export_combined_pdf', 'get_computed_styles']) {
    assert.ok(!LITE_TOOLS.has(t), t);
  }
});

const sessionFile = process.env.PAPER_SESSION_FILE;
test(
  'live: boot, catalog, get_basic_info and a write on the scratch file',
  { skip: !sessionFile, timeout: 180_000 },
  async (t) => {
    const raw = JSON.parse(readFileSync(/** @type {string} */ (sessionFile), 'utf8'));
    const engine = await createLiteEngine({ session: { cookies: Array.isArray(raw) ? raw : raw.cookies }, log: quiet });
    const clientInfo = { name: 'lite.test', transport: 'http' };
    /**
     * Paper's payload: the last JSON text block (file tools prepend a file header block).
     * @param {string} tool @param {Record<string, unknown>} args
     */
    const call = async (tool, args) => {
      const r = await engine.call({ tool, args, agentId: 'lite-test', clientInfo });
      const text = r.content.map((/** @type {any} */ c) => c.text ?? '').join('\n');
      if (/Weekly MCP limit reached/.test(text)) return null;
      assert.ok(!r.isError, `${tool}: ${text}`);
      const v = JSON.parse(r.content.at(-1).text);
      return v.data ?? v;
    };
    try {
      const { tools, instructions } = await engine.catalog(clientInfo);
      assert.ok(tools.length > 30 && typeof instructions === 'string');
      for (const name of LITE_TOOLS)
        assert.ok(
          tools.some((x) => x.name === name),
          `catalog has ${name}`,
        );
      assert.ok(engine.session().cookies.length > 0);

      const list = await call('list_resources', { limit: 200 });
      if (!list) return t.skip('weekly MCP limit reached (metered tools unavailable until Saturday 00:00 UTC)');
      const fileId =
        list.resources.find((/** @type {any} */ r) => r.name === SCRATCH && r.type !== 'folder')?.id ??
        (await call('create_file', { name: SCRATCH })).fileId;
      assert.ok(fileId, 'scratch file id');

      const info = await call('get_basic_info', { fileId });
      assert.equal(info.fileName, SCRATCH);
      const name = `lite ${Date.now()}`;
      assert.ok(await call('update_pages', { fileId, updates: [{ pageId: info.pageId, name }] }));
      const after = await call('get_basic_info', { fileId });
      assert.equal(after.pages.find((/** @type {any} */ p) => p.id === info.pageId)?.name, name);
    } finally {
      await engine.close();
    }
  },
);
