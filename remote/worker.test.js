// The whole OAuth + sign-in + MCP flow against faked containers: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';

// The Durable Object base class only exists on Workers: a stand-in whose containerFetch the tests replace.
const STUB =
  'export class Container { constructor(ctx, env) { this.ctx = ctx; this.env = env; } async stop() { this.stopped = true; } }';
const HOOKS = `export async function resolve(specifier, context, next) {
  return specifier === '@cloudflare/containers'
    ? { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true }
    : next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);
const { default: worker, open, seal, renewCookies, PaperAccount } = await import('./worker.js');

const ORIGIN = 'https://paper-mcp.example';
const REGISTERED = 'http://127.0.0.1:33418/callback';
const REDIRECT = 'http://127.0.0.1:50000/callback'; // the same loopback URI, another port (RFC 8252)
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

// A realistic Paper session (~3 KB of cookie data): Paper's sealed session cookie (~2.4 KB, random-looking name) and
// two small ones, plus a cookie from another site that must never cross.
const cookie = (/** @type {string} */ name, /** @type {string} */ value, domain = '.paper.design') => ({
  name,
  value,
  domain,
  path: '/',
  expires: 1_800_000_000,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
});
const SESSION = {
  cookies: [
    cookie(randomBytes(8).toString('hex'), randomBytes(1800).toString('base64url')),
    cookie('__cf_bm', randomBytes(300).toString('base64url')),
    cookie('device', randomBytes(16).toString('hex'), 'app.paper.design'),
    cookie('tracker', 'x', '.notpaper.design'),
  ],
};

// --- fake containers -----------------------------------------------------------------------------------------------

/** Every request a container got: [kind, name, path, body] */
const seen = /** @type {[string, string, string, any][]} */ ([]);
/** The last request a `kind` container got (at `path`) @param {string} kind @param {string} [path] */
const last = (kind, path) => seen.filter((r) => r[0] === kind && (!path || r[2] === path)).at(-1) ?? ['', '', '', {}];
const LIMIT = 'Weekly MCP limit reached. It resets tomorrow.';
let running = 0,
  maxRunning = 0;

/** The account container: tool names choose the outcome */
async function accountContainer(/** @type {string} */ _user, /** @type {string} */ path, /** @type {any} */ body) {
  if (body.session.cookies[0]?.value === 'expired')
    return Response.json({ error: { code: 'auth', message: 'Signed out' } }, { status: 401 });
  if (path === '/catalog') {
    if (_user.includes('broken')) return new Response('oops', { status: 500 });
    return Response.json({
      tools: [{ name: 'get_basic_info', inputSchema: { type: 'object' } }],
      instructions: 'Paper says hi',
    });
  }
  running++;
  maxRunning = Math.max(maxRunning, running);
  await new Promise((r) => setTimeout(r, 5));
  running--;
  if (body.tool === 'limited') return Response.json({ error: { code: 'limit', message: LIMIT } }, { status: 429 });
  if (body.tool === 'limited-result') {
    return Response.json({ result: { content: [{ type: 'text', text: LIMIT }], isError: true }, engine: 'lite' });
  }
  if (body.tool === 'crash') return new Response('', { status: 500 });
  return Response.json({ result: { content: [{ type: 'text', text: `ran ${body.tool}` }] }, engine: 'lite' });
}

/** A Durable Object namespace of real DO classes whose containers are the fakes above */
function namespace(/** @type {any} */ Class, /** @type {string} */ kind, /** @type {Function} */ container) {
  const objects = new Map();
  return {
    objects,
    getByName(/** @type {string} */ name) {
      if (!objects.has(name)) {
        const object = new Class({}, {});
        object.containerFetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
          const path = new URL(url).pathname;
          const body = JSON.parse(String(init.body));
          seen.push([kind, name, path, body]);
          return container(name, path, body);
        };
        objects.set(name, object);
      }
      return objects.get(name);
    },
  };
}

const env = {
  SEAL_KEY: randomBytes(32).toString('base64'),
  PAPER_ACCOUNT: namespace(PaperAccount, 'account', accountContainer),
};
/** What the Worker left running after its response (ctx.waitUntil) */
const background = /** @type {Promise<unknown>[]} */ ([]);
const ctx = { waitUntil: (/** @type {Promise<unknown>} */ p) => background.push(p) };

// --- Paper's API and client metadata documents, faked: the Worker's own fetch -------------------------------------

/** How /auth/me answers: a status, or 'down' (no answer); the Set-Cookie renewals it sends with a 200 */
const paper = { me: /** @type {number | 'down'} */ (200), renewals: /** @type {string[]} */ ([]), asked: 0 };
/** Client ID metadata documents, by URL */
const documents = new Map();
/**
 * Paper's own OAuth bridge: what /auth/desktop-callback answers per pasted code. 'good-code' signs in as the
 * example user, 'broken-code' as one whose container fails; 'used-code' is refused; 'down-code' never answers.
 */
globalThis.fetch = async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit} */ init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (documents.has(url)) return Response.json(documents.get(url));
  if (url === 'https://api.paper.design/auth/desktop-callback') {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (typeof body.codeVerifier !== 'string' || !body.codeVerifier) throw new Error('no PKCE verifier sent');
    if (body.code === 'down-code') throw new TypeError('fetch failed');
    if (body.code === 'used-code') return Response.json({ success: false, errorMessage: 'Code expired or used' });
    return Response.json({
      success: true,
      sealedSession: body.code === 'broken-code' ? 'mark-broken' : SESSION.cookies[0].value,
      cosmeticInfo: { firstName: 'Test', lastName: 'User' },
    });
  }
  assert.equal(url, 'https://api.paper.design/auth/me', 'no other fetch');
  paper.asked++;
  if (paper.me === 'down') throw new TypeError('fetch failed');
  const sent = new Headers(init?.headers).get('cookie') ?? '';
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of paper.renewals) headers.append('set-cookie', c);
  // the user id is the session cookie's value's owner: whatever the token says, unless it's a stolen one
  const id = sent.includes('mark-broken')
    ? 'user-broken@example.com'
    : sent.includes('other-user')
      ? 'someone-else'
      : 'user-me@example.com';
  return new Response(paper.me === 200 ? JSON.stringify({ user: { id } }) : '{}', { status: paper.me, headers });
};

// --- helpers -------------------------------------------------------------------------------------------------------

/** @param {string} path @param {RequestInit} [init] */
const call = (path, init) => worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }), env, ctx);
/** The `name=value` of the cookie a response set whose name starts with `prefix` @param {Response} res @param {string} prefix */
const cookieSet = (res, prefix) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(prefix))
    ?.split(';')[0] ?? '';
/** @param {Record<string, string>} fields @param {string} [cookie] */
const form = (fields, cookie = '') => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  body: new URLSearchParams(fields),
});
/** @param {Response} res */
const location = (res) => new URL(res.headers.get('location') ?? '');
/** @param {string} html @param {string} name */
const field = (html, name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';

/** Register, then open the consent page: what the form holds and the CSRF cookie set. */
async function consentPage() {
  const reg = await call('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REGISTERED], client_name: 'Test <Client>' }),
  });
  assert.equal(reg.status, 201);
  const { client_id, token_endpoint_auth_method } = await reg.json();
  assert.equal(token_endpoint_auth_method, 'none');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${ORIGIN}/mcp`,
  });
  const page = await call(`/authorize?${q}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const html = await page.text();
  assert.match(html, /Test &#60;Client&#62;/, 'client name is escaped');
  return {
    client_id,
    state: field(html, 'state'),
    csrfToken: field(html, 'csrf_token'),
    csrf: cookieSet(page, '__Host-CSRF-'),
  };
}

/** Consent → the sign-in page: the sealed flow, Paper's sign-in URL and the browser's SIGNIN cookie. */
async function startSignIn() {
  const { client_id, state, csrfToken, csrf } = await consentPage();
  const res = await call('/authorize', form({ state, csrf_token: csrfToken, action: 'approve' }, csrf));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Sign in with Paper/);
  const paperUrl = /href="([^"]+)" target="_blank"/.exec(html)?.[1] ?? '';
  assert.ok(
    paperUrl.startsWith('https://api.workos.com/user_management/authorize?'),
    'the link is Paper’s own hosted OAuth',
  );
  assert.ok(paperUrl.includes('code_challenge='), 'PKCE to Paper');
  assert.match(html, /name="link"/, 'the paste box');
  assert.match(cookieSet(res, '__Host-CSRF-'), /=$/, 'the CSRF cookie is cleared');
  return { client_id, flow: field(html, 'flow'), cookie: cookieSet(res, '__Host-SIGNIN-'), paperUrl };
}

/** One sign-in page's answer @param {{ flow: string, cookie: string }} s @param {Record<string, string>} fields */
const answer = (s, fields) => call('/signin', form({ flow: s.flow, ...fields }, s.cookie));

/** The whole sign-in: paste the paper:// link Paper showed → the client's code. */
async function signIn() {
  const s = await startSignIn();
  const back = await answer(s, { link: 'paper://auth/callback?code=good-code' });
  assert.equal(back.status, 302);
  const to = location(back);
  assert.equal(`${to.origin}${to.pathname}`, REDIRECT);
  assert.equal(to.searchParams.get('state'), 'client-state');
  assert.equal(to.searchParams.get('iss'), ORIGIN);
  assert.match(cookieSet(back, '__Host-SIGNIN-'), /=$/, 'the sign-in cookie is cleared');
  return { client_id: s.client_id, code: to.searchParams.get('code') ?? '', back, s };
}

/** @param {string} client_id @param {string} code @param {Record<string, string>} [extra] */
const redeem = (client_id, code, extra = {}) =>
  call('/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier, ...extra }));

/** Signed in and redeemed: the client's tokens @param {string} [pasteCode] */
async function connect(pasteCode = 'good-code') {
  const s = await startSignIn();
  const back = await answer(s, { link: `paper://auth/callback?code=${pasteCode}` });
  assert.equal(back.status, 302);
  const code = location(back).searchParams.get('code') ?? '';
  const res = await redeem(s.client_id, code);
  assert.equal(res.status, 200);
  return { client_id: s.client_id, ...(await res.json()) };
}

