import { resolveEnv } from "../config.js";
import { checkSession, profileDir } from "../auth/session.js";
import { launchContext } from "../browser.js";
import { log } from "../log.js";

/**
 * Thrown when the stored browser profile is not signed in. The CLI turns this
 * into a friendly "run `paper-remote-mcp login`" message.
 */
export class AuthRequiredError extends Error {
  constructor(
    message = "Not signed in to Paper. Run `paper-remote-mcp login` first.",
  ) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

// Crockford base32, 26 chars — Paper file ids (mirrors the web client's MUt regex).
const FILE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * True when an error is just the page navigating out from under an `evaluate`
 * (redirect, reload, SPA transition) rather than a real failure.
 * @param {unknown} err
 */
function isNavigationError(err) {
  const message = String(err instanceof Error ? err.message : err);
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("context was destroyed") ||
    message.includes("Target closed") ||
    message.includes("Target crashed") ||
    message.includes("frame was detached") ||
    message.includes("Navigation")
  );
}

/**
 * Pull a Paper file id out of a raw id, a `/file/<id>` route, or a full URL.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function parseFileId(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (FILE_ID_RE.test(value)) return value;
  const match = value.match(/\/file\/([^/?#]+)/);
  if (match && FILE_ID_RE.test(match[1])) return match[1];
  return null;
}

/**
 * The init script that makes `app.paper.design` build `window.mcpHandlers` in a
 * plain browser. Paper's bootstrap only wires the handlers up when it detects
 * the Electron desktop shell OR a WebMCP-capable browser:
 *
 *     const Rae = NUt();                  // WebMCP supported?
 *     (bn || Rae) && (window.resolveMCPHandlers = ...)
 *
 * where NUt() just checks for `navigator.modelContext.registerTool`. We provide
 * a no-op stub for that API, which flips Paper into WebMCP mode — handlers get
 * built, and (unlike faking the desktop shell) the app keeps using normal web
 * cookie auth with no Electron/ipcRenderer dependencies.
 */
function webmcpStub() {
  if (
    globalThis.navigator &&
    navigator.modelContext &&
    typeof navigator.modelContext.registerTool === "function"
  ) {
    return;
  }
  const modelContext = {
    registerTool() {
      return () => {};
    },
    unregisterTool() {},
    provideContext() {},
  };
  try {
    Object.defineProperty(navigator, "modelContext", {
      value: modelContext,
      configurable: true,
    });
  } catch {
    try {
      // @ts-ignore - assigning a non-standard property
      navigator.modelContext = modelContext;
    } catch {
      /* give up silently; handlers just won't initialise and host.ready() will report it */
    }
  }
}

