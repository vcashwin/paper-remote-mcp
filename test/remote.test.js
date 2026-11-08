// The hosted server, driven over real HTTP with a fake Paper (the `Paper` seam):
// OAuth front door edge cases with fetch, and a full connect with the real MCP SDK client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { createRemoteServer } from '../src/remote/server.js';
import { createSecrets } from '../src/remote/seal.js';
import { openStore } from '../src/remote/store.js';
import { AccountUnlinked } from '../src/remote/paper.js';
import { publicGet } from '../src/remote/clients.js';

const USER = { id: 'user_01PAPER', email: 'ada@example.com' };
const GOOD = { cookies: [{ name: 'session', value: 'good', domain: '.paper.design', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };

/** A fake Paper: a session is good when its cookie says so; `expire(id)` makes Paper reject it. */
function fakePaper(sessions) {
  const expired = new Set();
  const live = (id) => {
    if (expired.has(id)) {
      expired.delete(id);
      sessions.unlink(id);
    }
    if (!sessions.load(id)) throw new AccountUnlinked(id);
  };
  return {
    expire: (id) => expired.add(id),
    calls: [],
    async validate(s) {
      return s.cookies?.[0]?.value === 'good' ? { user: USER, storageState: s } : null;
    },
    async signIn() {
      let stage = 'email';
      return {
        async submit(value) {
          if (stage === 'email') return { step: (stage = 'password') };
          if (value === 'right') return { step: 'done', user: USER, storageState: GOOD };
          return { step: 'password', error: 'Invalid email or password' };
        },
        async close() {},
      };
    },
    async config(id) {
      live(id);
      return { tools: [{ name: 'get_basic_info', description: 'Info', inputSchema: { type: 'object', properties: {} } }], instructions: 'Use Paper well.' };
    },
    async call(id, agentId, name, args) {
      live(id);
      this.calls.push({ id, agentId, name, args });
      return { content: [{ type: 'text', text: `${name} ok for ${id}` }] };
    },
    async drop() {},
    async close() {},
  };
}

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let origin, remote, store, paper, docs, docsHost;
const DOCS = new Map();
before(async () => {
  docs = http.createServer((req, res) => {
    const doc = DOCS.get(req.url);
    res.writeHead(doc ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'max-age=60' }).end(JSON.stringify(doc ?? {}));
  });
  await new Promise((r) => docs.listen(0, '127.0.0.1', r));
  docsHost = `127.0.0.1:${docs.address().port}`;
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  store = await openStore(':memory:');
  remote = createRemoteServer({ store, secrets: createSecrets('test-seal-key-0123456789'), origin, paper: (sessions) => (paper = fakePaper(sessions)), allow: [docsHost] });
  await new Promise((r) => remote.server.listen(port, '127.0.0.1', r));
});
after(async () => { await remote.close(); store.close(); docs.close(); });

/** A browser: keeps cookies, sends our Origin on POSTs, never follows redirects. */
function browser() {
  const jar = new Map();
  const go = async (path, init = {}) => {
    const res = await fetch(new URL(path, origin), {
      redirect: 'manual',
      ...init,
      headers: { ...(init.method === 'POST' && { origin }), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...init.headers },
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split('; ');
      const [k, v] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      attrs.includes('Max-Age=0') ? jar.delete(k) : jar.set(k, v);
    }
    return res;
  };
  const postJson = (path, body, headers = {}) => go(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return {
    jar, go, postJson,
    /** Link Paper the "from your computer" way. */
    async linkByCode(state = GOOD) {
      const { code, poll } = await (await postJson('/link/code', {})).json();
      const claim = await fetch(`${origin}/link/code/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storageState: state }) });
      const status = await (await postJson('/link/code/status', { code, poll })).json();
      return { code, poll, claim, status };
    },
  };
}

const challenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
const register = async (body = {}) => (await fetch(`${origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:3000/cb'], token_endpoint_auth_method: 'none', client_name: 'Test Client', ...body }) })).json();
const tokenRequest = (form) => fetch(`${origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
const mcpPost = (token, body) => fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

/** Run /authorize → consent → approve in `b`; the code. */
async function authorize(b, clientId, verifier, extra = {}) {
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:4567/cb', code_challenge: challenge(verifier), code_challenge_method: 'S256', state: 'xyz', resource: `${origin}/mcp`, ...extra });
  const page = await b.go(`/authorize?${query}`);
  assert.equal(page.status, 200, await page.clone().text());
  const body = await page.text();
  const state = /name="state" value="([^"]+)"/.exec(body)[1], csrf = /name="csrf_token" value="([^"]+)"/.exec(body)[1];
  const approved = await b.go('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, csrf_token: csrf, action: 'approve' }) });
  assert.equal(approved.status, 302);
  const to = new URL(approved.headers.get('location'));
  assert.equal(to.searchParams.get('iss'), origin);
  assert.equal(to.searchParams.get('state'), 'xyz');
  assert.equal(to.port, '4567', 'loopback redirect matches on any port');
  return to.searchParams.get('code');
}

test('discovery: 401 challenge and metadata', async () => {
  const res = await mcpPost(null, INIT);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), new RegExp(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="paper"`));
  const bad = await mcpPost('nope', INIT);
  assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);

  const prm = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(prm.authorization_servers, [origin]);
  assert.equal(prm.resource, `${origin}/mcp`);
  const asm = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asm.issuer, origin);
  assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
  assert.ok(asm.token_endpoint_auth_methods_supported.includes('none'));
  assert.equal(asm.client_id_metadata_document_supported, true);
  assert.equal(asm.authorization_response_iss_parameter_supported, true);
});

test('registration validates redirect URIs', async () => {
  const bad = await fetch(`${origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }) });
  assert.equal(bad.status, 400);
  const ok = await register();
  assert.match(ok.client_id, /^[A-Za-z0-9]{16}$/);
  assert.equal(ok.client_secret, undefined);
});

test('authorize sends an unlinked browser to /link, refuses plain PKCE and foreign resources', async () => {
  const { client_id } = await register();
  const b = browser();
  const q = (extra) => new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://localhost:3000/cb', code_challenge: challenge('v'.repeat(43)), code_challenge_method: 'S256', ...extra });
  const toLink = await b.go(`/authorize?${q()}`);
  assert.equal(toLink.status, 302);
  assert.match(toLink.headers.get('location'), /\/link\?next=%2Fauthorize/);
  const plain = await b.go(`/authorize?${q({ code_challenge_method: 'plain' })}`);
  assert.equal(new URL(plain.headers.get('location')).searchParams.get('error'), 'invalid_request');
  const foreign = await b.go(`/authorize?${q({ resource: 'https://evil.example/mcp' })}`);
  assert.equal(new URL(foreign.headers.get('location')).searchParams.get('error'), 'invalid_target');
  const wrongRedirect = await b.go(`/authorize?${q({ redirect_uri: 'https://evil.example/cb' })}`);
  assert.equal(wrongRedirect.status, 400);
});

test('link codes: claimable once, only the creating browser gets the account', async () => {
  const b = browser();
  const { code, poll } = await (await b.postJson('/link/code', {})).json();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const rejected = await fetch(`${origin}/link/code/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storageState: { cookies: [{ name: 'session', value: 'bad' }] } }) });
  assert.equal(rejected.status, 401);
  const claim = await fetch(`${origin}/link/code/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storageState: GOOD }) });
  assert.equal((await claim.json()).email, USER.email);
  const again = await fetch(`${origin}/link/code/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storageState: GOOD }) });
  assert.equal(again.status, 404);
  const stranger = browser();
  assert.equal((await stranger.postJson('/link/code/status', { code, poll: 'x'.repeat(32) })).status, 404);
  const crossSite = await fetch(`${origin}/link/code/status`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ code, poll }) });
  assert.equal(crossSite.status, 403);
  const status = await (await b.postJson('/link/code/status', { code, poll })).json();
  assert.equal(status.linked, true);
  assert.ok(b.jar.has('__Host-pmcp_account'));
  // the stored session is sealed, never plain
  const row = store.get('select session from accounts where id = ?', USER.id);
  assert.ok(row.session && !row.session.includes('good'));
});

