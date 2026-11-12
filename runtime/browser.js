// Browser engine: Paper's web editor in headless Chromium, its MCP handlers called in the page.
// Same approach as src/editor/host.js (copied, not imported: the runtime ships as its own image).
import { chromium } from 'playwright';
import { CHROMIUM_ARGS, engineError, meterMock, paperCookies, parseFileId, webmcpStub } from './paper.js';

const APP = 'https://app.paper.design';
const API = 'https://api.paper.design';
const READY_TIMEOUT_MS = 30_000;

/** @param {unknown} err */
const isNavigationError = (err) =>
  /context was destroyed|Target closed|Target crashed|frame was detached|Navigation/.test(
    String(err instanceof Error ? err.message : err),
  );

/**
 * GET /auth/me with the context's cookies. 200 = signed in, 401 = not.
 * @param {import('playwright').BrowserContext} context @param {number} [timeout]
 * @returns {Promise<{ status: number | null, user: { id: string, email: string, name?: string } | null }>}
 */
export async function whoAmI(context, timeout = 15_000) {
  try {
    const res = await context.request.get(`${API}/auth/me`, { headers: { origin: APP, referer: `${APP}/` }, timeout });
    if (res.status() !== 200) return { status: res.status(), user: null };
    const user = (await res.json().catch(() => null))?.user;
    if (typeof user?.id !== 'string') return { status: 200, user: null };
    return {
      status: 200,
      user: { id: user.id, email: String(user.email ?? ''), ...(user.name && { name: String(user.name) }) },
    };
  } catch {
    return { status: null, user: null };
  }
}

/**
 * @param {{ session: import('./paper.js').Session, log: import('./paper.js').Log }} options
 * @returns {Promise<import('./server.js').Engine>}
 */
export async function createBrowserEngine({ session, log }) {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(paperCookies(session.cookies));
    if ((await whoAmI(context)).status === 401) throw engineError('auth', 'Paper session expired. Sign in again.');
    await context.addInitScript(webmcpStub);
    await context.addInitScript(meterMock);
    log.warn('browser: /meter/balance responses are synthetic (mcpCap 10000)');
    const page = await context.newPage();
    /** @type {string | null} */
    let currentFileId = null;

    // Signed out, Paper bounces to WorkOS (login.paper.design / auth.paper.design) or an /auth/* route.
    const authBounce = () => {
      try {
        const url = new URL(page.url());
        return (
          url.hostname !== 'app.paper.design' &&
          (/^(login|auth)\./.test(url.hostname) ||
            url.hostname.endsWith('.workos.com') ||
            url.pathname.startsWith('/auth/'))
        );
      } catch {
        return false;
      }
    };
    const signedOut = () => engineError('auth', 'Paper session expired. Sign in again.');

    /** @param {string | null} fileId */
    async function openFile(fileId) {
      log.info(`browser: opening ${fileId ? 'file' : 'home'}`);
      await page.goto(fileId ? `${APP}/file/${fileId}` : `${APP}/`, { waitUntil: 'domcontentloaded' }).catch((err) => {
        if (!isNavigationError(err)) throw err;
      });
      // Wait for the URL to settle: Paper defines its handlers a beat before redirecting a signed-out visitor.
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let last = page.url();
      let stableSince = Date.now();
      while (Date.now() < deadline && Date.now() - stableSince < 1500) {
        if (authBounce()) throw signedOut();
        if (page.url() !== last) ((last = page.url()), (stableSince = Date.now()));
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
          .evaluate(async () => {
            const w = /** @type {any} */ (window);
            if (w.resolveMCPHandlers === undefined) return 'pending';
            return (await w.resolveMCPHandlers.catch(() => null)) ? 'ready' : 'null';
          })
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

    /** @param {string} method @param {unknown[]} args @returns {Promise<any>} */
    async function callHandler(method, args) {
      const evaluate = () =>
        page.evaluate(
          async ({ method, args }) => {
            const handlers = await /** @type {any} */ (window).resolveMCPHandlers;
            if (typeof handlers?.[method] !== 'function')
              return { __paperMcp: `${method} not available in this Paper build` };
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
      if (result && typeof result === 'object' && '__paperMcp' in result) {
        throw engineError('internal', String(result.__paperMcp));
      }
      return result;
    }

    /**
     * A failure may mean Paper stopped accepting the session mid-call.
     * @param {unknown} err @returns {Promise<never>}
     */
    async function rethrow(err) {
      if (/** @type {any} */ (err)?.code !== 'auth' && (await whoAmI(context)).status === 401) throw signedOut();
      throw err;
    }

    await openFile(null);

    return {
      async catalog(clientInfo) {
        const { tools, instructions } = await callHandler('getMCPServerConfig', [clientInfo, true]).catch(rethrow);
        return { tools, instructions: instructions ?? '' };
      },
      async call({ tool, args, agentId, clientInfo }) {
        try {
          const fileId = parseFileId(args.fileId);
          if (fileId && fileId !== currentFileId) await openFile(fileId);
          const result = await callHandler('handleToolCall', [agentId, tool, args, clientInfo]);
          if (result?.isError && (await whoAmI(context)).status === 401) throw signedOut();
          return result;
        } catch (err) {
          return rethrow(err);
        }
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
