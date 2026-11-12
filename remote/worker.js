// Paper Remote MCP: a stateless OAuth front door for Paper's hosted MCP server (https://mcp.paper.design), on Cloudflare Workers.
//
// MCP clients see one OAuth authorization server + protected resource, in the shape the MCP authorization spec asks for (and
// as linear-re's front door, app/sync-server/mcp/frontDoor.ts, does it). Signing in is Paper's: this server is a public OAuth
// client of login.paper.design, by a client ID metadata document (/oauth/client.json), with PKCE.
//
// Nothing is stored. Everything this server hands out is AES-256-GCM ciphertext under SEAL_KEY, its purpose bound as
// associated data, and it carries the state it needs:
//   client_id (DCR)  the registration itself                        /register
//   state            the client's authorization request (10 min)    /authorize → the consent page → /authorize (POST)
//   upstream state   that request + our PKCE verifier + a nonce     → login.paper.design → /callback
//   code             Paper's token pair + the client's PKCE (60 s)  /callback → the client → /token
//   access token     Paper's access token (Paper's lifetime)        /mcp: opened, forwarded to mcp.paper.design
//   refresh token    Paper's refresh token                          /token: Paper refreshes it (single use), we reseal the new pair
//
//   GET  /                                                  landing page
//   GET  /.well-known/oauth-protected-resource[/mcp]        RFC 9728
//   GET  /.well-known/oauth-authorization-server            RFC 8414
//   GET  /oauth/client.json                                 our client metadata document, for Paper
//   POST /register                                          RFC 7591 (public clients)
//   GET  /authorize | POST /authorize                       consent page | its answer
//   GET  /callback                                          Paper's answer
//   POST /token                                             authorization_code, refresh_token
//   *    /mcp                                               Streamable HTTP, proxied
import { consentPage, homePage } from './page.js';

const PAPER_MCP = 'https://mcp.paper.design';
const PAPER_AS = 'https://login.paper.design';
const PAPER_SCOPE = 'openid profile email offline_access';
const REQUEST_TTL = 600, CODE_TTL = 60, DEFAULT_ACCESS_TTL = 3600, UPSTREAM_TIMEOUT = 15_000;
const CSRF_COOKIE = '__Host-CSRF', CONSENT_COOKIE = '__Host-CONSENT';
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const HTML_HEADERS = { 'content-type': 'text/html;charset=UTF-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer' };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, www-authenticate',
  'access-control-max-age': '86400',
};
/** What crosses the proxy, each way */
const FORWARD_REQUEST = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARD_RESPONSE = ['content-type', 'mcp-session-id', 'cache-control'];

/** @typedef {{ SEAL_KEY: string, PUBLIC_URL?: string }} Env */
/** @typedef {{ access_token: string, refresh_token?: string, expires_in?: number }} PaperTokens */
/** @typedef {{ clientId: string, redirectUri: string, state?: string, codeChallenge: string, resource?: string }} AuthRequest */
/** @typedef {{ id: string, redirectUris: string[], name?: string, logoUri?: string }} Client */

const enc = new TextEncoder(), dec = new TextDecoder();
const now = () => Math.floor(Date.now() / 1000);
/** @param {Uint8Array} bytes */
const b64u = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
/** @param {string} s */
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const random = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
/** @param {string} verifier */
const s256 = async (verifier) => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
/** Constant-time string equality @param {string} a @param {string} b */
const equal = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// --- sealing ---------------------------------------------------------------------------------------------------------

/** @type {Map<string, Promise<CryptoKey>>} */
const keys = new Map();
/** @param {Env} env */
function sealKey(env) {
  const raw = env.SEAL_KEY ?? '';
  let key = keys.get(raw);
  if (!key) {
    const bytes = unb64u(raw);
    if (bytes.length !== 32) throw new Error('SEAL_KEY must be 32 random bytes, base64url (openssl rand -base64 32)');
    key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keys.set(raw, key);
  }
  return key;
}

/**
 * Encrypts `value` for `purpose` (a token sealed for one purpose never opens as another), expiring after `ttl` seconds.
 * ponytail: one key, no rotation; rotating SEAL_KEY signs everyone out. Add a SEAL_KEY_PREVIOUS to open with if that matters.
 * @param {Env} env @param {string} purpose @param {object} value @param {number} [ttl]
 */
