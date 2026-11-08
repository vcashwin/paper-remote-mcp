// The MCP front door: this server is its own OAuth 2.1 authorization server, ported
// from Linefold's mcp/frontDoor.ts (itself Cloudflare workers-oauth-provider's shape).
// Hop 2 is not an upstream OAuth server but Link Paper (link.js).
//
//   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata (CIMD + DCR, S256, iss)
//   POST /register        dynamic registration (clients.js); a CIMD URL works as a client_id too
//   GET  /authorize       the request checked; no linked account in this browser → /link first;
//                         then the consent page (CSRF cookie, the request signed into `state`)
//   POST /authorize       Cancel → access_denied; Allow → a grant + code → the client, with `iss`
//   POST /token           authorization_code (PKCE S256, `resource` bound), refresh_token (rotation:
//                         the presented token stays usable until its successor is used), and RFC 7009
//                         revocation (any token of a grant ends the whole grant)
//
// Tokens: pmcp_{at,rt,code}_<grant id>_<secret>, stored as SHA-256 only. Personal keys:
// pmcp_key_<key id>_<secret>. One scope, `paper`.
import { cors, cookie, cookies, html, json, readBody, readForm, redirect, text, NO_STORE } from './http.js';
import { redirectMatches, RegistrationError } from './clients.js';
import { consentPage } from './pages.js';
import { digest, equal, pkceChallenge, randomString } from './seal.js';
import { safeNext } from './link.js';

export const ACCESS_TOKEN_LIFETIME = 86_100;
export const SCOPE = 'paper';
const CODE_LIFETIME = 10 * 60_000;
const TOKEN_RE = /^pmcp_(at|rt|code)_([A-Za-z0-9]{16})_([A-Za-z0-9]{32})$/;
const KEY_RE = /^pmcp_key_([A-Za-z0-9]{16})_([A-Za-z0-9]{32})$/;
const CSRF_COOKIE = '__Host-pmcp_csrf';

/** @typedef {{ responseType: string, clientId: string, clientName: string, redirectUri: string, state: string, codeChallenge: string, resource?: string, accountId: string }} AuthRequest */

/**
 * @param {{
 *   store: import('./store.js').Store, secrets: import('./seal.js').Secrets, clients: import('./clients.js').Clients,
 *   link: ReturnType<typeof import('./link.js').createLink>, origin: string,
 * }} o
 */
