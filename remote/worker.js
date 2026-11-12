// Paper Remote MCP on Cloudflare Workers: a stateless OAuth front door and MCP endpoint for Paper's own MCP tools,
// which run in our containers (runtime/, see docs/remote-runtime.md).
//
// MCP clients see one OAuth authorization server + protected resource, in the shape the MCP authorization spec asks
// for. Signing in is Paper's: after consent, our sign-in page asks for the Paper email, and a container (one per
// sign-in job, PaperSignIn) drives Paper's real sign-in page with what the user types (password, or the emailed code).
//
// Nothing is stored. Everything this server hands out is AES-256-GCM ciphertext under SEAL_KEY, its purpose bound as
// associated data, and it carries the state it needs:
//   client_id (DCR)  the registration itself                          /register
//   state            the client's authorization request (10 min)      /authorize → consent page → /authorize (POST)
//   flow             that request + a sign-in job id + a nonce (10 min) sign-in pages → /signin
//   code             Paper session cookies + user + the request (60 s) /signin → the client → /token
//   access token     Paper session cookies, user id, grant id (24 h)    /mcp
//   refresh token    the same + the client id                          /token: resealed with the latest session
//
// Tools run in the PaperAccount Durable Object's container (one per Paper user), which keeps Paper's renewed session
// in memory only.
//
//   GET  /                                             landing page
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
//   GET  /.well-known/oauth-authorization-server       RFC 8414
//   POST /register                                     RFC 7591 (public clients)
//   GET  /authorize | POST /authorize                  consent page | its answer (→ the sign-in page)
//   POST /signin                                       a sign-in step's answer
//   POST /token                                        authorization_code, refresh_token
//   POST /mcp                                          Streamable HTTP (JSON responses)
import { Container } from '@cloudflare/containers';
import { consentPage, homePage, signInPage } from './page.js';

const REQUEST_TTL = 600,
  CODE_TTL = 60,
  ACCESS_TTL = 86_400,
  CALL_TIMEOUT = 120_000,
  SIGNIN_TIMEOUT = 90_000; // the runtime may take ~70 s per step: up to 30 s to load Paper's page + 30 s for its answer
const METADATA_MAX_BYTES = 10_240;
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const UNAVAILABLE = 'Paper is temporarily unavailable';
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const HTML_HEADERS = {
  'content-type': 'text/html;charset=UTF-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, www-authenticate',
  'access-control-max-age': '86400',
};

/** @typedef {{ name: string, value: string, domain: string, path?: string, expires?: number, httpOnly?: boolean, secure?: boolean, sameSite?: string }} Cookie */
/** @typedef {{ cookies: Cookie[] }} Session */
/** @typedef {{ status: number, body?: any }} Reply  a container's answer; 504 when it gave none in time */
/**
 * @typedef {{ run(path: string, body: object): Promise<Reply>, latestSession(): Promise<Session | undefined> }} AccountStub
 * @typedef {{ step(path: string, body: object): Promise<Reply> }} SignInStub
 * @typedef {{ SEAL_KEY: string, PUBLIC_URL?: string,
 *   PAPER_ACCOUNT: { getByName(name: string): AccountStub }, PAPER_SIGNIN: { getByName(name: string): SignInStub } }} Env
 */
/**
 * @typedef {{ clientId: string, redirectUri: string, state?: string, codeChallenge: string, resource: string }}
 *   AuthRequest
 */
/** @typedef {{ redirectUris: string[], name?: string, logoUri?: string }} ClientMetadata */
/** @typedef {{ s: Cookie[], u: string, r: string, g: string, c: string }} Grant */
// Sealed payloads use one-letter keys to keep tokens short: s = Paper session cookies, u = Paper user (id), r =
// resource, c = client id, g = grant id (the agent id Paper sees), a = authorization request, j = job id, n = nonce.