export async function seal(env, purpose, value, ttl) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = enc.encode(JSON.stringify(ttl ? { ...value, exp: now() + ttl } : value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(purpose) }, await sealKey(env), body));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64u(out);
}

/**
 * The value sealed for `purpose`; undefined when it isn't one (forged, another purpose's, another key's) or has expired.
 * @template T @param {Env} env @param {string} purpose @param {string | null | undefined} token @returns {Promise<T | undefined>}
 */
export async function open(env, purpose, token) {
  if (!token) return undefined;
  const key = await sealKey(env);
  try {
    const raw = unb64u(token);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(purpose) }, key, raw.slice(12));
    const value = JSON.parse(dec.decode(pt));
    return value.exp && value.exp < now() ? undefined : value;
  } catch {
    return undefined;
  }
}

// --- responses -------------------------------------------------------------------------------------------------------

/** @param {unknown} body @param {number} [status] @param {Record<string, string>} [headers] */
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...NO_STORE, ...CORS, ...headers } });
/** @param {string} body @param {number} [status] */
const text = (body, status = 400) => new Response(body, { status, headers: { 'content-type': 'text/plain;charset=UTF-8', ...NO_STORE } });
/** @param {string} error @param {string} description @param {number} [status] */
const oauthError = (error, description, status = 400) => json({ error, error_description: description }, status);
/** @param {string} to @param {Record<string, string | undefined>} params @param {string[]} [cookies] */
function redirect(to, params, cookies = []) {
  const url = new URL(to);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const headers = new Headers({ location: url.href, ...NO_STORE });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}
/** @param {string} name @param {string} value @param {number} maxAge */
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
/** @param {Request} request @param {string} name */
const cookieOf = (request, name) => {
  for (const pair of (request.headers.get('cookie') ?? '').split(/;\s*/)) {
    const at = pair.indexOf('=');
    if (at > 0 && pair.slice(0, at) === name) return pair.slice(at + 1);
  }
  return '';
};

// --- clients ---------------------------------------------------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** `asked` is one of `registered`: exactly, or a loopback http URI on any port (RFC 8252 §7.3) @param {string[]} registered @param {string} asked */
export function redirectMatches(registered, asked) {
  if (registered.includes(asked)) return true;
  let to;
  try { to = new URL(asked); } catch { return false; }
  if (to.protocol !== 'http:' || !LOOPBACK.has(to.hostname)) return false;
  return registered.some((uri) => {
    try {
      const r = new URL(uri);
      return r.protocol === 'http:' && r.hostname === to.hostname && r.pathname === to.pathname && r.search === to.search;
    } catch { return false; }
  });
}
/** A redirect URI a client may register: absolute, no fragment, never a script @param {unknown} value */
const validRedirect = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return !url.hash && !['javascript:', 'data:', 'vbscript:', 'file:'].includes(url.protocol);
  } catch { return false; }
};
/** @param {unknown} v @param {number} max */
const shortString = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);

/**
 * The client a `client_id` names: a client ID metadata document's https URL (fetched), or one /register sealed.
 * ponytail: metadata documents are fetched on every /authorize, uncached; cache them (the Cache API) if that shows up.
 * @param {Env} env @param {string | null} id @returns {Promise<Client | undefined>}
 */