test('sign in through the server: email → password, with Paper\'s error on a wrong password', async () => {
  const b = browser();
  let r = await (await b.postJson('/link/signin', { start: true, value: USER.email })).json();
  assert.equal(r.step, 'password');
  assert.ok(b.jar.has('__Host-pmcp_signin'), 'the job lives in a cookie, not the page');
  // another browser can't drive this job
  const stranger = browser();
  assert.match((await (await stranger.postJson('/link/signin', { value: 'right' })).json()).error, /timed out/);
  r = await (await b.postJson('/link/signin', { value: 'wrong' })).json();
  assert.equal(r.step, 'password');
  assert.equal(r.error, 'Invalid email or password');
  r = await (await b.postJson('/link/signin', { value: 'right' })).json();
  assert.equal(r.step, 'done');
  assert.ok(b.jar.has('__Host-pmcp_account'));
});

test('token endpoint: PKCE, single-use code, rotation with grace, revocation', async () => {
  const { client_id } = await register();
  const b = browser();
  await b.linkByCode();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const code = await authorize(b, client_id, verifier);

  const wrongVerifier = await tokenRequest({ grant_type: 'authorization_code', code, client_id, code_verifier: 'x'.repeat(43) });
  assert.equal((await wrongVerifier.json()).error, 'invalid_grant');
  const res = await tokenRequest({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier, resource: `${origin}/mcp` });
  const tokens = await res.json();
  assert.equal(res.status, 200, JSON.stringify(tokens));
  assert.match(tokens.access_token, /^pmcp_at_/);
  assert.equal(tokens.scope, 'paper');
  assert.equal((await tokenRequest({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier })).status, 400, 'a code is single use');

  assert.equal((await mcpPost(tokens.access_token, INIT)).status, 200);

  const r1 = await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id })).json();
  assert.ok(r1.access_token);
  // the old refresh token still works until its successor is used (a lost response must not log out)
  const r1b = await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id })).json();
  assert.ok(r1b.access_token);
  const r2 = await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: r1b.refresh_token, client_id })).json();
  assert.ok(r2.access_token);
  assert.equal((await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id })).status, 400, 'superseded refresh token');

  await tokenRequest({ token: r2.access_token, client_id });
  assert.equal((await mcpPost(r2.access_token, INIT)).status, 401, 'revoked');
  assert.equal((await tokenRequest({ grant_type: 'refresh_token', refresh_token: r2.refresh_token, client_id })).status, 400, 'revocation ends the grant');
});

