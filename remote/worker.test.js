// The whole OAuth + proxy flow against a faked Paper: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import worker, { open, seal } from './worker.js';

const PAPER_AS = 'https://login.paper.design',
  PAPER_MCP = 'https://mcp.paper.design';
const env = { SEAL_KEY: randomBytes(32).toString('base64') };
const ORIGIN = 'https://paper-mcp.example';
const REGISTERED = 'http://127.0.0.1:33418/callback';
const REDIRECT = 'http://127.0.0.1:50000/callback'; // the same loopback URI, another port (RFC 8252)
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

/** @param {string} path @param {RequestInit} [init] */
const call = (path, init) => worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }), env);
/**
 * The `name=value` of the cookie a response set whose name starts with `prefix`
 * @param {Response} res @param {string} prefix
 */
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

/** Paper, faked: its token endpoint and its MCP server. Records what it was sent. */
const paper = { tokenCalls: /** @type {URLSearchParams[]} */ ([]), mcpCalls: /** @type {Request[]} */ ([]), next: 1 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit | undefined} */ init) => {
  const req = new Request(input, init);
  if (req.url === `${PAPER_AS}/oauth2/token`) {
    const body = new URLSearchParams(await req.text());
    paper.tokenCalls.push(body);
    if (body.get('refresh_token') === 'dead') return Response.json({ error: 'invalid_grant' }, { status: 400 });
    if (body.get('refresh_token') === 'down') return new Response('', { status: 502 });
    const n = paper.next++;
    return Response.json({ access_token: `paper-at-${n}`, refresh_token: `paper-rt-${n}`, expires_in: 300 });
  }
  if (req.url === `${PAPER_MCP}/`) {
    paper.mcpCalls.push(req);
    if (req.headers.get('authorization') === 'Bearer revoked') return new Response('{}', { status: 401 });
    const headers = { 'mcp-session-id': 'sess-1', 'set-cookie': 'x=y' };
    return Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true } }, { headers });
  }
  return realFetch(input, init);
};

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
    state: /name="state" value="([^"]+)"/.exec(html)?.[1] ?? '',
    csrfToken: /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? '',
    csrf: cookieSet(page, '__Host-CSRF-'),
  };
}

/** Consent → Paper → callback; the client's code. */
async function authorize() {
  const { client_id, state, csrfToken, csrf } = await consentPage();
  const approve = await call('/authorize', form({ state, csrf_token: csrfToken, action: 'approve' }, csrf));
  assert.equal(approve.status, 302);
  const toPaper = location(approve);
  assert.equal(`${toPaper.origin}${toPaper.pathname}`, `${PAPER_AS}/oauth2/authorize`);
  assert.equal(toPaper.searchParams.get('client_id'), `${ORIGIN}/oauth/client.json`);
  assert.equal(toPaper.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(toPaper.searchParams.get('resource'), PAPER_MCP);
  const nonce = cookieSet(approve, '__Host-CONSENT-');

  const cb = new URLSearchParams({ code: 'paper-code', state: toPaper.searchParams.get('state') ?? '', iss: PAPER_AS });
  const back = await call(`/callback?${cb}`, { headers: { cookie: nonce } });
  assert.equal(back.status, 302);
  const toClient = location(back);
  assert.equal(`${toClient.origin}${toClient.pathname}`, REDIRECT);
  assert.equal(toClient.searchParams.get('state'), 'client-state');
  assert.equal(toClient.searchParams.get('iss'), ORIGIN);
  // our PKCE verifier went to Paper with its code
  const sent = paper.tokenCalls.at(-1);
  assert.equal(sent?.get('code'), 'paper-code');
  assert.equal(sent?.get('resource'), PAPER_MCP);
  const sentChallenge = createHash('sha256')
    .update(sent?.get('code_verifier') ?? '')
    .digest('base64url');
  assert.equal(sentChallenge, toPaper.searchParams.get('code_challenge'));
  return { client_id, code: toClient.searchParams.get('code') ?? '', upstreamState: cb.get('state') ?? '', nonce };
}

/** @param {string} client_id @param {string} code @param {Record<string, string>} [extra] */
const redeem = (client_id, code, extra = {}) =>
  call('/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier, ...extra }));

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
  assert.equal((await (await call('/oauth/client.json')).json()).client_id, `${ORIGIN}/oauth/client.json`);
});