const enc = new TextEncoder(),
  dec = new TextDecoder();
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
/** @param {string} a @param {string} b */
const timingSafeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** The resources a token may be bound to (RFC 8707); the MCP endpoint is the canonical one @param {URL} url */
const resources = (url) => [`${url.origin}/mcp`, url.origin, `${url.origin}/`];

// --- sealing -------------------------------------------------------------------------------------------------------

/** @type {{ raw: string, key: Promise<CryptoKey> } | undefined} */
let cachedKey;
/** @param {{ SEAL_KEY: string }} env */
function sealKey(env) {
  const raw = env.SEAL_KEY ?? '';
  if (cachedKey?.raw !== raw) {
    const bytes = unb64u(raw);
    if (bytes.length !== 32) throw new Error('SEAL_KEY must be 32 random bytes, base64 (openssl rand -base64 32)');
    cachedKey = { raw, key: crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
  }
  return cachedKey.key;
}

/** @param {Uint8Array} bytes @param {CompressionStream | DecompressionStream} through */
const pipe = async (bytes, through) =>
  new Uint8Array(
    await new Response(new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(through)).arrayBuffer(),
  );

/**
 * Encrypts `value` for `purpose` (sealed for one purpose, it never opens as another), expiring after `ttl` seconds.
 * Compressed first: Paper's session cookie is ~2–4 KB of base64, and tokens travel in headers and URLs.
 * ponytail: one key, no rotation; rotating SEAL_KEY signs everyone out. Add a SEAL_KEY_PREVIOUS if that matters.
 * @param {{ SEAL_KEY: string }} env @param {string} purpose @param {object} value @param {number} [ttl]
 */
export async function seal(env, purpose, value, ttl) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const json = enc.encode(JSON.stringify(ttl ? { ...value, exp: now() + ttl } : value));
  const body = await pipe(json, new CompressionStream('deflate-raw'));
  const algorithm = { name: 'AES-GCM', iv, additionalData: enc.encode(purpose) };
  const ct = new Uint8Array(await crypto.subtle.encrypt(algorithm, await sealKey(env), body));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64u(out);
}

/**
 * The value sealed for `purpose`; undefined when it isn't one (forged, another purpose's or key's) or has expired.
 * @template T @param {{ SEAL_KEY: string }} env @param {string} purpose @param {string | null | undefined} token
 * @returns {Promise<T | undefined>}
 */
export async function open(env, purpose, token) {
  if (!token) return undefined;
  const key = await sealKey(env);
  try {
    const raw = unb64u(token);
    const algorithm = { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(purpose) };
    const body = new Uint8Array(await crypto.subtle.decrypt(algorithm, key, raw.slice(12)));
    const value = JSON.parse(dec.decode(await pipe(body, new DecompressionStream('deflate-raw'))));
    return value.exp && value.exp < now() ? undefined : value;
  } catch {
    return undefined;
  }
}

// --- responses -----------------------------------------------------------------------------------------------------

/** @param {unknown} body @param {number} [status] @param {Record<string, string>} [headers] */
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...NO_STORE, ...CORS, ...headers },
  });
/** @param {string} body @param {number} [status] */
const plain = (body, status = 400) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain;charset=UTF-8', ...NO_STORE } });
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