async function findClient(env, id) {
  if (!id) return undefined;
  if (id.startsWith('https://')) {
    const res = await fetch(id, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    const raw = res?.ok ? await res.text().catch(() => '') : '';
    let doc;
    try { doc = raw.length <= 10_240 ? JSON.parse(raw) : undefined; } catch { /* not JSON */ }
    if (!doc || doc.client_id !== id || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every(validRedirect)) return undefined;
    return { id, redirectUris: doc.redirect_uris, name: shortString(doc.client_name, 100), logoUri: shortString(doc.logo_uri, 2048) };
  }
  /** @type {{ r: string[], n?: string, l?: string } | undefined} */
  const sealed = await open(env, 'client', id);
  return sealed && { id, redirectUris: sealed.r, name: sealed.n, logoUri: sealed.l };
}

/** RFC 7591. Every client is public (PKCE is its proof); one asking for a secret is told `none`. @param {Request} request @param {Env} env */
async function register(request, env) {
  const body = await request.json().catch(() => undefined);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return oauthError('invalid_client_metadata', 'Invalid JSON payload');
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > 10 || !redirectUris.every(validRedirect)) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must be 1–10 absolute URIs without a fragment');
  }
  const name = shortString(body.client_name, 100), logo = shortString(body.logo_uri, 2048);
  const clientId = await seal(env, 'client', { r: redirectUris, ...(name && { n: name }), ...(logo && { l: logo }) });
  return json({
    client_id: clientId, client_id_issued_at: now(), redirect_uris: redirectUris, ...(name && { client_name: name }), ...(logo && { logo_uri: logo }),
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  }, 201);
}

// --- authorization ---------------------------------------------------------------------------------------------------