test('consent: cancel → access_denied; CSRF required', async () => {
  const { client_id } = await register();
  const b = browser();
  await b.linkByCode();
  const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://localhost:3000/cb', code_challenge: challenge('c'.repeat(43)), code_challenge_method: 'S256' });
  const body = await (await b.go(`/authorize?${query}`)).text();
  assert.match(body, /ada@example\.com/);
  const state = /name="state" value="([^"]+)"/.exec(body)[1], csrf = /name="csrf_token" value="([^"]+)"/.exec(body)[1];
  const forged = await b.go('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, csrf_token: 'forged', action: 'approve' }) });
  assert.equal(forged.status, 400);
  const cancel = await b.go('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, csrf_token: csrf, action: 'cancel' }) });
  assert.equal(new URL(cancel.headers.get('location')).searchParams.get('error'), 'access_denied');
});

test('personal keys from the account page; revoking one ends it', async () => {
  const b = browser();
  await b.linkByCode();
  const created = await b.go('/account', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'create_key', label: 'CI' }) });
  const key = /(pmcp_key_[A-Za-z0-9]{16}_[A-Za-z0-9]{32})/.exec(await created.text())[1];
  const listed = await (await mcpPost(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.equal(listed.result.tools[0].name, 'get_basic_info');
  const called = await (await mcpPost(key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_basic_info', arguments: {} } })).json();
  assert.equal(called.result.content[0].text, `get_basic_info ok for ${USER.id}`);
  assert.match(paper.calls.at(-1).agentId, /^key:/);

  const page = await (await b.go('/account')).text();
  const id = /name="id" value="([A-Za-z0-9]{16})"><button class="danger" name="action" value="revoke_key"/.exec(page)[1];
  const crossSite = await fetch(`${origin}/account`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example', cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: new URLSearchParams({ action: 'revoke_key', id }) });
  assert.equal(crossSite.status, 403);
  await b.go('/account', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'revoke_key', id }) });
  assert.equal((await mcpPost(key, INIT)).status, 401);
});

test('a session Paper rejects: the account unlinks, the client gets 401, refresh is refused, re-linking heals it', async () => {
  const { client_id } = await register();
  const b = browser();
  await b.linkByCode();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const code = await authorize(b, client_id, verifier);
  const tokens = await (await tokenRequest({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier })).json();

  paper.expire(USER.id);
  const call = await (await mcpPost(tokens.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_basic_info', arguments: {} } })).json();
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /Reconnect/);
  const next = await mcpPost(tokens.access_token, INIT);
  assert.equal(next.status, 401);
  assert.match(next.headers.get('www-authenticate'), /invalid_token/);
  assert.equal((await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id })).status, 400);
  // the browser's account cookie no longer counts: /authorize goes to /link
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://localhost:3000/cb', code_challenge: challenge(verifier), code_challenge_method: 'S256' });
  assert.equal((await b.go(`/authorize?${q}`)).status, 302);

  await b.linkByCode();
  assert.equal((await mcpPost(tokens.access_token, INIT)).status, 200, 'the same grant works again once re-linked');
});