export function createFrontDoor({ store, secrets, clients, link, origin }) {
  const issuer = origin, resource = `${origin}/mcp`;
  const resources = [origin, resource, `${resource}/`];

  const metadata = () => ({
    issuer,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/token`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    resource,
    resource_metadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
  });

  /** @param {import('./http.js').Req} req @param {import('./http.js').Res} res @param {URL} url */
  async function authorizePage(req, res, url) {
    const param = (/** @type {string} */ name) => url.searchParams.get(name);
    const clientId = param('client_id');
    if (!clientId) return text(res, 400, 'client_id is required');
    const client = await clients.find(clientId);
    if (!client) return text(res, 400, 'Invalid client_id');
    const redirectUri = param('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri))
      return text(res, 400, 'Invalid redirect URI. The redirect URI provided does not match any registered URI for this client.');
    const state = param('state') ?? undefined;
    const refuse = (/** @type {string} */ error, /** @type {string} */ description) => redirect(res, redirectUri, { error, error_description: description, state, iss: issuer });
    if (param('response_type') !== 'code') return refuse('unsupported_response_type', 'Only response_type=code is supported');
    // ponytail: one scope; whatever else a client asks for is ignored rather than refused (fewer failed connects)
    const codeChallenge = param('code_challenge'), method = param('code_challenge_method') ?? 'plain';
    if (!codeChallenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) return refuse('invalid_request', 'code_challenge is required (PKCE)');
    if (method !== 'S256') return refuse('invalid_request', 'The plain PKCE method is not allowed. Use S256 instead.');
    // RFC 8707; scheme and host compared case-insensitively
    const asked = param('resource')?.replace(/^https?:\/\/[^/]+/i, (m) => m.toLowerCase()) || undefined;
    if (asked && !resources.includes(asked)) return refuse('invalid_target', 'The requested resource is not served here');

    // Hop 2: this browser must have a linked Paper account. If not, link one and come back here.
    const account = link.current(req);
    if (!account) return redirect(res, `${origin}/link`, { next: url.pathname + url.search });

    /** @type {AuthRequest} */
    const request = { responseType: 'code', clientId, clientName: client.clientName || new URL(redirectUri).host, redirectUri, state: state ?? '', codeChallenge, ...(asked && { resource: asked }), accountId: account.id };
    const csrf = randomString(32);
    html(
      res,
      200,
      consentPage({
        clientName: request.clientName,
        redirectHost: new URL(redirectUri).host,
        email: account.email,
        state: secrets.sign('authorize', request),
        csrf,
        switchUrl: `/link/switch?next=${encodeURIComponent(safeNext(url.pathname + url.search))}`,
      }),
      { 'set-cookie': cookie(CSRF_COOKIE, csrf, 600) }
    );
  }

  /** @param {import('./http.js').Req} req @param {import('./http.js').Res} res */
  async function consent(req, res) {
    const form = await readForm(req);
    const csrf = form.get('csrf_token') ?? '', expected = cookies(req)[CSRF_COOKIE] ?? '';
    if (!csrf || !expected || !equal(csrf, expected)) return text(res, 400, 'Invalid CSRF token');
    /** @type {AuthRequest | undefined} */
    const request = secrets.verify('authorize', form.get('state'));
    if (!request) return text(res, 400, 'Invalid state');
    const clear = { 'set-cookie': cookie(CSRF_COOKIE, '', 0) };
    const back = (/** @type {Record<string, string | undefined>} */ params) => redirect(res, request.redirectUri, { ...params, state: request.state || undefined, iss: issuer }, clear);
    if (form.get('action') !== 'approve') return back({ error: 'access_denied' });
    // The consent was for the account this browser still has linked.
    const account = link.current(req);
    if (!account || account.id !== request.accountId) return back({ error: 'access_denied', error_description: 'The Paper account changed; connect again.' });

    const grantId = randomString(16), code = `pmcp_code_${grantId}_${randomString(32)}`, now = Date.now();
    // ponytail: unredeemed codes' grants are swept here, a day on
    store.run('delete from grants where code_digest is not null and refresh_digest is null and code_expires_at < ?', now - 86_400_000);
    store.run(
      `insert into grants (id, account_id, client_id, client_name, scope, resource, redirect_uri, code_challenge, code_digest, code_expires_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      grantId, account.id, request.clientId, request.clientName, SCOPE, request.resource ?? null, request.redirectUri, request.codeChallenge, digest(code), now + CODE_LIFETIME, now
    );
    back({ code });
  }

  /** The client a token request authenticates as. @param {import('./http.js').Req} req @param {URLSearchParams} form */
  async function clientOf(req, form) {
    const header = /^basic\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const [basicId, basicSecret] = header
      ? Buffer.from(header, 'base64').toString().split(':').map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return '';
          }
        })
      : [];
    const clientId = basicId ?? form.get('client_id'), secret = basicSecret ?? form.get('client_secret');
    if (!clientId) return { error: 'invalid_client', error_description: 'Client ID is required' };
    const client = await clients.find(clientId);
    if (!client) return { error: 'invalid_client', error_description: 'Client not found' };
    if (client.secretDigest && (!secret || !equal(digest(secret), client.secretDigest))) return { error: 'invalid_client', error_description: 'Invalid client credentials' };
    return client;
  }

  /** @param {{ id: string }} grant @param {number} now */
  function issue(grant, now) {
    const access = `pmcp_at_${grant.id}_${randomString(32)}`, refresh = `pmcp_rt_${grant.id}_${randomString(32)}`;
    store.run('delete from access_tokens where grant_id = ? and expires_at < ?', grant.id, now);
    store.run('insert into access_tokens (digest, grant_id, expires_at) values (?, ?, ?)', digest(access), grant.id, now + ACCESS_TOKEN_LIFETIME * 1000);
    return { access, refresh };
  }

  /** @param {import('./http.js').Req} req @param {import('./http.js').Res} res */
  async function token(req, res) {
    const headers = cors(req, false);
    const fail = (/** @type {number} */ status, /** @type {string} */ error, /** @type {string} */ error_description) => json(res, status, { error, error_description }, headers);
    const body = await readBody(req);
    if (body === undefined) return fail(413, 'invalid_request', 'Request body too large');
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded')
      return fail(400, 'invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
    const form = new URLSearchParams(body), grantType = form.get('grant_type');
    const client = await clientOf(req, form);
    if ('error' in client) return fail(401, /** @type {string} */ (client.error), /** @type {string} */ (client.error_description));
    const presented = form.get(grantType ? (grantType === 'refresh_token' ? 'refresh_token' : 'code') : 'token') ?? '';
    const parsed = TOKEN_RE.exec(presented);
    const grant = parsed ? store.get('select g.*, a.session is not null as linked from grants g join accounts a on a.id = g.account_id where g.id = ? and g.client_id = ?', parsed[2], client.clientId) : undefined;
    const now = Date.now();

    // RFC 7009: any token of a grant ends the grant; an unknown one is answered alike
    if (!grantType && form.has('token')) {
      const hash = digest(presented);
      const owner = store.get('select t.grant_id from access_tokens t join grants g on g.id = t.grant_id where t.digest = ? and g.client_id = ?', hash, client.clientId);
      if (owner) store.run('delete from grants where id = ?', owner.grant_id);
      else if (grant && (grant.refresh_digest === hash || grant.previous_refresh_digest === hash)) store.run('delete from grants where id = ?', grant.id);
      return void res.writeHead(200, { ...NO_STORE, ...headers }).end();
    }
    const answer = (/** @type {{ access: string, refresh: string }} */ tokens) =>
      json(res, 200, { access_token: tokens.access, token_type: 'bearer', expires_in: ACCESS_TOKEN_LIFETIME, scope: grant.scope, refresh_token: tokens.refresh, ...(grant.resource && { resource: grant.resource }) }, headers);
    const asked = form.get('resource');

    if (grantType === 'authorization_code') {
      if (!grant || !grant.code_digest || !equal(grant.code_digest, digest(presented)) || grant.code_expires_at < now) return fail(400, 'invalid_grant', 'Invalid authorization code');
      const redirectUri = form.get('redirect_uri');
      if (redirectUri && redirectUri !== grant.redirect_uri) return fail(400, 'invalid_grant', 'Invalid redirect URI');
      const verifier = form.get('code_verifier');
      if (!verifier) return fail(400, 'invalid_request', 'code_verifier is required for PKCE');
      if (pkceChallenge(verifier) !== grant.code_challenge) return fail(400, 'invalid_grant', 'Invalid PKCE code_verifier');
      if (asked && grant.resource && asked !== grant.resource) return fail(400, 'invalid_target', 'The requested resource does not match the authorized resource');
      const tokens = issue(grant, now);
      // the code is spent with its grant's first refresh token
      const spent = store.run('update grants set code_digest = null, code_expires_at = null, refresh_digest = ? where id = ? and code_digest = ?', digest(tokens.refresh), grant.id, grant.code_digest);
      if (!spent.changes) return fail(400, 'invalid_grant', 'Invalid authorization code');
      return answer(tokens);
    }
    if (grantType === 'refresh_token') {
      const hash = digest(presented);
      if (!grant || (grant.refresh_digest !== hash && grant.previous_refresh_digest !== hash)) return fail(400, 'invalid_grant', 'Invalid refresh token');
      if (asked && grant.resource && asked !== grant.resource) return fail(400, 'invalid_target', 'The requested resource does not match the authorized resource');
      // A Paper session that ended can't be refreshed into: the client must connect (and link) again.
      if (!grant.linked) return fail(400, 'invalid_grant', 'The Paper session ended; connect again');
      const tokens = issue(grant, now);
      // the presented token becomes the previous one (usable until the new one is), the new one the current
      store.run('update grants set previous_refresh_digest = ?, refresh_digest = ? where id = ?', hash, digest(tokens.refresh), grant.id);
      return answer(tokens);
    }
    return fail(400, 'unsupported_grant_type', 'Grant type not supported');
  }

  /** @param {import('./http.js').Req} req @param {import('./http.js').Res} res */
  async function registration(req, res) {
    const headers = cors(req, false);
    const fail = (/** @type {string} */ error_description, status = 400, error = 'invalid_client_metadata') => json(res, status, { error, error_description }, headers);
    const body = await readBody(req);
    if (body === undefined) return fail('Request payload too large', 413, 'invalid_request');
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fail('Invalid JSON payload', 400, 'invalid_request');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('Invalid JSON payload', 400, 'invalid_request');
    try {
      json(res, 201, clients.register(parsed), headers);
    } catch (err) {
      if (err instanceof RegistrationError) return fail(err.message);
      throw err;
    }
  }

  return {
    resource,
    metadata,

    /** @param {import('./http.js').Req} req @param {import('./http.js').Res} res @param {URL} url @returns {Promise<boolean>} */
    async handle(req, res, url) {
      const path = url.pathname;
      if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp' || path === '/.well-known/openid-configuration') {
        if (req.method === 'OPTIONS') return res.writeHead(204, cors(req)).end(), true;
        return json(res, 200, metadata(), { ...cors(req, false), 'cache-control': 'public, max-age=3600' }), true;
      }
      if (path === '/authorize') {
        await (req.method === 'POST' ? consent(req, res) : authorizePage(req, res, url));
        return true;
      }
      if (path !== '/token' && path !== '/register') return false;
      if (req.method === 'OPTIONS') return res.writeHead(204, cors(req)).end(), true;
      if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request', error_description: 'Method not allowed' }, cors(req, false)), true;
      await (path === '/token' ? token(req, res) : registration(req, res));
      return true;
    },

    /**
     * Who a bearer acts for: an access token's grant, or a personal key.
     * @param {string} bearer
     * @returns {{ accountId: string, agentId: string, linked: boolean } | undefined}
     */
    resolve(bearer) {
      const now = Date.now();
      const at = TOKEN_RE.exec(bearer);
      if (at?.[1] === 'at') {
        const row = store.get(
          `select g.id, g.account_id, g.resource, a.session is not null as linked from access_tokens t join grants g on g.id = t.grant_id join accounts a on a.id = g.account_id
           where t.digest = ? and t.expires_at > ?`,
          digest(bearer), now
        );
        if (!row || (row.resource && !resources.includes(row.resource))) return undefined;
        return { accountId: row.account_id, agentId: `grant:${row.id}`, linked: !!row.linked };
      }
      const key = KEY_RE.exec(bearer);
      if (key) {
        const row = store.get('select k.id, k.digest, k.account_id, a.session is not null as linked from keys k join accounts a on a.id = k.account_id where k.id = ?', key[1]);
        if (!row || !equal(row.digest, digest(bearer))) return undefined;
        store.run('update keys set used_at = ? where id = ?', now, row.id);
        return { accountId: row.account_id, agentId: `key:${row.id}`, linked: !!row.linked };
      }
      return undefined;
    },

    /** Mint a personal key (shown once). @param {string} accountId @param {string} label */
    createKey(accountId, label) {
      const id = randomString(16), key = `pmcp_key_${id}_${randomString(32)}`;
      store.run('insert into keys (id, account_id, digest, label, created_at) values (?, ?, ?, ?, ?)', id, accountId, digest(key), label || 'Personal key', Date.now());
      return key;
    },
  };
}
