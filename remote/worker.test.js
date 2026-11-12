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
const { default: worker, open, seal, renewCookies, PaperAccount, PaperSignIn } = await import('./worker.js');

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
/** Sign-in jobs' emails, by job */
const emails = new Map();
let running = 0,
  maxRunning = 0;

/** Jobs whose answer came too late for the Worker: their `done` is kept for the next try */
const kept = new Set();

/**
 * The sign-in container: `pw…` emails get a password step, `code…` a code step; `wrong` is a wrong answer, `slow`
 * answers after the Worker gave up (the runtime then keeps `done` for the same step's retry)
 */
async function signInContainer(/** @type {string} */ job, /** @type {string} */ path, /** @type {any} */ body) {
  if (path === '/signin/start') {
    emails.set(job, body.email);
    if (body.email.startsWith('down'))
      return Response.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 });
    if (body.email.startsWith('nobody'))
      return Response.json({ step: 'error', message: 'No Paper account for that email' });
    return Response.json({ step: body.email.startsWith('code') ? 'code' : 'password' });
  }
  if (body.value === 'wrong') return Response.json({ step: 'password', message: 'Incorrect password' });
  if (body.value === 'slow' && !kept.has(job)) {
    kept.add(job);
    throw new DOMException('The operation timed out', 'TimeoutError');
  }
  const email = emails.get(job) ?? '';
  return Response.json({ step: 'done', session: SESSION, user: { id: `user-${email}`, email } });
}

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

/** A Workers Rate Limiting binding: `limit` calls per key, then refused @param {number} limit */
function rateLimit(limit) {
  const counts = new Map();
  return {
    counts,
    async limit(/** @type {{ key: string }} */ { key }) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key) <= limit };
    },
  };
}

const env = {
  SEAL_KEY: randomBytes(32).toString('base64'),
  PAPER_ACCOUNT: namespace(PaperAccount, 'account', accountContainer),
  PAPER_SIGNIN: namespace(PaperSignIn, 'signin', signInContainer),
  SIGNIN_IP_LIMIT: rateLimit(1000),
  SIGNIN_EMAIL_LIMIT: rateLimit(1000),
};
/** What the Worker left running after its response (ctx.waitUntil) */
const background = /** @type {Promise<unknown>[]} */ ([]);
const ctx = { waitUntil: (/** @type {Promise<unknown>} */ p) => background.push(p) };

// --- Paper's API and client metadata documents, faked: the Worker's own fetch -------------------------------------

/** How /auth/me answers: a status, or 'down' (no answer); the Set-Cookie renewals it sends with a 200 */
const paper = { me: /** @type {number | 'down'} */ (200), renewals: /** @type {string[]} */ ([]), asked: 0 };
/** Client ID metadata documents, by URL */
const documents = new Map();
globalThis.fetch = async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit} */ init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (documents.has(url)) return Response.json(documents.get(url));
  assert.equal(url, 'https://api.paper.design/auth/me', 'no other fetch');
  paper.asked++;
  if (paper.me === 'down') throw new TypeError('fetch failed');
  const sent = new Headers(init?.headers).get('cookie') ?? '';
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of paper.renewals) headers.append('set-cookie', c);
  // the user id is the session cookie's value's owner: whatever the token says, unless it's a stolen one
  const id = sent.includes('other-user') ? 'someone-else' : 'user-me@example.com';
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

/** Consent → the sign-in page: the sealed flow and the browser's SIGNIN cookie. */
async function startSignIn() {
  const { client_id, state, csrfToken, csrf } = await consentPage();
  const res = await call('/authorize', form({ state, csrf_token: csrfToken, action: 'approve' }, csrf));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /name="email"/);
  assert.match(cookieSet(res, '__Host-CSRF-'), /=$/, 'the CSRF cookie is cleared');
  return { client_id, flow: field(html, 'flow'), cookie: cookieSet(res, '__Host-SIGNIN-') };
}

