// Browser engine: Paper's web editor in headless Chromium, its MCP handlers called in the page.
// Same approach as src/editor/host.js (copied, not imported: the runtime ships as its own image).
import { chromium } from 'playwright';

const APP = 'https://app.paper.design';
const API = 'https://api.paper.design';
const READY_TIMEOUT_MS = 30_000;
// Crockford base32, 26 chars: Paper file ids.
const FILE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** @param {'auth' | 'limit' | 'internal'} code @param {string} message */
export const engineError = (code, message) => Object.assign(new Error(message), { code });

/** @param {unknown} raw @returns {string | null} */
export function parseFileId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (FILE_ID_RE.test(value)) return value;
  const match = value.match(/\/file\/([^/?#]+)/);
  return match && FILE_ID_RE.test(match[1]) ? match[1] : null;
}

/** @param {unknown} err */
const isNavigationError = (err) =>
  /context was destroyed|Target closed|Target crashed|frame was detached|Navigation/.test(String(err instanceof Error ? err.message : err));

const SESSION_HOSTS = new Set(['paper.design', 'app.paper.design', 'api.paper.design', 'sync.paper.design', 'workers.paper.design']);
const ANALYTICS = /^(ph_|__cf_bm$|_cfuvid$|_dd_s$)/;
/**
 * A Paper session: the app's cookies (its sealed session cookie has a random-looking name), without AuthKit's
 * login.* / auth*.paper.design cookies or analytics.
 * @template {{ name: string, domain: string }} C @param {C[]} cookies @returns {C[]}
 */
export const paperCookies = (cookies) =>
  cookies.filter((c) => (c.domain.startsWith('.') ? c.domain === '.paper.design' : SESSION_HOSTS.has(c.domain)) && !ANALYTICS.test(c.name));

/**
 * Paper builds `window.resolveMCPHandlers` only for Electron or a WebMCP-capable browser
 * (`navigator.modelContext.registerTool`). A no-op stub flips it into WebMCP mode with normal cookie auth.
 */
function webmcpStub() {
  if (navigator.modelContext?.registerTool) return;
  const modelContext = { registerTool: () => () => {}, unregisterTool() {}, provideContext() {} };
  try {
    Object.defineProperty(navigator, 'modelContext', { value: modelContext, configurable: true });
  } catch {}
}

/**
 * GET /auth/me with the context's cookies. 200 = signed in, 401 = not.
 * @param {import('playwright').BrowserContext} context
 */
export async function whoAmI(context) {
  try {
    const res = await context.request.get(`${API}/auth/me`, { headers: { origin: APP, referer: `${APP}/` }, timeout: 15_000 });
    if (res.status() !== 200) return { status: res.status(), user: null };
    const user = (await res.json().catch(() => null))?.user;
    return { status: 200, user: typeof user?.id === 'string' ? { id: user.id, email: String(user.email ?? ''), ...(user.name && { name: String(user.name) }) } : null };
  } catch {
    return { status: null, user: null };
  }
}

/**
 * @param {{ session: { cookies: any[] }, log: (...a: unknown[]) => void }} options
 */
export async function createBrowserEngine({ session, log }) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(paperCookies(session.cookies));
    if ((await whoAmI(context)).status === 401) throw engineError('auth', 'Paper session expired. Sign in again.');
    await context.addInitScript(webmcpStub);
    const page = await context.newPage();
    /** @type {string | null} */
    let currentFileId = null;

    // Signed out, Paper bounces to WorkOS (login.paper.design / auth.paper.design) or an /auth/* route.
    const authBounce = () => {
      try {
        const url = new URL(page.url());
        return url.hostname !== 'app.paper.design' && (/^(login|auth)\./.test(url.hostname) || url.hostname.endsWith('.workos.com') || url.pathname.startsWith('/auth/'));
      } catch {
        return false;
      }
    };
    const signedOut = () => engineError('auth', 'Paper session expired. Sign in again.');

    /** @param {string | null} fileId */
    async function openFile(fileId) {
      log(`browser: opening ${fileId ? 'file' : 'home'}`);
      await page.goto(fileId ? `${APP}/file/${fileId}` : `${APP}/`, { waitUntil: 'domcontentloaded' }).catch((err) => {
        if (!isNavigationError(err)) throw err;
      });
      // Wait for the URL to settle: Paper defines its handlers a beat before redirecting a signed-out visitor.
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let last = page.url();
      let stableSince = Date.now();
      while (Date.now() < deadline && Date.now() - stableSince < 1500) {
        if (authBounce()) throw signedOut();
        if (page.url() !== last) (last = page.url()), (stableSince = Date.now());
        await page.waitForTimeout(200);
      }
      await waitForHandlers();
      currentFileId = fileId ?? parseFileId(page.url());
    }

    async function waitForHandlers() {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (authBounce()) throw signedOut();
        const state = await page
          .evaluate(async () => (window.resolveMCPHandlers === undefined ? 'pending' : (await window.resolveMCPHandlers.catch(() => null)) ? 'ready' : 'null'))
          .catch((err) => {
            if (isNavigationError(err)) return 'pending';
            throw err;
          });
        if (state === 'ready') return;
        await page.waitForTimeout(200);
      }
      if (authBounce()) throw signedOut();
      throw engineError('internal', 'Paper MCP handlers never initialised in the browser.');
    }

    /** @param {string} method @param {unknown[]} args */
    async function callHandler(method, args) {
      const evaluate = () =>
        page.evaluate(
          async ({ method, args }) => {
            const handlers = await window.resolveMCPHandlers;
            if (typeof handlers?.[method] !== 'function') return { __paperMcp: `${method} not available in this Paper build` };
            return await handlers[method](...args);
          },
          { method, args },
        );
      let result;
      try {
        result = await evaluate();
      } catch (err) {
        if (!isNavigationError(err)) throw err;
        await waitForHandlers();
        result = await evaluate();
      }
      if (result && typeof result === 'object' && '__paperMcp' in result) throw engineError('internal', String(result.__paperMcp));
      return result;
    }

    /** A failure may mean Paper stopped accepting the session mid-call. @param {unknown} err */
    async function rethrow(err) {
      if (/** @type {any} */ (err)?.code !== 'auth' && (await whoAmI(context)).status === 401) throw signedOut();
      throw err;
    }

    await openFile(null);

    return {
      /** @param {{ name: string, transport?: string }} clientInfo */
      async catalog(clientInfo) {
        const { tools, instructions } = /** @type {any} */ (await callHandler('getMCPServerConfig', [clientInfo, true]).catch(rethrow));
        return { tools, instructions: instructions ?? '' };
      },
      /** @param {{ tool: string, args: Record<string, unknown>, agentId: string, clientInfo: { name: string, transport?: string } }} call */
      async call({ tool, args, agentId, clientInfo }) {
        try {
          const fileId = parseFileId(args.fileId);
          if (fileId && fileId !== currentFileId) await openFile(fileId);
          const result = /** @type {any} */ (await callHandler('handleToolCall', [agentId, tool, args, clientInfo]));
          if (result?.isError && (await whoAmI(context)).status === 401) throw signedOut();
          return result;
        } catch (err) {
          return rethrow(err);
        }
      },
      async session() {
        return { cookies: paperCookies(await context.cookies()) };
      },
      async close() {
        await browser.close().catch(() => {});
      },
    };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}
