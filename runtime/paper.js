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

/**
 * Synthetic meter endpoints for Paper's bundle. Paper's tool wrapper gates metered tools on `/meter/balance` and
 * reports usage to `/meter/record-mcp` on every call. This answers the balance with an always-full weekly
 * allowance (`mcpCap: 10000`) so the client-side weekly-limit gate never trips, and acknowledges `record-mcp`
 * locally so usage is never reported to Paper.
 * Self-contained: Playwright serialises it into the page; the lite engine runs it after registering happy-dom.
 */
export function meterMock() {
  const w = /** @type {any} */ (window);
  const g = /** @type {any} */ (globalThis);
  w.__apiMockerEnabled = true;
  const serverStartTime = (w.__serverStartTime ??= Date.now() + 5 * 60 * 1000);
  const clientStartTime = (w.__clientStartTime ??= Date.now());
  w.__apiMocker ??= {};

  const getMockBody = () => ({
    serverClock: serverStartTime + (Date.now() - clientStartTime),
    manaUsed: 0,
    manaCap: 20,
    mcpUsed: 1,
    mcpCap: 10000,
  });
  /** The synthetic response body for a meter URL, or null for anything else. @param {unknown} url */
  const mockBodyFor = (url) => {
    if (!w.__apiMockerEnabled) return null;
    const u = String(url || '');
    if (u.includes('/meter/balance')) return JSON.stringify(getMockBody());
    if (u.includes('/meter/record-mcp')) return '{"ok":true}';
    return null;
  };
  /** @param {string} type @param {unknown} url */
  const logMock = (type, url) => console.info(`[${type}] MOCKED:`, url);

  // Wrap window.fetch and globalThis.fetch: some runtimes (happy-dom's global registrator) snapshot fetch onto
  // globalThis, so wrapping only window would let the bundle's bare fetch() calls through. The wrapper carries its
  // original, so a second pass over an already wrapped fetch is a no-op.
  /** @param {any} t */
  const patchFetch = (t) => {
    if (typeof t?.fetch !== 'function' || t.fetch.__apiMockerOriginal) return;
    const original = t.fetch;
    const wrapped = /** @type {any} */ (
      async (/** @type {unknown[]} */ ...args) => {
        const input = args[0];
        const url =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : input instanceof URL
                ? input.href
                : '';
        const body = mockBodyFor(url);
        if (body !== null) {
          logMock('fetch', url);
          return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return original.apply(t, args);
      }
    );
    wrapped.__apiMockerOriginal = original;
    t.fetch = wrapped;
  };
  patchFetch(w);
  if (g !== w) patchFetch(g);

  if (!w.__apiMocker.originalXHROpen) {
    w.__apiMocker.originalXHROpen = XMLHttpRequest.prototype.open;
    w.__apiMocker.originalXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (/** @type {string} */ method, /** @type {string | URL} */ url) {
      const self = /** @type {any} */ (this);
      self.__apiMockerUrl = url;
      return w.__apiMocker.originalXHROpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const self = /** @type {any} */ (this);
      const body = mockBodyFor(self.__apiMockerUrl);
      if (body !== null) {
        logMock('xhr', self.__apiMockerUrl);
        Object.defineProperties(self, {
          readyState: { configurable: true, value: 4 },
          status: { configurable: true, value: 200 },
          responseText: { configurable: true, value: body },
          response: { configurable: true, value: body },
        });
        setTimeout(() => {
          self.dispatchEvent(new Event('readystatechange'));
          self.dispatchEvent(new Event('load'));
          self.dispatchEvent(new Event('loadend'));
        }, 0);
        return;
      }
      return w.__apiMocker.originalXHRSend.apply(this, arguments);
    };
  }

  // Telemetry often goes out via sendBeacon (it survives page unload): acknowledge it without sending anything.
  const nav = /** @type {any} */ (navigator);
  if (typeof nav.sendBeacon === 'function' && !w.__apiMocker.originalBeacon) {
    w.__apiMocker.originalBeacon = nav.sendBeacon;
    nav.sendBeacon = function (/** @type {string | URL} */ url, /** @type {unknown} */ data) {
      if (mockBodyFor(url) !== null) {
        logMock('beacon', url);
        return true;
      }
      return w.__apiMocker.originalBeacon.call(nav, url, data);
    };
  }

  w.__apiMocker.enable = () => {
    w.__apiMockerEnabled = true;
  };
  w.__apiMocker.disable = () => {
    w.__apiMockerEnabled = false;
  };
  w.__apiMocker.reset = () => {
    for (const t of [w, g]) {
      if (t.fetch?.__apiMockerOriginal) t.fetch = t.fetch.__apiMockerOriginal;
    }
    if (w.__apiMocker.originalXHROpen) {
      XMLHttpRequest.prototype.open = w.__apiMocker.originalXHROpen;
      XMLHttpRequest.prototype.send = w.__apiMocker.originalXHRSend;
    }
    if (w.__apiMocker.originalBeacon) nav.sendBeacon = w.__apiMocker.originalBeacon;
    delete w.__apiMocker;
    console.info('API mocker reset');
  };
  console.info('Meter mock installed: /meter/balance is synthetic (mcpCap 10000), /meter/record-mcp is dropped');
}