test('disconnect deletes the account, its grants and keys', async () => {
  const b = browser();
  await b.linkByCode();
  const created = await b.go('/account', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'create_key', label: 'x' }) });
  const key = /(pmcp_key_[A-Za-z0-9_]+)/.exec(await created.text())[1];
  const gone = await b.go('/account', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'disconnect' }) });
  assert.equal(gone.status, 200);
  assert.equal(store.get('select count(*) as n from accounts').n, 0);
  assert.equal(store.get('select count(*) as n from keys').n, 0);
  assert.equal(store.get('select count(*) as n from grants').n, 0);
  assert.equal((await mcpPost(key, INIT)).status, 401);
});

test('the real MCP SDK client connects end to end: discovery → DCR → authorize → link → token → list → call', async () => {
  const b = browser();
  let saved = {}, verifier, authUrl;
  const provider = {
    redirectUrl: 'http://127.0.0.1:9/callback',
    clientMetadata: { client_name: 'SDK Client', redirect_uris: ['http://127.0.0.1:9/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    clientInformation: () => saved.client,
    saveClientInformation: (c) => (saved.client = c),
    tokens: () => saved.tokens,
    saveTokens: (t) => (saved.tokens = t),
    redirectToAuthorization: (url) => (authUrl = url),
    saveCodeVerifier: (v) => (verifier = v),
    codeVerifier: () => verifier,
  };
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider });
  const client = new Client({ name: 'sdk-test', version: '1.0.0' });
  await assert.rejects(client.connect(transport), UnauthorizedError);
  assert.ok(saved.client?.client_id, 'registered dynamically');

  // The user's browser: /authorize → /link → link from computer → back → Allow
  const first = await b.go(authUrl.pathname + authUrl.search);
  assert.equal(first.status, 302);
  await b.linkByCode();
  const body = await (await b.go(authUrl.pathname + authUrl.search)).text();
  const state = /name="state" value="([^"]+)"/.exec(body)[1], csrf = /name="csrf_token" value="([^"]+)"/.exec(body)[1];
  const back = await b.go('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, csrf_token: csrf, action: 'approve' }) });
  const code = new URL(back.headers.get('location')).searchParams.get('code');
  await transport.finishAuth(code);

  const connected = new Client({ name: 'sdk-test', version: '1.0.0' });
  await connected.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider }));
  assert.equal(connected.getInstructions(), 'Use Paper well.');
  const { tools } = await connected.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['get_basic_info']);
  const result = await connected.callTool({ name: 'get_basic_info', arguments: {} });
  assert.equal(result.content[0].text, `get_basic_info ok for ${USER.id}`);
  await connected.close();

  // the access token expires: the SDK refreshes with its refresh token and carries on
  const before = saved.tokens.access_token;
  store.run('update access_tokens set expires_at = 0');
  const again = new Client({ name: 'sdk-test', version: '1.0.0' });
  await again.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider }));
  assert.equal((await again.callTool({ name: 'get_basic_info', arguments: {} })).content[0].text, `get_basic_info ok for ${USER.id}`);
  assert.notEqual(saved.tokens.access_token, before, 'refreshed');
  await again.close();
});