// A flow's cookie is named after its value's first characters, so two sign-ins at once in one browser (two clients
// connecting) don't overwrite each other's.
/** @param {string} prefix @param {string} value */
const cookieName = (prefix, value) => `__Host-${prefix}-${value.slice(0, 12)}`;
/** @param {string} prefix @param {string} value @param {number} maxAge */
const setCookie = (prefix, value, maxAge) =>
  `${cookieName(prefix, value)}=${maxAge ? value : ''}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
/**
 * Whether the browser holds the flow cookie for `value`
 * @param {Request} request @param {string} prefix @param {string} value
 */
function hasCookie(request, prefix, value) {
  const name = cookieName(prefix, value);
  for (const pair of (request.headers.get('cookie') ?? '').split(/;\s*/)) {
    const at = pair.indexOf('=');
    if (pair.slice(0, at) === name) return timingSafeEqual(pair.slice(at + 1), value);
  }
  return false;
}

/** @param {string} body @param {string[]} [cookies] */
function page(body, cookies = []) {
  const headers = new Headers(HTML_HEADERS);
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(body, { headers });
}

/** Only Paper's own cookies cross into a token or a container @param {Cookie[] | undefined} cookies */
const paperCookies = (cookies) =>
  (Array.isArray(cookies) ? cookies : []).filter(
    (c) => typeof c?.domain === 'string' && /(^|\.)paper\.design$/.test(c.domain),
  );

// --- clients -------------------------------------------------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** `asked` is one of `registered`: exactly, or a loopback http URI on any port (RFC 8252 §7.3) */
export function redirectMatches(/** @type {string[]} */ registered, /** @type {string} */ asked) {
  if (registered.includes(asked)) return true;
  let to;
  try {
    to = new URL(asked);
  } catch {
    return false;
  }
  if (to.protocol !== 'http:' || !LOOPBACK.has(to.hostname)) return false;
  return registered.some((uri) => {
    try {
      const r = new URL(uri);
      return (
        r.protocol === 'http:' && r.hostname === to.hostname && r.pathname === to.pathname && r.search === to.search
      );
    } catch {
      return false;
    }
  });
}
/** A redirect URI a client may register: absolute, no fragment, never a script @param {unknown} value */
const validRedirect = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return !url.hash && !['javascript:', 'data:', 'vbscript:', 'file:'].includes(url.protocol);
  } catch {
    return false;
  }
};
/** @param {unknown} v @param {number} max */
const shortString = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);

/**
 * What a registration or a metadata document says about a client; undefined: not usable
 * @returns {ClientMetadata | undefined} */
function clientMetadata(/** @type {any} */ doc) {
  const uris = doc?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirect)) return undefined;
  return { redirectUris: uris, name: shortString(doc.client_name, 100), logoUri: shortString(doc.logo_uri, 2048) };
}

/**
 * A response body as text, or undefined past `max` bytes (read in chunks, never whole)
 * @param {Response} res @param {number} max
 */
async function cappedText(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((size += value.length) > max) return void reader.cancel();
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) all.set(c, (at += c.length) - c.length);
  return dec.decode(all);
}

/**
 * The client a `client_id` names: a client ID metadata document's https URL (fetched), or one /register sealed.
 * ponytail: metadata documents are fetched on every /authorize, uncached; cache them (Cache API) if that shows up.
 * @param {Env} env @param {string | null} id @returns {Promise<ClientMetadata | undefined>}
 */
async function findClient(env, id) {
  if (!id) return undefined;
  if (id.startsWith('https://')) {
    if (new URL(id).pathname === '/') return undefined;
    const res = await fetch(id, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    const raw = res?.ok ? await cappedText(res, METADATA_MAX_BYTES).catch(() => undefined) : undefined;
    let doc;
    try {
      doc = raw && JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    return doc?.client_id === id ? clientMetadata(doc) : undefined;
  }
  /** @type {{ m: any } | undefined} */
  const sealed = await open(env, 'client', id);
  return sealed && clientMetadata(sealed.m);
}

/** RFC 7591. Every client is public (PKCE is its proof); one asking for a secret is told `none`. */
async function register(/** @type {Request} */ request, /** @type {Env} */ env) {
  const body = await request.json().catch(() => undefined);
  const client = clientMetadata(body);
  if (!client) return oauthError('invalid_redirect_uri', 'redirect_uris: 1–10 absolute URIs, no fragment');
  const m = { redirect_uris: client.redirectUris, client_name: client.name, logo_uri: client.logoUri };
  return json(
    {
      client_id: await seal(env, 'client', { m }),
      client_id_issued_at: now(),
      ...m,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    201,
  );
}

// --- authorization -------------------------------------------------------------------------------------------------

async function authorizePage(/** @type {URL} */ url, /** @type {Env} */ env) {
  const param = (/** @type {string} */ name) => url.searchParams.get(name);
  const clientId = param('client_id');
  const client = await findClient(env, clientId);
  if (!clientId || !client) return plain('Invalid client_id');
  const redirectUri = param('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
    return plain('Invalid redirect_uri: it is not one this client registered');
  }
  const state = param('state') ?? undefined;
  const refuse = (/** @type {string} */ error, /** @type {string} */ description) =>
    redirect(redirectUri, { error, error_description: description, state, iss: url.origin });
  if (param('response_type') !== 'code')
    return refuse('unsupported_response_type', 'Only response_type=code is supported');
  const codeChallenge = param('code_challenge');
  if (!codeChallenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) {
    return refuse('invalid_request', 'code_challenge is required (PKCE)');
  }
  if (param('code_challenge_method') !== 'S256') return refuse('invalid_request', 'code_challenge_method must be S256');
  const resource = param('resource') ?? `${url.origin}/mcp`;
  if (!resources(url).includes(resource)) return refuse('invalid_target', 'The requested resource is not served here');

  /** @type {AuthRequest} */
  const authRequest = { clientId, redirectUri, ...(state && { state }), codeChallenge, resource };
  const csrf = random();
  const html = consentPage({
    clientName: client.name || 'An MCP client',
    redirectUri,
    logoUri: client.logoUri,
    state: await seal(env, 'request', authRequest, REQUEST_TTL),
    csrfToken: csrf,
  });
  return page(html, [setCookie('CSRF', csrf, REQUEST_TTL)]);
}

/** The consent page's answer: back to the client (Cancel), or on to the Paper sign-in page (Continue). */
async function consent(/** @type {Request} */ request, /** @type {URL} */ url, /** @type {Env} */ env) {
  const form = new URLSearchParams(await request.text());
  const csrf = form.get('csrf_token') ?? '';
  if (!csrf || !hasCookie(request, 'CSRF', csrf)) return plain('Invalid CSRF token');
  /** @type {AuthRequest | undefined} */
  const authRequest = await open(env, 'request', form.get('state'));
  if (!authRequest) return plain('This authorization request has expired. Start again from your MCP client.');
  const clear = setCookie('CSRF', csrf, 0);
  if (form.get('action') !== 'approve') {
    return redirect(authRequest.redirectUri, { error: 'access_denied', state: authRequest.state, iss: url.origin }, [
      clear,
    ]);
  }
  // a fresh sign-in job, bound to this browser by the nonce cookie (no login CSRF, nobody else can drive the job)
  const nonce = random();
  const flow = await seal(env, 'signin', { a: authRequest, j: random(), n: nonce }, REQUEST_TTL);
  return page(signInPage({ flow, step: 'email' }), [clear, setCookie('SIGNIN', nonce, REQUEST_TTL)]);
}

/**
 * A sign-in page's answer, passed to the job's container. Its next step is the next page; `done` sends the client
 * our code. The email, password and code go to the container only: never logged, never sealed.
 */
async function signIn(/** @type {Request} */ request, /** @type {URL} */ url, /** @type {Env} */ env) {
  const form = new URLSearchParams(await request.text());
  const flow = form.get('flow') ?? '';
  /** @type {{ a: AuthRequest, j: string, n: string } | undefined} */
  const job = await open(env, 'signin', flow);
  if (!job || !hasCookie(request, 'SIGNIN', job.n)) {
    return plain('This sign-in has expired. Start again from your MCP client.');
  }
  const email = (form.get('email') ?? '').trim().slice(0, 320);
  const container = env.PAPER_SIGNIN.getByName(job.j);
  const { status, body } =
    form.get('step') === 'email'
      ? await container.step('/signin/start', { email })
      : await container.step('/signin/continue', { value: (form.get('value') ?? '').slice(0, 1024) });

  const cookies = paperCookies(body?.session?.cookies);
  if (status === 200 && body?.step === 'done' && typeof body.user?.id === 'string' && cookies.length) {
    const { a } = job;
    // ponytail: nothing is stored, so a code is not single-use; it lives 60 s and is useless without the PKCE verifier.
    const code = await seal(env, 'code', { a, s: cookies, u: body.user }, CODE_TTL);
    return redirect(a.redirectUri, { code, state: a.state, iss: url.origin }, [setCookie('SIGNIN', job.n, 0)]);
  }
  if (status === 200 && (body?.step === 'password' || body?.step === 'code')) {
    return page(signInPage({ flow, step: body.step, email, message: body.message }));
  }
  // `error`, or the container failed: Paper's message (or ours), and the email again to start over
  const message = (status === 200 || status === 400) && body ? (body.message ?? body.error?.message) : undefined;
  return page(signInPage({ flow, step: 'email', email, message: message || `${UNAVAILABLE}. Try again.` }));
}

/** Seals a grant into the client's token pair. @param {{ SEAL_KEY: string }} env @param {Grant} grant */
async function issue(env, { s, u, c, r, g }) {
  const cookies = paperCookies(s);
  return json({
    access_token: await seal(env, 'access', { s: cookies, u, r, g }, ACCESS_TTL),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: await seal(env, 'refresh', { s: cookies, u, c, r, g }),
    resource: r,
  });
}

async function token(/** @type {Request} */ request, /** @type {URL} */ url, /** @type {Env} */ env) {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    return oauthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  const form = new URLSearchParams(await request.text());
  // public clients: client_id in the form, or the id half of a Basic header (a secret, if any, is ignored)
  const basic = /^basic\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  let clientId = form.get('client_id');
  if (!clientId && basic) {
    try {
      clientId = decodeURIComponent(atob(basic).split(':')[0]);
    } catch {
      /* none */
    }
  }
  if (!clientId) return oauthError('invalid_client', 'client_id is required', 401);
  const resource = form.get('resource');
  if (resource && !resources(url).includes(resource))
    return oauthError('invalid_target', 'The resource is not served here');

  if (form.get('grant_type') === 'authorization_code') {
    /** @type {{ a: AuthRequest, s: Cookie[], u: { id: string } } | undefined} */
    const code = await open(env, 'code', form.get('code'));
    if (!code || code.a.clientId !== clientId) return oauthError('invalid_grant', 'Invalid authorization code');
    const redirectUri = form.get('redirect_uri');
    if (redirectUri && redirectUri !== code.a.redirectUri) return oauthError('invalid_grant', 'Invalid redirect_uri');
    const verifier = form.get('code_verifier');
    if (!verifier) return oauthError('invalid_request', 'code_verifier is required (PKCE)');
    if (!timingSafeEqual(await s256(verifier), code.a.codeChallenge)) {
      return oauthError('invalid_grant', 'Invalid PKCE code_verifier');
    }
    if (resource && resource !== code.a.resource) {
      return oauthError('invalid_target', 'resource does not match the authorized resource');
    }
    // g: this grant's id, kept across refreshes; Paper sees it as the agent id
    return issue(env, { s: code.s, u: code.u.id, c: clientId, r: code.a.resource, g: random(12) });
  }

  if (form.get('grant_type') === 'refresh_token') {
    /** @type {Grant | undefined} */
    const refresh = await open(env, 'refresh', form.get('refresh_token'));
    if (!refresh || refresh.c !== clientId) return oauthError('invalid_grant', 'Invalid refresh token');
    if (resource && resource !== refresh.r)
      return oauthError('invalid_target', 'resource does not match the authorized resource');
    // Paper renews its cookie as tools run; the account's container hands the renewed one to its Durable Object,
    // which keeps it in memory. That one goes into the new tokens; if the object has none, the old one does.
    const latest = await env.PAPER_ACCOUNT.getByName(refresh.u)
      .latestSession()
      .catch(() => undefined);
    return issue(env, { ...refresh, s: latest?.cookies ?? refresh.s });
  }

  return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

// --- the MCP endpoint ----------------------------------------------------------------------------------------------

/** @param {URL} url @param {boolean} presented */
const unauthorized = (url, presented) =>
  json(
    {
      error: 'invalid_token',
      error_description: presented ? 'The access token is invalid or expired' : 'Authorization needed',
    },
    401,
    {
      'www-authenticate':
        `Bearer ${presented ? 'error="invalid_token", ' : ''}` +
        `resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
    },
  );