/** @param {URL} url @param {Env} env */
async function authorizePage(url, env) {
  const p = (/** @type {string} */ name) => url.searchParams.get(name);
  const client = await findClient(env, p('client_id'));
  if (!client) return text('Invalid client_id');
  const redirectUri = p('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) return text('Invalid redirect_uri: it is not one this client registered');
  const state = p('state') ?? undefined;
  const refuse = (/** @type {string} */ error, /** @type {string} */ description) => redirect(redirectUri, { error, error_description: description, state, iss: url.origin });
  if (p('response_type') !== 'code') return refuse('unsupported_response_type', 'Only response_type=code is supported');
  const codeChallenge = p('code_challenge');
  if (!codeChallenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) return refuse('invalid_request', 'code_challenge is required (PKCE)');
  if (p('code_challenge_method') !== 'S256') return refuse('invalid_request', 'code_challenge_method must be S256');
  const resource = p('resource') ?? undefined;
  if (resource && !resources(url).includes(resource)) return refuse('invalid_target', 'The requested resource is not served here');

  /** @type {AuthRequest} */
  const req = { clientId: client.id, redirectUri, ...(state && { state }), codeChallenge, ...(resource && { resource }) };
  const csrf = random();
  return new Response(
    consentPage({ clientName: client.name || 'An MCP client', redirectUri, logoUri: client.logoUri, state: await seal(env, 'request', req, REQUEST_TTL), csrfToken: csrf }),
    { headers: { ...HTML_HEADERS, 'set-cookie': cookie(CSRF_COOKIE, csrf, REQUEST_TTL) } }
  );
}

/** The consent page's answer: back to the client (Cancel), or on to Paper's sign-in (Continue). @param {Request} request @param {URL} url @param {Env} env */
async function consent(request, url, env) {
  const form = new URLSearchParams(await request.text());
  const csrf = form.get('csrf_token') ?? '', expected = cookieOf(request, CSRF_COOKIE);
  if (!csrf || !expected || !equal(csrf, expected)) return text('Invalid CSRF token');
  /** @type {AuthRequest | undefined} */
  const req = await open(env, 'request', form.get('state'));
  if (!req) return text('This authorization request has expired. Start again from your MCP client.');
  const clear = cookie(CSRF_COOKIE, '', 0);
  if (form.get('action') !== 'approve') return redirect(req.redirectUri, { error: 'access_denied', state: req.state, iss: url.origin }, [clear]);

  const verifier = random(), nonce = random(16);
  return redirect(`${PAPER_AS}/oauth2/authorize`, {
    response_type: 'code',
    client_id: `${url.origin}/oauth/client.json`,
    redirect_uri: `${url.origin}/callback`,
    scope: PAPER_SCOPE,
    state: await seal(env, 'upstream', { req, verifier, nonce }, REQUEST_TTL),
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
    resource: PAPER_MCP,
  }, [clear, cookie(CONSENT_COOKIE, nonce, REQUEST_TTL)]);
}

/**
 * Paper's token endpoint, as our public client. "dead": Paper refused the grant (spent, revoked); "unavailable": anything else.
 * @param {URL} url @param {Record<string, string>} form @returns {Promise<PaperTokens | 'dead' | 'unavailable'>}
 */
async function paperToken(url, form) {
  const res = await fetch(`${PAPER_AS}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...form, client_id: `${url.origin}/oauth/client.json` }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  }).catch(() => undefined);
  const body = await res?.json().catch(() => undefined);
  if (!res?.ok) return body?.error === 'invalid_grant' ? 'dead' : 'unavailable';
  return typeof body?.access_token === 'string' ? body : 'unavailable';
}

/** Paper's answer: its code redeemed, ours (the pair inside) sent to the client. @param {Request} request @param {URL} url @param {Env} env */
async function callback(request, url, env) {
  /** @type {{ req: AuthRequest, verifier: string, nonce: string } | undefined} */
  const up = await open(env, 'upstream', url.searchParams.get('state'));
  const nonce = cookieOf(request, CONSENT_COOKIE);
  // the nonce cookie binds Paper's answer to the browser that approved (no login CSRF)
  if (!up || !nonce || !equal(up.nonce, nonce)) return text('Invalid or expired state. Start again from your MCP client.');
  const { req } = up;
  const back = (/** @type {Record<string, string | undefined>} */ params) =>
    redirect(req.redirectUri, { ...params, state: req.state, iss: url.origin }, [cookie(CONSENT_COOKIE, '', 0)]);
  const iss = url.searchParams.get('iss');
  if (iss && iss !== PAPER_AS) return back({ error: 'server_error', error_description: 'Unexpected authorization server' });
  const upstreamError = url.searchParams.get('error');
  if (upstreamError) return back({ error: upstreamError === 'access_denied' ? 'access_denied' : 'server_error', error_description: url.searchParams.get('error_description') ?? undefined });

  const paper = await paperToken(url, {
    grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: `${url.origin}/callback`, code_verifier: up.verifier, resource: PAPER_MCP,
  });
  if (paper === 'unavailable') return back({ error: 'temporarily_unavailable', error_description: 'Paper could not be reached' });
  if (paper === 'dead') return back({ error: 'access_denied', error_description: 'Paper refused the sign-in' });
  // ponytail: nothing is stored, so a code is not single-use; it lives 60 s and is useless without the client's PKCE verifier.
  return back({ code: await seal(env, 'code', { req, paper }, CODE_TTL) });
}

/** The resources a token may be bound to (RFC 8707) @param {URL} url */
const resources = (url) => [url.origin, `${url.origin}/`, `${url.origin}/mcp`];

/** @param {Env} env @param {PaperTokens} paper @param {string} clientId @param {string} [resource] */
async function issue(env, paper, clientId, resource) {
  const ttl = Math.max(60, Number(paper.expires_in) || DEFAULT_ACCESS_TTL);
  return json({
    access_token: await seal(env, 'access', { t: paper.access_token }, ttl),
    token_type: 'Bearer',
    expires_in: ttl,
    ...(paper.refresh_token && { refresh_token: await seal(env, 'refresh', { t: paper.refresh_token, c: clientId, ...(resource && { r: resource }) }) }),
    ...(resource && { resource }),
  });
}

/** @param {Request} request @param {URL} url @param {Env} env */
async function token(request, url, env) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    return oauthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  const form = new URLSearchParams(await request.text());
  // public clients: client_id in the form, or the id half of a Basic header (a secret, if any, is ignored)
  const basic = /^basic\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  let clientId = form.get('client_id');
  if (!clientId && basic) {
    try { clientId = decodeURIComponent(atob(basic).split(':')[0]); } catch { /* none */ }
  }
  if (!clientId) return oauthError('invalid_client', 'client_id is required', 401);
  const resource = form.get('resource') ?? undefined;

  if (form.get('grant_type') === 'authorization_code') {
    /** @type {{ req: AuthRequest, paper: PaperTokens } | undefined} */
    const code = await open(env, 'code', form.get('code'));
    if (!code || code.req.clientId !== clientId) return oauthError('invalid_grant', 'Invalid authorization code');
    const redirectUri = form.get('redirect_uri');
    if (redirectUri && redirectUri !== code.req.redirectUri) return oauthError('invalid_grant', 'Invalid redirect_uri');
    const verifier = form.get('code_verifier');
    if (!verifier) return oauthError('invalid_request', 'code_verifier is required (PKCE)');
    if (!equal(await s256(verifier), code.req.codeChallenge)) return oauthError('invalid_grant', 'Invalid PKCE code_verifier');
    if (resource && code.req.resource && resource !== code.req.resource) return oauthError('invalid_target', 'resource does not match the authorized resource');
    return issue(env, code.paper, clientId, code.req.resource ?? resource);
  }

  if (form.get('grant_type') === 'refresh_token') {
    /** @type {{ t: string, c: string, r?: string } | undefined} */
    const refresh = await open(env, 'refresh', form.get('refresh_token'));
    if (!refresh || refresh.c !== clientId) return oauthError('invalid_grant', 'Invalid refresh token');
    if (resource && refresh.r && resource !== refresh.r) return oauthError('invalid_target', 'resource does not match the authorized resource');
    // Paper's refresh tokens are single use: the new pair goes back to the client inside the new tokens, so nothing is kept here
    const paper = await paperToken(url, { grant_type: 'refresh_token', refresh_token: refresh.t });
    if (paper === 'unavailable') return oauthError('temporarily_unavailable', 'Paper could not be reached', 503);
    if (paper === 'dead') return oauthError('invalid_grant', 'Invalid refresh token');
    return issue(env, { refresh_token: refresh.t, ...paper }, clientId, refresh.r);
  }

  return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

// --- the MCP endpoint ------------------------------------------------------------------------------------------------

/** @param {URL} url @param {boolean} presented */
const unauthorized = (url, presented) =>
  json({ error: 'invalid_token', error_description: presented ? 'The access token is invalid or expired' : 'Authorization needed' }, 401, {
    'www-authenticate': `Bearer ${presented ? 'error="invalid_token", ' : ''}resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
  });

/** Streamable HTTP, forwarded to Paper with the access token's Paper token. @param {Request} request @param {URL} url @param {Env} env */
async function mcp(request, url, env) {
  const bearer = /^bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  /** @type {{ t: string } | undefined} */
  const access = await open(env, 'access', bearer);
  if (!access) return unauthorized(url, Boolean(bearer));

  const headers = new Headers({ authorization: `Bearer ${access.t}` });
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const res = await fetch(`${PAPER_MCP}/`, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : undefined }).catch(() => undefined);
  if (!res) return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Paper could not be reached' } }, 502);
  // Paper refused its token (revoked, or expired early): the client's to refresh, not Paper's challenge to follow
  if (res.status === 401) return unauthorized(url, true);

  const out = new Headers(CORS);
  for (const name of FORWARD_RESPONSE) {
    const value = res.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

// --- routing ---------------------------------------------------------------------------------------------------------

export default {
  /** @param {Request} request @param {Env} env */
  async fetch(request, env) {
    // PUBLIC_URL: the origin clients see, when a proxy in front (a tunnel, another domain) changes the one this sees
    const url = new URL(request.url);
    if (env.PUBLIC_URL) url.href = new URL(url.pathname + url.search, env.PUBLIC_URL).href;
    const { pathname: path } = url, method = request.method;
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin], bearer_methods_supported: ['header'], resource_name: 'Paper Remote MCP' });
    }
    if (path === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`,
        registration_endpoint: `${url.origin}/register`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
      });
    }
    if (path === '/oauth/client.json') {
      return json({
        client_id: `${url.origin}/oauth/client.json`,
        client_name: 'Paper Remote MCP',
        client_uri: url.origin,
        redirect_uris: [`${url.origin}/callback`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }, 200, { 'cache-control': 'public, max-age=300' });
    }
    if (path === '/mcp') return mcp(request, url, env);
    if (path === '/authorize') return method === 'POST' ? consent(request, url, env) : authorizePage(url, env);
    if (path === '/callback' && method === 'GET') return callback(request, url, env);
    if (path === '/token' && method === 'POST') return token(request, url, env);
    if (path === '/register' && method === 'POST') return register(request, env);
    if (path === '/' && method === 'GET') return new Response(homePage(`${url.origin}/mcp`), { headers: HTML_HEADERS });
    return text('Not found', 404);
  },
};
