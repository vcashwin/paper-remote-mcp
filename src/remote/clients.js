// OAuth clients of the front door, ported from Linefold's mcp/clients.ts:
//  - registered with `POST /register` (RFC 7591), kept 90 days, public or confidential;
//  - or a Client ID Metadata Document: an https `client_id` URL whose JSON names the
//    client, fetched from public addresses only (no SSRF, no DNS rebinding), small
//    and quick, and cached by max-age.
// A redirect URI must be one the client named, exactly — except a loopback one
// (http://localhost, 127.0.0.1, [::1]), which matches on any port (RFC 8252 §7.3).
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { digest, randomString } from './seal.js';

const REGISTRATION_LIFETIME_MS = 90 * 86_400_000;
const METADATA_TIMEOUT = 5_000, METADATA_MAX = 5 * 1024, CACHE_MAX = 1000, CACHE_DEFAULT = 5 * 60_000, CACHE_LONGEST = 86_400_000;
const AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'];
const URI_FIELDS = ['logo_uri', 'client_uri', 'policy_uri', 'tos_uri', 'jwks_uri'];

/** @typedef {{ clientId: string, redirectUris: string[], clientName?: string, logoUri?: string, secretDigest?: string }} Client */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Whether `asked` is one of `registered`: exactly, or a loopback URI on another port. @param {readonly string[]} registered @param {string} asked */
export function redirectMatches(registered, asked) {
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
      return r.protocol === 'http:' && r.hostname === to.hostname && r.pathname === to.pathname && r.search === to.search;
    } catch {
      return false;
    }
  });
}

/** An absolute URL without a fragment, never a script. @param {unknown} value */
const validRedirect = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return !url.hash && !['javascript:', 'data:', 'vbscript:', 'file:'].includes(url.protocol);
  } catch {
    return false;
  }
};

export class RegistrationError extends Error {}

// ── public-only fetching (Linefold's publicNetwork.ts) ──
const INSIDE = new net.BlockList();
for (const [address, prefix] of /** @type {const} */ ([['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]))
  INSIDE.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of /** @type {const} */ ([['::', 96], ['100::', 64], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32], ['2001:db8::', 32], ['fec0::', 10], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]))
  INSIDE.addSubnet(address, prefix, 'ipv6');

/** @param {string} address */
const isInternalAddress = (address) => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  return mapped ? INSIDE.check(mapped, 'ipv4') : INSIDE.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
};

/** dns.lookup that fails when any address is internal: the address connected to is the one checked. */
const publicLookup = /** @type {net.LookupFunction} */ (
  /** @type {unknown} */ (
    (/** @type {string} */ hostname, /** @type {dns.LookupOptions} */ options, /** @type {Function} */ callback) =>
      dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
        const refused = addresses?.find((a) => isInternalAddress(a.address));
        if (error || refused) return callback(error ?? new Error(`${hostname} is at ${refused?.address}, which is not public`), '');
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      })
  )
);

/**
 * One GET of `url` (not following redirects), refused when the address is not public.
 * @param {URL} url @param {{ allow?: readonly string[], signal?: AbortSignal }} options
 * @returns {Promise<http.IncomingMessage>}
 */
export function publicGet(url, { allow = [], signal }) {
  return new Promise((resolve, reject) => {
    if (!/^https?:$/.test(url.protocol)) return reject(new Error(`A request to ${url.protocol}`));
    const allowed = allow.includes(url.host), host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowed && net.isIP(host) && isInternalAddress(host)) return reject(new Error(`${host} is not public`));
    const options = { signal, agent: false, headers: { accept: 'application/json' }, ...(!allowed && { lookup: publicLookup }) };
    (url.protocol === 'https:' ? https : http).request(url, options, resolve).on('error', reject).end();
  });
}