/** What to tell the client when the container didn't answer with a result @param {Reply} reply */
const failure = ({ status, body }) => ((status === 429 || status === 400) && body?.error?.message) || UNAVAILABLE;

/**
 * Streamable HTTP, JSON responses only (no SSE, no batches): one JSON-RPC message per POST. The MCP session id is
 * just the client's name (from initialize), handed back so tools/call can tell Paper which client it is.
 */
async function mcp(/** @type {Request} */ request, /** @type {URL} */ url, /** @type {Env} */ env) {
  const bearer = /^bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  /** @type {Omit<Grant, 'c'> | undefined} */
  const access = await open(env, 'access', bearer);
  if (!access || !resources(url).includes(access.r)) return unauthorized(url, Boolean(bearer));
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', ...CORS } });

  const msg = await request.json().catch(() => undefined);
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'One JSON-RPC message per request' } });
  }
  if (msg.id === undefined || typeof msg.method !== 'string') return new Response(null, { status: 202, headers: CORS });
  const reply = (/** @type {object} */ body, headers = {}) =>
    json({ jsonrpc: '2.0', id: msg.id, ...body }, 200, headers);
  const fail = (/** @type {string} */ message, code = -32603) => reply({ error: { code, message } });
  if (msg.method === 'ping') return reply({ result: {} });

  const account = env.PAPER_ACCOUNT.getByName(access.u);
  const session = { cookies: access.s };
  if (msg.method === 'initialize' || msg.method === 'tools/list') {
    const catalog = await account.run('/catalog', { session });
    if (catalog.status === 401) return unauthorized(url, true);
    if (catalog.status !== 200 || !Array.isArray(catalog.body?.tools)) return fail(failure(catalog));
    if (msg.method === 'tools/list') return reply({ result: { tools: catalog.body.tools } });
    const asked = msg.params?.protocolVersion;
    const name = String(msg.params?.clientInfo?.name ?? 'unknown').slice(0, 100);
    return reply(
      {
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
          capabilities: { tools: {} },
          serverInfo: { name: 'paper-remote-mcp', version: '0.2.0' },
          ...(catalog.body.instructions && { instructions: catalog.body.instructions }),
        },
      },
      { 'mcp-session-id': b64u(enc.encode(name)) },
    );
  }
  if (msg.method === 'tools/call') {
    const { name: tool, arguments: args = {} } = msg.params ?? {};
    if (typeof tool !== 'string') return fail('params.name is required', -32602);
    let client = 'unknown';
    try {
      client = dec.decode(unb64u(request.headers.get('mcp-session-id') || b64u(enc.encode(client))));
    } catch {
      /* not one of ours */
    }
    const call = await account.run('/call', { session, tool, args, agentId: access.g, clientInfo: { name: client } });
    if (call.status === 401) return unauthorized(url, true);
    if (call.status === 200 && call.body?.result) return reply({ result: call.body.result });
    return reply({ result: { content: [{ type: 'text', text: failure(call) }], isError: true } });
  }
  return fail(`Method not found: ${msg.method}`, -32601);
}