function mandatoryInstallScript() {
  const mockUrlPart = "/meter/balance";
  window.__apiMockerEnabled = true;
  const serverStartTime = (window.__serverStartTime ??=
    Date.now() + 5 * 60 * 1000);
  const clientStartTime = (window.__clientStartTime ??= Date.now());
  window.__apiMocker ??= {};

  const getMockBody = () => ({
    serverClock: serverStartTime + (Date.now() - clientStartTime),
    manaUsed: 0,
    manaCap: 20,
    mcpUsed: 1,
    mcpCap: 10000,
  });
  /** @param {unknown} url */
  const shouldMock = (url) =>
    window.__apiMockerEnabled && String(url || "").includes(mockUrlPart);
  /** @param {string} type @param {unknown} url */
  const logMock = (type, url) => console.info(`[${type}] MOCKED:`, url);

  if (!window.__apiMocker.originalFetch && window.fetch) {
    window.__apiMocker.originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const input = args[0];
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : "";
      if (shouldMock(url)) {
        logMock("fetch", url);
        return new Response(JSON.stringify(getMockBody()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return window.__apiMocker.originalFetch(...args);
    };
  }

  if (!window.__apiMocker.originalXHROpen) {
    window.__apiMocker.originalXHROpen = XMLHttpRequest.prototype.open;
    window.__apiMocker.originalXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (
      /** @type {string} */ method,
      /** @type {string | URL} */ url,
    ) {
      this.__apiMockerUrl = url;
      return window.__apiMocker.originalXHROpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (shouldMock(this.__apiMockerUrl)) {
        logMock("xhr", this.__apiMockerUrl);
        const body = JSON.stringify(getMockBody());
        Object.defineProperties(this, {
          readyState: { configurable: true, value: 4 },
          status: { configurable: true, value: 200 },
          responseText: { configurable: true, value: body },
          response: { configurable: true, value: body },
        });
        setTimeout(() => {
          this.dispatchEvent(new Event("readystatechange"));
          this.dispatchEvent(new Event("load"));
          this.dispatchEvent(new Event("loadend"));
        }, 0);
        return;
      }
      return window.__apiMocker.originalXHRSend.apply(this, arguments);
    };
  }

  window.__apiMocker.enable = () => {
    window.__apiMockerEnabled = true;
  };
  window.__apiMocker.disable = () => {
    window.__apiMockerEnabled = false;
  };
  window.__apiMocker.reset = () => {
    if (window.__apiMocker.originalFetch)
      window.fetch = window.__apiMocker.originalFetch;
    if (window.__apiMocker.originalXHROpen) {
      XMLHttpRequest.prototype.open = window.__apiMocker.originalXHROpen;
      XMLHttpRequest.prototype.send = window.__apiMocker.originalXHRSend;
    }
    delete window.__apiMocker;
    console.info("API mocker reset");
  };
  console.info("Meter installed");
}

/**
 * @typedef {Object} HostOptions
 * @property {string} [env]        Paper environment key (default: production)
 * @property {boolean} [headless]  Run the browser headless (default: true)
 * @property {string} [fileId]     File id/URL to open on start
 * @property {string} [profile]    Override profile base directory
 * @property {number} [readyTimeoutMs]
 * @property {import('playwright').BrowserContext} [context]  Run in this context (remote mode: one per account) instead of launching the profile
 */

/**
 * Launches a browser, signs in from the stored profile, opens the Paper editor,
 * and exposes its MCP handlers. This is the headless equivalent of what Paper
 * Desktop does with an Electron window + the webContents bridge.
 *
 * @param {HostOptions} [options]
 */
export async function createEditorHost(options = {}) {
  const env = resolveEnv(options.env);
  const headless = options.headless !== false;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;

  const launchProfile = () => {
    const dir = profileDir(env.key, options.profile);
    log.info(
      `Launching browser (env=${env.key}, headless=${headless}) using profile ${dir}`,
    );
    return launchContext(dir, { headless });
  };
  const context = options.context ?? (await launchProfile());
  await context.addInitScript(webmcpStub);
  await context.addInitScript(mandatoryInstallScript);
  log.warn("/meter/balance responses are synthetic.");

  const page = context.pages()[0] ?? (await context.newPage());
  page.on("console", (msg) => log.debug(`[page:${msg.type()}] ${msg.text()}`));

  /** @type {string | null} */
  let currentFileId = null;

  /** @param {string} [fileId] */
  async function openFile(fileId) {
    const target = fileId ? `${env.app}/file/${fileId}` : `${env.app}/`;
    log.info(`Navigating to ${target}`);
    await page.goto(target, { waitUntil: "domcontentloaded" }).catch((err) => {
      // A client-side redirect (e.g. to the sign-in page) can abort the initial
      // navigation; that's fine — the settle step below sorts out the end state.
      if (!isNavigationError(err)) throw err;
    });
    // Paper builds its handlers during bootstrap, but an unauthenticated client
    // redirects to sign-in a beat later. Wait for the URL to settle first, so we
    // don't mistake that transient pre-redirect state for "ready".
    await waitForSettledAuth();
    await waitForReady();
    currentFileId = fileId ?? parseFileId(page.url());
  }

  /**
   * Wait until the page stops navigating. Throws AuthRequiredError the moment it
   * lands on Paper's sign-in page.
   */
  async function waitForSettledAuth() {
    const deadline = Date.now() + readyTimeoutMs;
    let last = page.url();
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      if (currentNav().authBounce) throw new AuthRequiredError();
      const now = page.url();
      if (now !== last) {
        last = now;
        stableSince = Date.now();
      } else if (Date.now() - stableSince > 1500) {
        return; // settled on a non-auth URL
      }
      await page.waitForTimeout(200);
    }
    if (currentNav().authBounce) throw new AuthRequiredError();
  }

  const appHost = new URL(env.app).hostname;

  /** Current page URL, parsed, plus whether it's Paper's sign-in bounce. */
  function currentNav() {
    try {
      const url = new URL(page.url());
      const host = url.hostname;
      // Unauthenticated, Paper bounces to the hosted WorkOS sign-in
      // (e.g. login.paper.design / auth.paper.design) or an /auth/* route.
      const authBounce =
        host !== appHost &&
        (host.startsWith("login.") ||
          host.startsWith("auth.") ||
          host.endsWith(".workos.com") ||
          url.pathname.startsWith("/auth/"));
      return { url, authBounce };
    } catch {
      return { url: null, authBounce: false };
    }
  }

  /**
   * Wait until Paper's handlers are built, tolerating the redirects an
   * unauthenticated (or just-loading) SPA does. If we land on the sign-in page,
   * surface AuthRequiredError instead of spinning.
   */
  async function waitForReady() {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (currentNav().authBounce) throw new AuthRequiredError();

      /** @type {string} */
      let state;
      try {
        state = await page.evaluate(async () => {
          if (typeof window.resolveMCPHandlers === "undefined")
            return "pending";
          try {
            const handlers = await window.resolveMCPHandlers;
            return handlers ? "ready" : "null";
          } catch {
            return "error";
          }
        });
      } catch (err) {
        // Mid-navigation teardown — wait for the new document and retry.
        if (isNavigationError(err)) {
          await page.waitForTimeout(250);
          continue;
        }
        throw err;
      }

      if (state === "ready") return;
      await page.waitForTimeout(200);
    }

    // Timed out — give the clearest possible reason.
    if (currentNav().authBounce) throw new AuthRequiredError();
    throw new Error(
      "Paper MCP handlers never initialised. The page may not be the editor, or the WebMCP shim failed. " +
        "Try `paper-remote-mcp doctor`, or re-run `paper-remote-mcp login`.",
    );
  }

  /**
   * Mirror of Paper Desktop's bridge call: resolve the renderer handlers and
   * invoke one method with JSON-serialisable args.
   * @param {string} method
   * @param {unknown[]} args
   */
  async function callHandler(method, args) {
    const evaluate = () =>
      page.evaluate(
        async ({ method, args }) => {
          const handlers = await window.resolveMCPHandlers;
          if (!handlers) return { __paperMcp: "handlers_not_found" };
          // @ts-ignore - dynamic method access
          if (typeof handlers[method] !== "function")
            return { __paperMcp: "method_not_found" };
          // @ts-ignore - dynamic call
          return await handlers[method](...args);
        },
        { method, args },
      );

    let result;
    try {
      result = await evaluate();
    } catch (err) {
      // A navigation (e.g. a file switch still settling) can destroy the context.
      if (!isNavigationError(err)) throw err;
      await waitForReady();
      result = await evaluate();
    }
    if (result && typeof result === "object" && "__paperMcp" in result) {
      if (result.__paperMcp === "handlers_not_found") {
        throw new Error(
          "Paper handlers not available (is the editor loaded / are you signed in?).",
        );
      }
      if (result.__paperMcp === "method_not_found") {
        throw new Error(
          `Tool method "${method}" does not exist in this Paper build.`,
        );
      }
    }
    return result;
  }

  return {
    page,
    context,
    env,
    get fileId() {
      return currentFileId;
    },

    async start() {
      // Authoritative check first: the page alone can look ready for a moment
      // before Paper redirects a signed-out visitor to the sign-in page.
      const session = await checkSession(context, env);
      if (!session.signedIn) {
        throw new AuthRequiredError(
          `Not signed in to Paper (API /auth/me → ${session.status ?? "no response"}). Run \`paper-remote-mcp login\` first.`,
        );
      }
      await openFile(
        options.fileId ? (parseFileId(options.fileId) ?? undefined) : undefined,
      );
    },

    /**
     * If a tool call targets a different file than the one currently open,
     * navigate there first. This reproduces the desktop's per-file routing with
     * a single page (WebMCP tools only act on the open file).
     * @param {unknown} rawFileId
     */
    async ensureFile(rawFileId) {
      const fileId = parseFileId(rawFileId);
      if (!fileId || fileId === currentFileId) return;
      await openFile(fileId);
    },

    /**
     * Fetch the live tool catalog + instructions from the renderer.
     * @param {{ name: string, transport?: string }} clientInfo
     * @returns {Promise<{ tools: any[], instructions?: string }>}
     */
    async getConfig(clientInfo) {
      return /** @type {any} */ (
        await callHandler("getMCPServerConfig", [clientInfo, true])
      );
    },

    /**
     * Run one tool call against the open editor.
     * @param {string} agentId
     * @param {string} name
     * @param {Record<string, unknown>} args
     * @param {{ name: string, transport?: string }} clientInfo
     */
    async handleToolCall(agentId, name, args, clientInfo) {
      return await callHandler("handleToolCall", [
        agentId,
        name,
        args,
        clientInfo,
      ]);
    },

    /** @param {string} agentId */
    async removeAgent(agentId) {
      try {
        await callHandler("removeAgent", [agentId]);
      } catch (err) {
        log.debug("removeAgent failed (non-fatal):", err);
      }
    },

    async close() {
      await context.close().catch(() => {});
    },
  };
}