/** A client id that is a metadata document's URL: https with a path (or http on an allowed host, for tests). @param {string} clientId @param {readonly string[]} allow */
const metadataUrl = (clientId, allow) => {
  try {
    const url = new URL(clientId);
    return (url.protocol === 'https:' || (url.protocol === 'http:' && allow.includes(url.host))) && url.pathname !== '/' && !url.hash ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * @param {import('./store.js').Store} store
 * @param {{ allow?: readonly string[] }} [options] host:port pairs fetched though not public (tests only)
 */
export function createClients(store, { allow = [] } = {}) {
  // ponytail: one process's cache, bounded; a changed document is seen once its max-age ends
  /** @type {Map<string, { client: Client | undefined, until: number }>} */
  const cache = new Map();

  /** @param {URL} url @returns {Promise<{ client?: Client, maxAge: number }>} */
  async function fetchDocument(url) {
    const response = await publicGet(url, { allow, signal: AbortSignal.timeout(METADATA_TIMEOUT) });
    const maxAge = Number(/max-age=(\d+)/.exec(String(response.headers['cache-control'] ?? ''))?.[1] ?? NaN) * 1000;
    const lifetime = Number.isFinite(maxAge) ? Math.min(Math.max(maxAge, 60_000), CACHE_LONGEST) : CACHE_DEFAULT;
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      if ((size += chunk.length) > METADATA_MAX) {
        response.destroy();
        return { maxAge: CACHE_DEFAULT };
      }
      chunks.push(chunk);
    }
    if (response.statusCode !== 200) return { maxAge: CACHE_DEFAULT };
    const doc = JSON.parse(Buffer.concat(chunks).toString());
    const method = doc.token_endpoint_auth_method ?? 'none';
    if (doc.client_id !== url.href || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || !doc.redirect_uris.every(validRedirect) || method !== 'none')
      return { maxAge: lifetime };
    return {
      client: {
        clientId: url.href,
        redirectUris: doc.redirect_uris,
        clientName: typeof doc.client_name === 'string' ? doc.client_name : undefined,
        logoUri: typeof doc.logo_uri === 'string' ? doc.logo_uri : undefined,
      },
      maxAge: lifetime,
    };
  }

  return {
    /** `POST /register`'s body checked and stored; the RFC 7591 answer. @param {Record<string, any>} body */
    register(body) {
      const redirectUris = body.redirect_uris;
      if (!Array.isArray(redirectUris) || !redirectUris.length) throw new RegistrationError('At least one redirect URI is required');
      if (!redirectUris.every(validRedirect)) throw new RegistrationError('Invalid redirect URI');
      const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
      if (!AUTH_METHODS.includes(method)) throw new RegistrationError('Invalid token endpoint authentication method');
      /** @param {string} name @returns {string | undefined} */
      const text = (name) => {
        const v = body[name];
        if (v !== undefined && typeof v !== 'string') throw new RegistrationError(`${name} must be a string`);
        return v;
      };
      /** @param {string} name @returns {string[] | undefined} */
      const list = (name) => {
        const v = body[name];
        if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) throw new RegistrationError(`${name} must be an array of strings`);
        return v;
      };
      const now = Date.now(), clientId = randomString(16), secret = method === 'none' ? undefined : randomString(32), issuedAt = Math.floor(now / 1000);
      const answer = {
        client_id: clientId,
        ...(secret && { client_secret: secret }),
        redirect_uris: redirectUris,
        client_name: text('client_name'),
        ...Object.fromEntries(URI_FIELDS.map((name) => [name, text(name)])),
        contacts: list('contacts'),
        grant_types: list('grant_types') ?? ['authorization_code', 'refresh_token'],
        response_types: list('response_types') ?? ['code'],
        token_endpoint_auth_method: method,
        client_id_issued_at: issuedAt,
        ...(secret && { client_secret_issued_at: issuedAt, client_secret_expires_at: Math.floor((now + REGISTRATION_LIFETIME_MS) / 1000) }),
      };
      /** @type {Client} */
      const client = { clientId, redirectUris, clientName: answer.client_name, logoUri: text('logo_uri'), ...(secret && { secretDigest: digest(secret) }) };
      store.run('delete from clients where expires_at < ?', now);
      store.run('insert into clients (client_id, data, expires_at) values (?, ?, ?)', clientId, JSON.stringify(client), now + REGISTRATION_LIFETIME_MS);
      return answer;
    },

    /** A client by id: a live registration, or the metadata document at that URL. @param {string} clientId @returns {Promise<Client | undefined>} */
    async find(clientId) {
      const url = metadataUrl(clientId, allow);
      if (!url) {
        const row = store.get('select data from clients where client_id = ? and expires_at > ?', clientId, Date.now());
        return row ? JSON.parse(row.data) : undefined;
      }
      const cached = cache.get(url.href);
      if (cached && cached.until > Date.now()) return cached.client;
      const { client, maxAge } = await fetchDocument(url).catch(() => ({ client: undefined, maxAge: 60_000 }));
      cache.delete(url.href);
      if (cache.size >= CACHE_MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
      cache.set(url.href, { client, until: Date.now() + maxAge });
      return client;
    },
  };
}
/** @typedef {ReturnType<typeof createClients>} Clients */