test('sign-in, token, proxy, refresh: nothing stored, Paper tokens only inside our ciphertext', async () => {
  const { client_id, code } = await authorize();

  const bad = await redeem(client_id, code, { code_verifier: 'x'.repeat(43) });
  assert.equal((await bad.json()).error, 'invalid_grant', 'wrong PKCE verifier');
  assert.equal((await (await redeem('someone-else', code)).json()).error, 'invalid_grant', 'another client');
  const evil = await redeem(client_id, code, { resource: 'https://evil.example/' });
  assert.equal((await evil.json()).error, 'invalid_target', 'a resource not served here');

  const tok = await (await redeem(client_id, code, { redirect_uri: REDIRECT })).json();
  assert.equal(tok.token_type, 'Bearer');
  assert.equal(tok.expires_in, 300);
  assert.equal(tok.resource, `${ORIGIN}/mcp`);
  assert.ok(!/paper-(at|rt)-/.test(JSON.stringify(tok)), 'Paper tokens never appear in the clear');

  const res = await call('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      cookie: 'leak=1',
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('mcp-session-id'), 'sess-1');
  assert.equal(res.headers.get('set-cookie'), null, "Paper's cookies don't cross");
  const fwd = paper.mcpCalls.at(-1);
  assert.equal(fwd?.headers.get('authorization'), 'Bearer paper-at-1');
  assert.equal(fwd?.headers.get('mcp-protocol-version'), '2025-06-18');
  assert.equal(fwd?.headers.get('cookie'), null);
  assert.equal(await fwd?.text(), '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');

  // a refresh token is not an access token (purposes are sealed apart)
  const asBearer = { method: 'POST', headers: { authorization: `Bearer ${tok.refresh_token}` }, body: '{}' };
  assert.equal((await call('/mcp', asBearer)).status, 401);

  const refresh = form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id });
  const refreshed = await (await call('/token', refresh)).json();
  assert.equal(paper.tokenCalls.at(-1)?.get('refresh_token'), 'paper-rt-1');
  assert.equal(paper.tokenCalls.at(-1)?.get('resource'), PAPER_MCP, 'a refreshed Paper token stays bound to its MCP');
  assert.equal((await open(env, 'access', refreshed.access_token))?.t, 'paper-at-2');
  const resealed = await open(env, 'refresh', refreshed.refresh_token);
  assert.equal(resealed?.t, 'paper-rt-2', "Paper's rotated refresh token goes back to the client");
});

test('refresh: Paper refusing is invalid_grant, Paper down is 503, another client is refused', async () => {
  const refreshWith = async (/** @type {string} */ t, client_id = 'c1') => {
    const refresh_token = await seal(env, 'refresh', { t, c: 'c1', r: `${ORIGIN}/mcp` });
    return call('/token', form({ grant_type: 'refresh_token', refresh_token, client_id }));
  };
  assert.equal((await (await refreshWith('dead')).json()).error, 'invalid_grant');
  const down = await refreshWith('down');
  assert.equal(down.status, 503);
  assert.equal((await (await refreshWith('paper-rt-x', 'c2')).json()).error, 'invalid_grant');
});

test("Paper's 401 becomes ours, so the client refreshes; a token for another resource is refused", async () => {
  const revoked = await seal(env, 'access', { t: 'revoked', r: `${ORIGIN}/mcp` }, 300);
  const res = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${revoked}` }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
  const elsewhere = await seal(env, 'access', { t: 'paper-at-1', r: 'https://other.example/mcp' }, 300);
  const other = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${elsewhere}` }, body: '{}' });
  assert.equal(other.status, 401);
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
  assert.equal(approve.status, 302, 'the second flow still works with the first one open');
});

test('callback: no consent nonce (another browser) or a missing/wrong iss is refused', async () => {
  const { upstreamState, nonce } = await authorize();
  const noNonce = await call(`/callback?${new URLSearchParams({ code: 'c', state: upstreamState, iss: PAPER_AS })}`);
  assert.equal(noNonce.status, 400);
  for (const iss of [undefined, 'https://evil.example']) {
    const q = new URLSearchParams({ code: 'c', state: upstreamState, ...(iss && { iss }) });
    const res = await call(`/callback?${q}`, { headers: { cookie: nonce } });
    assert.equal(location(res).searchParams.get('error'), 'server_error');
  }
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