// --- routing -------------------------------------------------------------------------------------------------------

export default {
  /** @param {Request} request @param {Env} env */
  async fetch(request, env) {
    // PUBLIC_URL: the origin clients see, when a proxy in front (a tunnel, another domain) changes the one this sees
    const url = new URL(request.url);
    if (env.PUBLIC_URL) url.href = new URL(url.pathname + url.search, env.PUBLIC_URL).href;
    const { pathname: path } = url,
      method = request.method;
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return json({
        resource: `${url.origin}/mcp`,
        authorization_servers: [url.origin],
        bearer_methods_supported: ['header'],
        resource_name: 'Paper Remote MCP',
      });
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
    if (path === '/mcp') return mcp(request, url, env);
    if (path === '/authorize') return method === 'POST' ? consent(request, url, env) : authorizePage(url, env);
    if (path === '/signin' && method === 'POST') return signIn(request, url, env);
    if (path === '/token' && method === 'POST') return token(request, url, env);
    if (path === '/register' && method === 'POST') return register(request, env);
    if (path === '/' && method === 'GET') return page(homePage(`${url.origin}/mcp`));
    return plain('Not found', 404);
  },
};

// --- Durable Objects: each owns one container (runtime/server.js) ---------------------------------------------------

/**
 * POSTs `body` to the container's `path`: its status and JSON body (504 when it gave no answer in time)
 * @param {Container} container @param {string} path @param {object} body @param {number} timeout
 * @returns {Promise<Reply>}
 */