test('client ID metadata documents: a valid one works without registering; mismatched or internal ones do not', async () => {
  const good = `http://${docsHost}/client.json`, mismatched = `http://${docsHost}/other.json`;
  DOCS.set('/client.json', { client_id: good, client_name: 'CIMD Client', redirect_uris: ['http://localhost/cb'], token_endpoint_auth_method: 'none' });
  DOCS.set('/other.json', { client_id: 'https://someone-else.example/client.json', redirect_uris: ['http://localhost/cb'] });
  const b = browser();
  await b.linkByCode();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const code = await authorize(b, good, verifier, { redirect_uri: 'http://localhost:4567/cb' });
  const tokens = await (await tokenRequest({ grant_type: 'authorization_code', code, client_id: good, code_verifier: verifier })).json();
  assert.match(tokens.access_token, /^pmcp_at_/);

  const q = (client_id) => new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://localhost/cb', code_challenge: challenge(verifier), code_challenge_method: 'S256' });
  assert.equal((await b.go(`/authorize?${q(mismatched)}`)).status, 400, 'a document must name itself');
  assert.equal((await b.go(`/authorize?${q(`https://127.0.0.1:${docs.address().port}/client.json`)}`)).status, 400, 'internal addresses are never fetched');
});

test('the link page escapes `next` (no script injection)', async () => {
  const evil = '/</script><script>alert(1)</script>';
  const body = await (await fetch(`${origin}/link?next=${encodeURIComponent(evil)}`)).text();
  assert.ok(!body.includes('</script><script>alert(1)'));
  assert.ok(body.includes('\\u003c/script>'));
});

test('a malformed account cookie is ignored, not a 500', async () => {
  const res = await fetch(`${origin}/account`, { redirect: 'manual', headers: { cookie: `__Host-pmcp_account=${encodeURIComponent('e30.' + 'é'.repeat(43))}` } });
  assert.equal(res.status, 302);
});

test('two consent pages open at once both work', async () => {
  const { client_id } = await register();
  const b = browser();
  await b.linkByCode();
  const open = async () => {
    const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://localhost:3000/cb', code_challenge: challenge('d'.repeat(43)), code_challenge_method: 'S256' });
    const body = await (await b.go(`/authorize?${q}`)).text();
    return { state: /name="state" value="([^"]+)"/.exec(body)[1], csrf: /name="csrf_token" value="([^"]+)"/.exec(body)[1] };
  };
  const first = await open(), second = await open();
  for (const page of [first, second]) {
    const r = await b.go('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state: page.state, csrf_token: page.csrf, action: 'approve' }) });
    assert.ok(new URL(r.headers.get('location')).searchParams.get('code'));
  }
});

test('disconnecting voids the account cookie in every browser, even after re-linking', async () => {
  const a = browser(), b = browser();
  await a.linkByCode();
  await b.linkByCode(); // re-linking voids a's cookie already
  assert.equal((await a.go('/account')).status, 302);
  assert.equal((await b.go('/account')).status, 200);
  await b.go('/account', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'disconnect' }) });
  const c = browser();
  await c.linkByCode();
  assert.equal((await b.go('/account')).status, 302, 'b\'s old cookie no longer opens the account');
});

test('metadata documents are only fetched from public addresses, names resolved included', async () => {
  await assert.rejects(publicGet(new URL(`http://localhost:${docs.address().port}/client.json`), {}), /not public/);
  await assert.rejects(publicGet(new URL(`http://127.0.0.1:${docs.address().port}/client.json`), {}), /not public/);
});
