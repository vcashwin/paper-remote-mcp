// The whole OAuth + proxy flow against a faked Paper: `node --test remote/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import worker, { open } from './worker.js';

const PAPER_AS = 'https://login.paper.design', PAPER_MCP = 'https://mcp.paper.design';

const env = { SEAL_KEY: randomBytes(32).toString('base64') };
const ORIGIN = 'https://paper-mcp.example';
const REDIRECT = 'http://127.0.0.1:33418/callback';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

/** @param {string} path @param {RequestInit} [init] */
const call = (path, init) => worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }), env);
/** @param {Response} res @param {string} name */
const setCookie = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0] ?? '';
const form = (/** @type {Record<string, string>} */ o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });

/** Paper, faked: its token endpoint and its MCP server. Records what it was sent. */
const paper = { tokenCalls: /** @type {URLSearchParams[]} */ ([]), mcpCalls: /** @type {Request[]} */ ([]), next: 1 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit | undefined} */ init) => {
  const req = new Request(input, init);
  if (req.url === `${PAPER_AS}/oauth2/token`) {
    const body = new URLSearchParams(await req.text());
    paper.tokenCalls.push(body);
    if (body.get('refresh_token') === 'dead') return Response.json({ error: 'invalid_grant' }, { status: 400 });
    const n = paper.next++;
    return Response.json({ access_token: `paper-at-${n}`, refresh_token: `paper-rt-${n}`, expires_in: 300, token_type: 'Bearer' });
  }
  if (req.url === `${PAPER_MCP}/`) {
    paper.mcpCalls.push(req);
    if (req.headers.get('authorization') === 'Bearer revoked') return new Response('{}', { status: 401 });
    return Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true } }, { headers: { 'mcp-session-id': 'sess-1', 'set-cookie': 'x=y' } });
  }
  return realFetch(input, init);
};

/** Register → consent → Paper → callback; the client's code. */
async function authorize() {
  const reg = await call('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test <Client>' }) });
  assert.equal(reg.status, 201);
  const { client_id, token_endpoint_auth_method } = await reg.json();
  assert.equal(token_endpoint_auth_method, 'none');

  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT.replace('33418', '50000'), code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state', resource: `${ORIGIN}/mcp` });
  const page = await call(`/authorize?${q}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Test &#60;Client&#62;/, 'client name is escaped');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const state = /name="state" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const csrfToken = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const csrf = setCookie(page, '__Host-CSRF');

  const approve = await call('/authorize', { ...form({ state, csrf_token: csrfToken, action: 'approve' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrf } });
  assert.equal(approve.status, 302);
  const toPaper = new URL(approve.headers.get('location') ?? '');
  assert.equal(`${toPaper.origin}${toPaper.pathname}`, `${PAPER_AS}/oauth2/authorize`);
  assert.equal(toPaper.searchParams.get('client_id'), `${ORIGIN}/oauth/client.json`);
  assert.equal(toPaper.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(toPaper.searchParams.get('resource'), PAPER_MCP);
  const nonce = setCookie(approve, '__Host-CONSENT');

  const cb = new URLSearchParams({ code: 'paper-code', state: toPaper.searchParams.get('state') ?? '', iss: PAPER_AS });
  const back = await call(`/callback?${cb}`, { headers: { cookie: nonce } });
  assert.equal(back.status, 302);
  const toClient = new URL(back.headers.get('location') ?? '');
  assert.equal(`${toClient.origin}${toClient.pathname}`, 'http://127.0.0.1:50000/callback', 'loopback redirect on another port');
  assert.equal(toClient.searchParams.get('state'), 'client-state');
  assert.equal(toClient.searchParams.get('iss'), ORIGIN);
  // our PKCE verifier went to Paper with its code
  const sent = paper.tokenCalls.at(-1);
  assert.equal(sent?.get('code'), 'paper-code');
  assert.equal(createHash('sha256').update(sent?.get('code_verifier') ?? '').digest('base64url'), toPaper.searchParams.get('code_challenge'));
  return { client_id, code: toClient.searchParams.get('code') ?? '', csrf, csrfToken, state };
}

test('metadata and the 401 challenge point clients at this server', async () => {
  const prm = await (await call('/.well-known/oauth-protected-resource/mcp')).json();
  assert.deepEqual(prm.authorization_servers, [ORIGIN]);
  assert.equal(prm.resource, `${ORIGIN}/mcp`);
  const as = await (await call('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.token_endpoint, `${ORIGIN}/token`);
  const res = await call('/mcp', { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/paper-mcp\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  const doc = await (await call('/oauth/client.json')).json();
  assert.equal(doc.client_id, `${ORIGIN}/oauth/client.json`);
});

test('sign-in, token, proxy, refresh: nothing stored, Paper tokens only inside our ciphertext', async () => {
  const { client_id, code } = await authorize();

  const bad = await call('/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: 'x'.repeat(43), redirect_uri: REDIRECT.replace('33418', '50000') }));
  assert.equal((await bad.json()).error, 'invalid_grant', 'wrong PKCE verifier');
  const other = await call('/token', form({ grant_type: 'authorization_code', code, client_id: 'someone-else', code_verifier: verifier }));
  assert.equal((await other.json()).error, 'invalid_grant', 'another client');

  const tok = await (await call('/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier, redirect_uri: REDIRECT.replace('33418', '50000') }))).json();
  assert.equal(tok.token_type, 'Bearer');
  assert.equal(tok.expires_in, 300);
  assert.equal(tok.resource, `${ORIGIN}/mcp`);
  assert.ok(!/paper-(at|rt)-/.test(JSON.stringify(tok)), 'Paper tokens never appear in the clear');

  const res = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', cookie: 'leak=1' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('mcp-session-id'), 'sess-1');
  assert.equal(res.headers.get('set-cookie'), null, "Paper's cookies don't cross");
  const fwd = paper.mcpCalls.at(-1);
  assert.equal(fwd?.headers.get('authorization'), 'Bearer paper-at-1');
  assert.equal(fwd?.headers.get('mcp-protocol-version'), '2025-06-18');
  assert.equal(fwd?.headers.get('cookie'), null);
  assert.equal(await fwd?.text(), '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');

  // a refresh token is not an access token (purposes are sealed apart)
  assert.equal((await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tok.refresh_token}` }, body: '{}' })).status, 401);

  const refreshed = await (await call('/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id }))).json();
  assert.equal(paper.tokenCalls.at(-1)?.get('refresh_token'), 'paper-rt-1');
  assert.equal((await open(env, 'access', refreshed.access_token))?.t, 'paper-at-2');
  assert.equal((await open(env, 'refresh', refreshed.refresh_token))?.t, 'paper-rt-2', "Paper's rotated refresh token goes back to the client");
});