async function post(container, path, body, timeout) {
  try {
    const res = await container.containerFetch(`http://container${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  } catch {
    return { status: 504 };
  }
}

/**
 * One Paper account (named by Paper user id): its container runs the tools, one call at a time. It keeps the
 * catalog and the latest session Paper renewed, in memory only (never storage): a session lives here only while the
 * account is active, and goes back to the client inside its next refreshed token.
 */
export class PaperAccount extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
  pingEndpoint = 'container/healthz';
  /** @type {Session | undefined} */
  session;
  /** @type {{ tools: object[], instructions?: string } | undefined} */
  catalog;
  #queue = Promise.resolve();

  /** RPC: `/catalog` or `/call`, queued behind this account's other calls @param {string} path @param {any} body */
  run(path, body) {
    /** @type {Promise<Reply>} */
    const reply = this.#queue.then(() => this.#run(path, body));
    this.#queue = reply.then(
      () => {},
      () => {},
    );
    return reply;
  }

  /** @param {string} path @param {any} body @returns {Promise<Reply>} */
  async #run(path, body) {
    if (path === '/catalog' && this.catalog) return { status: 200, body: this.catalog };
    // the renewed session, when there is one, is newer than the one in the client's token
    const reply = await post(this, path, { ...body, session: this.session ?? body.session }, CALL_TIMEOUT);
    if (reply.status === 401) this.session = undefined; // the token's own session gets the next try
    if (reply.body?.session) this.session = { cookies: paperCookies(reply.body.session.cookies) };
    if (path === '/catalog' && reply.status === 200) this.catalog = reply.body;
    if (reply.body) delete reply.body.session;
    return reply;
  }

  /** RPC: the latest session Paper renewed, if this account has seen one since it woke */
  async latestSession() {
    return this.session;
  }
}

/** One sign-in job (named by a random id): its container drives Paper's sign-in page, step by step. */
export class PaperSignIn extends Container {
  defaultPort = 8080;
  sleepAfter = '5m';
  pingEndpoint = 'container/healthz';

  /** RPC: `/signin/start` or `/signin/continue` @param {string} path @param {object} body */
  async step(path, body) {
    const reply = await post(this, path, body, SIGNIN_TIMEOUT);
    // done: the session is in the reply, so nothing needs a signed-in browser any more
    if (reply.body?.step === 'done') this.stop().catch(() => {});
    return reply;
  }
}