/** One JSON-RPC message to /mcp @param {string} token @param {object} msg @param {Record<string, string>} [headers] */
const rpc = (token, msg, headers = {}) =>
  call('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...msg }),
  });
/** @param {string} token @param {string} name @param {object} [args] */
const tool = async (token, name, args = {}) =>
  (await rpc(token, { id: 9, method: 'tools/call', params: { name, arguments: args } })).json();

// --- tests ---------------------------------------------------------------------------------------------------------

test('metadata and the 401 challenge point clients at this server', async () => {
  const prm = await (await call('/.well-known/oauth-protected-resource/mcp')).json();
  assert.deepEqual(prm.authorization_servers, [ORIGIN]);
  assert.equal(prm.resource, `${ORIGIN}/mcp`);
  const as = await (await call('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.token_endpoint, `${ORIGIN}/token`);
  const res = await call('/mcp', { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  const challengeHeader = res.headers.get('www-authenticate') ?? '';
  assert.ok(challengeHeader.includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`));
  assert.equal((await call('/oauth/client.json')).status, 404, 'no upstream OAuth client any more');
});

test('register → consent → sign in with Paper (OAuth paste) → code → token → MCP', async (t) => {
  const { client_id, code } = await signIn();
  const s = { client_id };
  assert.ok(!code.includes(SESSION.cookies[0].name), 'the session only travels sealed');

  const bad = await redeem(s.client_id, code, { code_verifier: 'x'.repeat(43) });
  assert.equal((await bad.json()).error, 'invalid_grant', 'wrong PKCE verifier');
  assert.equal((await (await redeem('someone-else', code)).json()).error, 'invalid_grant', 'another client');
  const evil = await redeem(s.client_id, code, { resource: 'https://evil.example/' });
  assert.equal((await evil.json()).error, 'invalid_target', 'a resource not served here');
  assert.equal(
    (await (await redeem(s.client_id, code, { redirect_uri: 'http://127.0.0.1:1/x' })).json()).error,
    'invalid_grant',
  );

  const tok = await (await redeem(s.client_id, code, { redirect_uri: REDIRECT })).json();
  assert.equal(tok.token_type, 'Bearer');
  assert.equal(tok.expires_in, 3_600);
  assert.equal(tok.resource, `${ORIGIN}/mcp`);
  t.diagnostic(
    `sizes (bytes): code ${code.length}, access ${tok.access_token.length}, refresh ${tok.refresh_token.length}`,
  );
  assert.ok(tok.access_token.length < 6000 && tok.refresh_token.length < 6000, 'tokens stay well under 8 KB');
  const access = await open(env, 'access', tok.access_token);
  assert.equal(access?.u, 'user-me@example.com');
  assert.deepEqual(
    access?.s.map((/** @type {any} */ c) => [c.name, c.value, c.domain, c.httpOnly]),
    [
      ['D7pPzj4phQRAjBC01', SESSION.cookies[0].value, '.paper.design', true],
      [
        'paper-preauth-user-info',
        encodeURIComponent('{"firstName":"Test","lastName":"User"}'),
        '.paper.design',
        false,
      ],
    ],
    'the OAuth-minted session cookies: the sealed session raw, and the preauth cookie',
  );
  const refreshToken = await open(env, 'refresh', tok.refresh_token);
  assert.ok(Math.abs(access.exp - Date.now() / 1000 - 3_600) < 5, 'access tokens live an hour');
  assert.ok(Math.abs(refreshToken.exp - Date.now() / 1000 - 30 * 86_400) < 5, 'refresh tokens 30 days');

  const init = await rpc(tok.access_token, {
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } },
  });
  assert.equal(init.status, 200);
  const sessionId = init.headers.get('mcp-session-id') ?? '';
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\./, 'a random UUID');
  const { result } = await init.json();
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.equal(result.serverInfo.name, 'paper-remote-mcp');
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.instructions, 'Paper says hi');
  assert.equal((await rpc(tok.access_token, { method: 'notifications/initialized' })).status, 202);
  assert.deepEqual((await (await rpc(tok.access_token, { id: 2, method: 'ping' })).json()).result, {});
  const list = await (
    await rpc(tok.access_token, { id: 3, method: 'tools/list' }, { 'mcp-session-id': sessionId })
  ).json();
  assert.equal(list.result.tools[0].name, 'get_basic_info');

  const ran = await (
    await rpc(
      tok.access_token,
      { id: 4, method: 'tools/call', params: { name: 'get_basic_info', arguments: { a: 1 } } },
      { 'mcp-session-id': sessionId },
    )
  ).json();
  assert.deepEqual(ran, { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'ran get_basic_info' }] } });
  const sent = last('account', '/call')[3];
  assert.equal(sent.tool, 'get_basic_info');
  assert.deepEqual(sent.args, { a: 1 });
  assert.deepEqual(sent.clientInfo, { name: 'claude-code', transport: 'remote' });
  assert.equal(sent.agentId, access?.g);
  assert.equal(sent.session.cookies.length, 2);
  assert.deepEqual(last('account', '/catalog')[3].clientInfo, { name: 'claude-code', transport: 'remote' });
  assert.equal((await rpc(tok.access_token, { id: 5, method: 'nope' }).then((r) => r.json())).error.code, -32601);
  assert.equal(
    (await call('/mcp', { method: 'GET', headers: { authorization: `Bearer ${tok.access_token}` } })).status,
    405,
  );

  // a refresh is the client's own
  assert.equal(
    (
      await (
        await call('/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: 'c2' }))
      ).json()
    ).error,
    'invalid_grant',
  );
});

test('sign-in: the paste accepts a bare code; garbage, refused and dead Paper all say so on the page', async () => {
  const bare = await startSignIn();
  const ok = await answer(bare, { link: '01M78TD6ZQKGWGF625KW1XMT8E' });
  assert.equal(ok.status, 302, 'a bare code pastes too');

  const s = await startSignIn();
  const garbage = await (await answer(s, { link: 'https://example.com/nope' })).text();
  assert.match(garbage, /does not look like Paper’s page address/);
  assert.match(garbage, /name="link"/, 'the paste box again');
  const used = await (await answer(s, { link: 'paper://auth/callback?code=used-code' })).text();
  assert.match(used, /Paper refused that link/);
  assert.match(used, /api\.workos\.com\/user_management\/authorize/, 'Paper’s sign-in is offered again');
  const down = await (await answer(s, { link: 'paper://auth/callback?code=down-code' })).text();
  assert.match(down, /Paper is temporarily unavailable/);
  assert.doesNotMatch(down, /fetch failed/, 'internal errors stay internal');
  const noCookie = await call('/signin', form({ flow: s.flow, link: 'paper://auth/callback?code=good-code' }));
  assert.equal(noCookie.status, 400, 'the flow is bound to the browser that consented');
  const forged = await call(
    '/signin',
    form({ flow: 'forged', link: 'paper://auth/callback?code=good-code' }, s.cookie),
  );
  assert.equal(forged.status, 400);
  // the flow still completes after those errors
  const back = await answer(s, { link: 'paper://auth/callback?code=good-code' });
  assert.equal(back.status, 302);
  assert.ok(location(back).searchParams.get('code'));
});

test("refresh asks Paper: signed in → new tokens with Paper's renewals; signed out → sign in again", async () => {
  const tok = await connect();
  // the fake /auth/me knows this user as user-me@example.com
  const grant = await open(env, 'refresh', tok.refresh_token);
  const mine = await seal(env, 'refresh', { ...grant, u: 'user-me@example.com' }, 60);
  const refresh = (/** @type {string} */ refresh_token = mine) =>
    call('/token', form({ grant_type: 'refresh_token', refresh_token, client_id: tok.client_id }));
  const sessionName = SESSION.cookies[0].name;

  paper.me = 200;
  paper.renewals = [
    `${sessionName}=renewed; Path=/; HttpOnly; Secure; SameSite=lax; Domain=.paper.design; Max-Age=2937600`,
    'ph_phc_x=analytics; Path=/; Domain=.paper.design; Max-Age=100',
    'fresh=1; Path=/; Secure; HttpOnly',
  ];
  const asked = paper.asked;
  const same = await refresh();
  assert.equal(same.status, 200);
  assert.equal(paper.asked, asked + 1, 'Paper is asked on every refresh');
  const body = await same.json();
  const cookies = (await open(env, 'access', body.access_token))?.s;
  const session = cookies.find((/** @type {any} */ c) => c.name === sessionName);
  assert.equal(session.value, 'renewed', "Paper's renewal replaces the session cookie");
  assert.equal(session.sameSite, 'Lax');
  assert.ok(Math.abs(session.expires - Date.now() / 1000 - 2_937_600) < 5);
  assert.equal(cookies.filter((/** @type {any} */ c) => c.name === sessionName).length, 1, 'not duplicated');
  assert.ok(!cookies.some((/** @type {any} */ c) => c.name.startsWith('ph_')), 'analytics cookies stay out');
  assert.deepEqual(
    cookies.find((/** @type {any} */ c) => c.name === 'fresh'),
    {
      name: 'fresh',
      value: '1',
      domain: 'api.paper.design',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    'a host-only cookie belongs to api.paper.design',
  );
  assert.equal((await open(env, 'refresh', body.refresh_token))?.s.length, cookies.length, 'both tokens get them');
  assert.equal((await open(env, 'access', body.access_token))?.g, grant?.g, 'the grant (agent id) is kept');
  assert.deepEqual(
    renewCookies(cookies, [`${sessionName}=; Domain=.paper.design; Path=/; Max-Age=0`], 'api.paper.design').map(
      (/** @type {any} */ c) => c.name,
    ),
    ['D7pPzj4phQRAjBC01', 'paper-preauth-user-info', 'fresh'],
    'a cookie Paper deletes goes',
  );

  paper.renewals = [];
  paper.me = 401;
  const out = await refresh();
  assert.equal(out.status, 400);
  assert.equal((await out.json()).error, 'invalid_grant', 'signed out in Paper: sign in again');
  for (const down of [/** @type {const} */ ('down'), 503]) {
    paper.me = down;
    const res = await refresh();
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'temporarily_unavailable', 'Paper unreachable: try again later');
  }
  paper.me = 200;
  assert.equal((await refresh()).status, 200, 'and the same refresh token still works after');
  const stolen = await seal(env, 'refresh', { ...grant, u: 'user-me@example.com', s: [cookie('s', 'other-user')] }, 60);
  assert.equal((await (await refresh(stolen)).json()).error, 'invalid_grant', "another user's session");
  const expired = await seal(env, 'refresh', { ...grant, u: 'user-me@example.com', exp: 1 });
  assert.equal((await (await refresh(expired)).json()).error, 'invalid_grant', 'an expired refresh token');
});

test("the container's 401 is the client's 401; a limit or a crash is a tool error; calls run one at a time", async () => {
  const expired = await seal(
    env,
    'access',
    { s: [cookie('s', 'expired')], u: 'user-expired', r: `${ORIGIN}/mcp`, g: 'g' },
    300,
  );
  const res = await rpc(expired, { id: 1, method: 'tools/call', params: { name: 'get_basic_info' } });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
  assert.equal((await rpc(expired, { id: 1, method: 'tools/list' })).status, 401);

  const tok = await connect();
  // Paper's weekly limit, as the container's 429 or as Paper's own tool result: a tool error with Paper's words
  for (const name of ['limited', 'limited-result']) {
    const res = await rpc(tok.access_token, { id: 8, method: 'tools/call', params: { name } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, undefined, 'not a JSON-RPC error');
    assert.deepEqual(body.result, { content: [{ type: 'text', text: LIMIT }], isError: true });
  }
  assert.deepEqual((await tool(tok.access_token, 'crash')).result, {
    content: [{ type: 'text', text: 'Paper is temporarily unavailable' }],
    isError: true,
  });
  maxRunning = 0;
  await Promise.all([1, 2, 3].map(() => tool(tok.access_token, 'get_basic_info')));
  assert.equal(maxRunning, 1, "one account's calls are serialised");

  const broken = await connect('broken-code');
  const list = await (await rpc(broken.access_token, { id: 7, method: 'tools/list' })).json();
  assert.equal(list.error.message, 'Paper is temporarily unavailable');
});

test("token purposes don't cross; a token for another resource is refused", async () => {
  const tok = await connect();
  const { code } = await signIn();
  for (const bearer of [tok.refresh_token, code]) {
    assert.equal((await rpc(bearer, { id: 1, method: 'ping' })).status, 401);
  }
  const asRefresh = form({ grant_type: 'refresh_token', refresh_token: tok.access_token, client_id: tok.client_id });
  assert.equal((await (await call('/token', asRefresh)).json()).error, 'invalid_grant');
  assert.equal((await (await redeem(tok.client_id, tok.refresh_token)).json()).error, 'invalid_grant');
  const elsewhere = await seal(env, 'access', { s: [], u: 'u', r: 'https://other.example/mcp', g: 'g' }, 300);
  assert.equal((await rpc(elsewhere, { id: 1, method: 'ping' })).status, 401);
});

test('consent: Cancel returns access_denied; a missing CSRF cookie is refused; two flows keep their own', async () => {
  const one = await consentPage(),
    two = await consentPage();
  assert.notEqual(one.csrf.split('=')[0], two.csrf.split('=')[0], 'per-flow cookie names');
  const deny = await call(
    '/authorize',
    form({ state: one.state, csrf_token: one.csrfToken, action: 'deny' }, one.csrf),
  );
  assert.equal(location(deny).searchParams.get('error'), 'access_denied');
  const noCookie = await call('/authorize', form({ state: two.state, csrf_token: two.csrfToken, action: 'approve' }));
  assert.equal(noCookie.status, 400);
  const both = `${one.csrf}; ${two.csrf}`;
  const approve = await call(
    '/authorize',
    form({ state: two.state, csrf_token: two.csrfToken, action: 'approve' }, both),
  );
  assert.equal(approve.status, 200, 'the second flow still works with the first one open');
});

test('authorize refuses unregistered redirects, missing PKCE, script redirects and forged clients', async () => {
  const body = JSON.stringify({ redirect_uris: ['https://app.example/cb'] });
  const reg = await (
    await call('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  ).json();
  const q = {
    response_type: 'code',
    client_id: reg.client_id,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  const evil = await call(`/authorize?${new URLSearchParams({ ...q, redirect_uri: 'https://evil.example/cb' })}`);
  assert.equal(evil.status, 400);
  const noPkce = await call(`/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id })}`);
  assert.equal(location(noPkce).searchParams.get('error'), 'invalid_request');
  const script = JSON.stringify({ redirect_uris: ['javascript:alert(1)'] });
  const bad = await call('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: script,
  });
  assert.equal(bad.status, 400);
  assert.equal((await call('/authorize?client_id=forged')).status, 400);
});

test('sign-in: a pending Continue (nonce script), and the page is a locked-down form', async () => {
  const s = await startSignIn();
  const res = await answer(s, { link: 'https://example.com/nope' });
  const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
  assert.ok(nonce, 'a nonce-based script-src');
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const html = await res.text();
  assert.ok(html.includes(`<script nonce="${nonce}">`), "the page's only script carries it");
  assert.match(html, /aria-busy.*Signing in…/);
  assert.match(html, /Sign in with Paper/, 'the sign-in page again');
});

test('consent: the redirect host up front; DCR clients are unverified, CIMD clients show their host', async () => {
  const q = (/** @type {string} */ client_id, /** @type {string} */ redirect_uri) =>
    new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  const reg = await (
    await call('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REGISTERED], client_name: 'Claude Code' }),
    })
  ).json();
  const dcr = await (await call(`/authorize?${q(reg.client_id, REDIRECT)}`)).text();
  assert.match(dcr, /Returns you to <strong>127\.0\.0\.1:50000 \(this computer\)<\/strong>/);
  assert.match(dcr, /Unverified app — only continue if you started this from <strong>Claude Code<\/strong>\./);

  const id = 'https://client.example/oauth/metadata.json';
  documents.set(id, { client_id: id, client_name: 'Example', redirect_uris: ['https://client.example/cb'] });
  const cimd = await (await call(`/authorize?${q(id, 'https://client.example/cb')}`)).text();
  assert.match(cimd, /Returns you to <strong>client\.example<\/strong>/);
  assert.match(cimd, /Client published by <strong>client\.example<\/strong>/);
  assert.doesNotMatch(cimd, /Unverified/);
});

test('MCP: catalog cached per client; initialize warms the container; any session id; parse error', async () => {
  const tok = await connect();
  const init = (/** @type {string} */ name) =>
    rpc(tok.access_token, {
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name } },
    });
  const catalogs = () => seen.filter((r) => r[0] === 'account' && r[2] === '/catalog').length;
  let n = catalogs();
  const first = await init('cursor');
  assert.equal(catalogs(), n + 1, 'the first time, the container answers');
  await Promise.all(background.splice(0));
  n = catalogs();
  const second = await init('cursor');
  assert.equal((await second.json()).result.instructions, 'Paper says hi', 'then the cache does');
  assert.notEqual(first.headers.get('mcp-session-id'), second.headers.get('mcp-session-id'), 'a new id each time');
  await Promise.all(background.splice(0));
  assert.equal(catalogs(), n + 1, "and the account's container is warmed in the background");
  assert.deepEqual(last('account', '/catalog')[3].clientInfo, { name: 'cursor', transport: 'remote' });
  n = catalogs();
  const id = second.headers.get('mcp-session-id') ?? '';
  const list = await (await rpc(tok.access_token, { id: 2, method: 'tools/list' }, { 'mcp-session-id': id })).json();
  assert.equal(list.result.tools[0].name, 'get_basic_info');
  assert.equal(catalogs(), n, 'tools/list from the cache');

  const any = await rpc(
    tok.access_token,
    { id: 3, method: 'tools/call', params: { name: 'x' } },
    { 'mcp-session-id': 'whatever' },
  );
  assert.equal((await any.json()).result.content[0].text, 'ran x', 'any session id is accepted');
  assert.equal(last('account', '/call')[3].clientInfo.name, 'unknown');

  const bad = await call('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  assert.equal((await rpc(tok.access_token, { method: 'notifications/initialized' })).status, 202);
  const del = await call('/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${tok.access_token}` } });
  assert.equal(del.status, 405);
});
