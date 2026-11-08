// Small node:http helpers shared by the remote routes.

const MAX_BODY = 64 * 1024;
export const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

/** @typedef {import('node:http').IncomingMessage} Req @typedef {import('node:http').ServerResponse} Res */

/** The body as text; undefined: larger than `max`. @param {Req} req @param {number} [max] */
export async function readBody(req, max = MAX_BODY) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

/** A JSON body, or undefined. @param {Req} req @param {number} [max] @returns {Promise<any>} */
export async function readJson(req, max) {
  const body = await readBody(req, max);
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** @param {Res} res @param {number} status @param {unknown} body @param {Record<string, string | string[]>} [headers] */
export const json = (res, status, body, headers = {}) =>
  void res.writeHead(status, { 'content-type': 'application/json', ...NO_STORE, ...headers }).end(JSON.stringify(body));

/** @param {Res} res @param {number} status @param {string} body @param {Record<string, string | string[]>} [headers] */
export const text = (res, status, body, headers = {}) => void res.writeHead(status, { 'content-type': 'text/plain;charset=UTF-8', ...headers }).end(body);

/** @param {Res} res @param {number} status @param {string} body @param {Record<string, string | string[]>} [headers] */
export const html = (res, status, body, headers = {}) =>
  void res
    .writeHead(status, {
      'content-type': 'text/html;charset=UTF-8',
      ...NO_STORE,
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'; default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:",
      ...headers,
    })
    .end(body);

/** @param {Res} res @param {string} to @param {Record<string, string | undefined>} [params] @param {Record<string, string | string[]>} [headers] */
export function redirect(res, to, params = {}, headers = {}) {
  const url = new URL(to);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  res.writeHead(302, { location: url.href, ...NO_STORE, ...headers }).end();
}

/** The request's cookies; a value that isn't URI-encoded is dropped. @param {Req} req @returns {Record<string, string>} */
export const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(/;\s*/)
      .filter(Boolean)
      .flatMap((pair) => {
        try {
          return [[pair.slice(0, pair.indexOf('=')), decodeURIComponent(pair.slice(pair.indexOf('=') + 1))]];
        } catch {
          return [];
        }
      })
  );

/** A `__Host-` style cookie. @param {string} name @param {string} value @param {number} maxAge seconds (0: delete) */
export const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

/** A browser POST from our own pages (CSRF): its Origin is ours. @param {Req} req @param {string} origin */
export const sameOrigin = (req, origin) => req.headers.origin === origin;

/** A form body. @param {Req} req */
export const readForm = async (req) => new URLSearchParams((await readBody(req)) ?? '');

/** CORS for OAuth and MCP endpoints (bearer tokens, no cookies, so any origin). @param {Req} req @param {boolean} [preflight] */
export function cors(req, preflight = true) {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-expose-headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
    vary: 'Origin',
    ...(preflight && {
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
      'access-control-max-age': '86400',
    }),
  };
}