/** One sign-in page's answer @param {{ flow: string, cookie: string }} s @param {Record<string, string>} fields */
const answer = (s, fields) => call('/signin', form({ flow: s.flow, ...fields }, s.cookie));

/** The whole sign-in, password path: the client's code @param {string} email */
async function signIn(email) {
  const s = await startSignIn();
  const pw = await answer(s, { step: 'email', email });
  assert.match(await pw.text(), /type="password"/);
  const back = await answer(s, { step: 'password', email, value: 'right' });
  assert.equal(back.status, 302);
  const to = location(back);
  assert.equal(`${to.origin}${to.pathname}`, REDIRECT);
  assert.equal(to.searchParams.get('state'), 'client-state');
  assert.equal(to.searchParams.get('iss'), ORIGIN);
  return { client_id: s.client_id, code: to.searchParams.get('code') ?? '', back, s };
}

/** @param {string} client_id @param {string} code @param {Record<string, string>} [extra] */
const redeem = (client_id, code, extra = {}) =>
  call('/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier, ...extra }));

/** Signed in and redeemed: the client's tokens @param {string} email */
async function connect(email) {
  const { client_id, code } = await signIn(email);
  const res = await redeem(client_id, code);
  assert.equal(res.status, 200);
  return { client_id, ...(await res.json()) };
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

test('register → consent → sign-in (password) → code → token → MCP', async (t) => {
  const s = await startSignIn();
  const pw = await answer(s, { step: 'email', email: 'pw@example.com' });
  const pwPage = await pw.text();
  assert.match(pwPage, /autocomplete="current-password"/);
  assert.match(pwPage, /pw@example\.com/);
  const wrong = await (await answer(s, { step: 'password', email: 'pw@example.com', value: 'wrong' })).text();
  assert.match(wrong, /role="alert".*Incorrect password/, "Paper's error text is shown");
  assert.match(wrong, /type="password"/, 'and the password asked again');

  const back = await answer(s, { step: 'password', email: 'pw@example.com', value: 'right' });
  assert.equal(back.status, 302);
  const to = location(back);
  assert.equal(`${to.origin}${to.pathname}`, REDIRECT);
  assert.equal(to.searchParams.get('state'), 'client-state');
  assert.equal(to.searchParams.get('iss'), ORIGIN);
  assert.match(cookieSet(back, '__Host-SIGNIN-'), /=$/, 'the sign-in cookie is cleared');
  const job = last('signin')[1];
  assert.equal(env.PAPER_SIGNIN.objects.get(job)?.stopped, true, 'the sign-in container stops once done');
  const code = to.searchParams.get('code') ?? '';
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
  assert.equal(access?.u, 'user-pw@example.com');
  assert.deepEqual(access?.s, [SESSION.cookies[0], SESSION.cookies[2]], "only Paper's session cookies are kept");
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

test('sign-in, code path: the code Paper emailed', async () => {
  const s = await startSignIn();
  const page = await (await answer(s, { step: 'email', email: 'code@example.com' })).text();
  assert.match(page, /The code Paper emailed you/);
  assert.match(page, /autocomplete="one-time-code"/);
  const back = await answer(s, { step: 'code', email: 'code@example.com', value: '123456' });
  assert.equal(back.status, 302);
  assert.ok(location(back).searchParams.get('code'));
  assert.deepEqual(last('signin').slice(2), ['/signin/continue', { value: '123456' }]);
});

test("sign-in: Paper's error starts over with its message; a failing container is unavailable; no cookie, no job", async () => {
  const s = await startSignIn();
  const nobody = await (await answer(s, { step: 'email', email: 'nobody@example.com' })).text();
  assert.match(nobody, /No Paper account for that email/);
  assert.match(nobody, /name="email" autocomplete="username"/);
  const down = await (await answer(s, { step: 'email', email: 'down@example.com' })).text();
  assert.match(down, /Paper is temporarily unavailable/);
  assert.doesNotMatch(down, /boom/, 'internal errors stay internal');
  const noCookie = await call('/signin', form({ flow: s.flow, step: 'email', email: 'pw@example.com' }));
  assert.equal(noCookie.status, 400, 'the job is bound to the browser that consented');
  const forged = await call('/signin', form({ flow: 'forged', step: 'email', email: 'pw@example.com' }, s.cookie));
  assert.equal(forged.status, 400);
});

test("refresh asks Paper: signed in → new tokens with Paper's renewals; signed out → sign in again", async () => {
  const tok = await connect('pw-me@example.com');
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
    ['device', 'fresh'],
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

  const tok = await connect('pw-tools@example.com');
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

  const broken = await connect('pw-broken@example.com');
  const list = await (await rpc(broken.access_token, { id: 7, method: 'tools/list' })).json();
  assert.equal(list.error.message, 'Paper is temporarily unavailable');
});

test("token purposes don't cross; a token for another resource is refused", async () => {
  const tok = await connect('pw-purpose@example.com');
  const { code } = await signIn('pw-purpose@example.com');
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

test('sign-in abuse limits: per IP on every step, per email on starts; over either, the page says so', async () => {
  const s = await startSignIn();
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  const answerFrom = (/** @type {Record<string, string>} */ fields, /** @type {object} */ headers = ip) =>
    call('/signin', {
      ...form({ flow: s.flow, ...fields }, s.cookie),
      headers: { ...form({}, s.cookie).headers, ...headers },
    });
  const before = seen.length;
  env.SIGNIN_EMAIL_LIMIT = rateLimit(2);
  for (const _ of [1, 2])
    assert.equal((await answerFrom({ step: 'email', email: 'pw-limit@example.com' })).status, 200);
  const third = await answerFrom({ step: 'email', email: 'PW-limit@example.com' });
  assert.equal(third.status, 429, 'the email (any case) is limited');
  assert.match(await third.text(), /Too many sign-in attempts\. Try again in a few minutes\./);
  assert.equal(seen.length, before + 2, 'no container was asked');
  assert.ok(![...env.SIGNIN_EMAIL_LIMIT.counts.keys()].some((k) => k.includes('@')), 'emails are hashed');
  assert.equal((await answerFrom({ step: 'email', email: 'other@example.com' }, {})).status, 200, 'another email');

  env.SIGNIN_EMAIL_LIMIT = rateLimit(1000);
  env.SIGNIN_IP_LIMIT = rateLimit(1);
  assert.equal((await answerFrom({ step: 'email', email: 'pw-ip@example.com' })).status, 200);
  const guess = await answerFrom({ step: 'password', email: 'pw-ip@example.com', value: 'x' });
  assert.equal(guess.status, 429, 'password tries count against the IP too');
  assert.match(await guess.text(), /Too many sign-in attempts.*type="password"/s, 'on the same step');
  env.SIGNIN_IP_LIMIT = rateLimit(1000);
});

test('sign-in: a pending Continue (nonce script); an error stops the container; a late done is kept', async () => {
  const s = await startSignIn();
  const res = await answer(s, { step: 'email', email: 'pw-late@example.com' });
  const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
  assert.ok(nonce, 'a nonce-based script-src');
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const html = await res.text();
  assert.ok(html.includes(`<script nonce="${nonce}">`), "the page's only script carries it");
  assert.match(html, /aria-busy.*Signing in…/);

  const late = await answer(s, { step: 'password', email: 'pw-late@example.com', value: 'slow' });
  assert.equal(late.status, 200);
  const page = await late.text();
  assert.match(page, /type="password"/, 'no answer in time: the same step again, not the email');
  assert.match(page, /Submit again/);
  const retry = await answer(s, { step: 'password', email: 'pw-late@example.com', value: 'slow' });
  assert.equal(retry.status, 302, 'the resubmission gets the kept done');
  assert.ok(location(retry).searchParams.get('code'));

  const t = await startSignIn();
  await answer(t, { step: 'email', email: 'nobody@example.com' });
  assert.equal(env.PAPER_SIGNIN.objects.get(last('signin')[1])?.stopped, true, 'an error stops the container too');
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
  const tok = await connect('pw-cache@example.com');
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
