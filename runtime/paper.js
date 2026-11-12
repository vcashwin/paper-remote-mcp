// Facts about Paper shared by the runtime's engines and the Worker (remote/worker.js imports this file too, so it
// stays dependency-free and platform-neutral).

const FILE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A Paper file id from a bare id, a `/file/<id>` route or a full URL @param {unknown} raw @returns {string | null} */
export function parseFileId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (FILE_ID_RE.test(value)) return value;
  const match = value.match(/\/file\/([^/?#]+)/);
  return match && FILE_ID_RE.test(match[1]) ? match[1] : null;
}

const SESSION_HOSTS = new Set([
  'paper.design',
  'app.paper.design',
  'api.paper.design',
  'sync.paper.design',
  'workers.paper.design',
]);
const ANALYTICS = /^(ph_|__cf_bm$|_cfuvid$|_dd_s$)/;

/**
 * A Paper session: the app's cookies (its sealed session cookie has a random-looking name), without AuthKit's
 * login.* / auth*.paper.design cookies or analytics.
 * @template {{ name: string, domain: string }} C @param {C[]} cookies @returns {C[]}
 */
export const paperCookies = (cookies) =>
  cookies.filter(
    (c) =>
      (c.domain.startsWith('.') ? c.domain === '.paper.design' : SESSION_HOSTS.has(c.domain)) &&
      !ANALYTICS.test(c.name),
  );

/** The `Cookie` header Paper's API expects from these cookies @param {{ name: string, value: string }[]} cookies */
export const cookieHeader = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

/** @typedef {{ name: string, value: string, domain: string, path?: string, expires?: number, httpOnly?: boolean,
 *   secure?: boolean, sameSite?: 'Strict' | 'Lax' | 'None' }} Cookie  a Playwright cookie */
/** @typedef {{ cookies: Cookie[] }} Session */
/** @typedef {{ name: string, transport?: string }} ClientInfo */
/** @typedef {{ debug(s: string): void, info(s: string): void, warn(s: string): void, error(s: string): void }} Log */

/**
 * An error carrying one of the container API's codes ('auth' | 'limit' | 'bad_request' | 'internal') or an engine
 * code the runtime handles itself ('unavailable': the call never reached Paper; 'timeout').
 * @param {string} code @param {string} message @returns {Error & { code: string }}
 */
export const engineError = (code, message) => Object.assign(new Error(message), { code });

/** Chromium flags for Paper's editor and sign-in page (containers have a small /dev/shm). */
export const CHROMIUM_ARGS = ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'];

/**
 * Paper builds `window.resolveMCPHandlers` only for Electron or a WebMCP-capable browser
 * (`navigator.modelContext.registerTool`). This no-op stub flips it into WebMCP mode with normal cookie auth.
 * Self-contained: Playwright serialises it into the page.
 */
export function webmcpStub() {
  const nav = /** @type {any} */ (navigator);
  if (nav.modelContext?.registerTool) return;
  const modelContext = { registerTool: () => () => {}, unregisterTool() {}, provideContext() {} };
  try {
    Object.defineProperty(nav, 'modelContext', { value: modelContext, configurable: true });
  } catch {}
}