test('refresh: a refused upstream grant is invalid_grant; another client cannot use it', async () => {
  const { seal } = await import('./worker.js');
  const dead = await seal(env, 'refresh', { t: 'dead', c: 'c1' });
  assert.equal((await (await call('/token', form({ grant_type: 'refresh_token', refresh_token: dead, client_id: 'c1' }))).json()).error, 'invalid_grant');
  const live = await seal(env, 'refresh', { t: 'paper-rt-x', c: 'c1' });
  assert.equal((await (await call('/token', form({ grant_type: 'refresh_token', refresh_token: live, client_id: 'c2' }))).json()).error, 'invalid_grant');
});

test("Paper's 401 becomes ours, so the client refreshes", async () => {
  const { seal } = await import('./worker.js');
  const access = await seal(env, 'access', { t: 'revoked' }, 300);
  const res = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${access}` }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
});

test('consent: Cancel returns access_denied; a missing CSRF cookie or consent nonce is refused', async () => {
  const { csrf, csrfToken, state } = await authorize();
  const deny = await call('/authorize', { ...form({ state, csrf_token: csrfToken, action: 'deny' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrf } });
  assert.equal(new URL(deny.headers.get('location') ?? '').searchParams.get('error'), 'access_denied');
  assert.equal((await call('/authorize', form({ state, csrf_token: csrfToken, action: 'approve' }))).status, 400, 'no CSRF cookie');

  const approve = await call('/authorize', { ...form({ state, csrf_token: csrfToken, action: 'approve' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrf } });
  const upstreamState = new URL(approve.headers.get('location') ?? '').searchParams.get('state') ?? '';
  assert.equal((await call(`/callback?${new URLSearchParams({ code: 'c', state: upstreamState })}`)).status, 400, 'no consent nonce: another browser');
});

test('authorize refuses unregistered redirects and missing PKCE', async () => {
  const reg = await (await call('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://app.example/cb'] }) })).json();
  assert.equal((await call(`/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' })}`)).status, 400);
  const noPkce = await call(`/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id })}`);
  assert.equal(new URL(noPkce.headers.get('location') ?? '').searchParams.get('error'), 'invalid_request');
  assert.equal((await call('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }) })).status, 400);
  assert.equal((await call(`/authorize?client_id=forged`)).status, 400);
});
