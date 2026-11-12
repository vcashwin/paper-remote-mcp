// Lite engine: Paper's own web client (live bundle from app.paper.design) running in Node with happy-dom as the DOM,
// so Paper's MCPHandlers chunk serves tool calls without Chromium. See docs/remote-runtime.md.
//
// Each engine is a child process (this file run with --lite-child): Paper's bundle runs as native Node ES modules
// (fetched over https by a module loader hook) against happy-dom globals. A child per engine keeps globals isolated
// and makes close()/reload a process exit. Parent and child talk over IPC.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = "https://app.paper.design";
const API = "https://api.paper.design";

/**
 * Tools routed to the lite engine. Evidence (2026-11-13, Paper client build 1794118143132):
 *   live  = run through this engine against the real service and matched Paper's browser output.
 *   code  = handler reads/writes only the document model or Paper's API (no DOM layout, raster, fonts or image decode);
 *           not run live yet because the account's weekly MCP quota was exhausted. runtime/live-matrix.mjs confirms.
 * Size caveat: nodes are never measured here, so width/height/x/y of layout-dependent nodes (fit-content, flex
 * children) come back null, exactly as Paper reports nodes on an inactive page (documented in get_basic_info's tool
 * description). Fixed-px sizes are reported. Drop the size-reporting reads from this set if null is not acceptable.
 * Not here: get_screenshot, export, export_combined_pdf, get_computed_styles, get_fill_image (raster/image decode),
 * write_html, set_text_content (HTML import, text layout), create_artboard, duplicate_nodes (place new artboards
 * around measured neighbours), get_font_family_info (font discovery), create_folder (untested: would create an
 * extra resource in the account).
 */
export const LITE_TOOLS = new Set([
  // live
  "get_guide",
  "get_basic_info", // live; layout-dependent sizes null (Scratchpad: 642x617 in browser, null here)
  // code: app scope (Paper API + team state)
  "list_resources",
  "create_file",
  "rename_resource",
  "archive_resources",
  "unarchive_resources",
  "move_resources",
  "open_file",
  // code: document model
  "create_page",
  "update_pages",
  "arrange_pages",
  "get_selection", // no user in this tab: always empty (same as the headless browser engine)
  "get_node_info", // sizes as get_basic_info
  "get_children",
  "get_tree_summary",
  "get_jsx",
  "find_nodes",
  "list_comment_threads",
  "get_comment_thread",
  "list_comment_thread_authors",
  "set_comment_thread_status",
  "delete_nodes",
  "rename_nodes",
  "update_styles",
  "move_nodes",
  "finish_working_on_nodes",
  "get_tokens",
  "create_tokens",
  "set_tokens",
]);

// Crockford base32, 26 chars (same as src/editor/host.js).
const FILE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** @param {unknown} raw */
export function parseFileId(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (FILE_ID_RE.test(value)) return value;
  const match = value.match(/\/file\/([^/?#]+)/);
  return match && FILE_ID_RE.test(match[1]) ? match[1] : null;
}

// Playwright cookie <-> happy-dom ICookie. Playwright marks domain cookies with a leading dot; host-only cookies
// (e.g. __Host-*) carry the bare host. happy-dom models host-only as domain "" plus originURL.
/** @param {any} c */
export function toHappyCookie(c) {
  const dot = c.domain.startsWith(".");
  const host = dot ? c.domain.slice(1) : c.domain;
  return {
    key: c.name,
    value: c.value,
    domain: dot ? host : "",
    originURL: new URL(`https://${host}/`),
    path: c.path || "/",
    expires: c.expires > 0 ? new Date(c.expires * 1000) : null,
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false,
    sameSite: c.sameSite || "Lax",
  };
}

/** @param {any} c */
export function toPlaywrightCookie(c) {
  return {
    name: c.key,
    value: c.value ?? "",
    domain: c.domain ? `.${c.domain}` : c.originURL.hostname,
    path: c.path || "/",
    expires: c.expires ? Math.floor(new Date(c.expires).getTime() / 1000) : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || "Lax",
  };
}

const PAPER_HOSTS = new Set(["paper.design", "app.paper.design", "api.paper.design", "sync.paper.design", "workers.paper.design"]);
const ANALYTICS = /^(ph_|__cf_bm$|_cfuvid$|_dd_s$)/;

/** The cookies Paper's app session needs: `.paper.design` (the sealed session) plus app/api/sync/workers hosts; no
 * AuthKit (login./auth*.) or analytics cookies. @param {any[]} cookies */
export function paperCookies(cookies) {
  return cookies.filter((c) => {
    const d = String(c.domain ?? "");
    return (d === ".paper.design" || PAPER_HOSTS.has(d.replace(/^\./, ""))) && !ANALYTICS.test(c.name);
  });
}

/** @param {{ cookies: any[] }} session */
function sessionKey(session) {
  return JSON.stringify(
    session.cookies.map((c) => [c.name, c.domain, c.path, c.value]).sort(),
  );
}

/**
 * Boot Paper's web client for one account in a child process.
 * Resolves once Paper's MCP handlers are built (signed in, root state loaded). Rejects with code 'auth' when
 * api.paper.design/auth/me says the session is invalid (also thrown by call() if Paper signs out mid-life).
 * Rejects with code 'unavailable' if the child exits, 'timeout' if a call never returns.
 * @param {{ session: { cookies: any[] }, log?: any, bootTimeoutMs?: number }} options
 */
export async function createLiteEngine({ session, log = console, bootTimeoutMs = 60_000 }) {
  let current = { cookies: paperCookies(session.cookies) };
  const child = fork(fileURLToPath(import.meta.url), ["--lite-child"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced",
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (s) => {
      for (const line of String(s).split("\n")) if (line.trim()) log.debug?.(`[lite] ${line.slice(0, 500)}`);
    });
  }

  let seq = 0;
  /** @type {Map<number, { resolve: Function, reject: Function }>} */
  const pending = new Map();
  let exitError = null;
  child.on("message", (/** @type {any} */ msg) => {
    if (msg.cookies) current = { cookies: msg.cookies };
    if (msg.stale) engine.stale = true;
    if (msg.log) log[msg.log.level]?.(`[lite] ${msg.log.text}`);
    const p = msg.id !== undefined && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
    else p.resolve(msg.result);
  });
  child.on("exit", (code, signal) => {
    exitError = Object.assign(new Error(`lite engine exited (${signal ?? code})`), { code: "unavailable" });
    for (const p of pending.values()) p.reject(exitError);
    pending.clear();
  });

  /** @param {string} op @param {any} payload @param {number} [timeoutMs] */
  function rpc(op, payload, timeoutMs = 120_000) {
    if (exitError) return Promise.reject(exitError);
    const id = seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`lite engine: ${op} timed out`), { code: "timeout" }));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.send({ id, op, ...payload });
    });
  }

  const engine = {
    pid: child.pid,
    /** True once Paper's sync server requires a newer client: close() and create a new engine. */
    stale: false,
    /** @param {{ name: string, transport?: string }} clientInfo */
    catalog: (clientInfo) => rpc("catalog", { clientInfo }),
    /** @param {{ tool: string, args?: any, agentId: string, clientInfo: { name: string, transport?: string } }} req */
    call: (req) => rpc("call", { tool: req.tool, args: req.args ?? {}, agentId: req.agentId, clientInfo: req.clientInfo }),
    session: () => current,
    /** Child's own stats (RSS etc.) for health/measurement. */
    stats: () => rpc("stats", {}),
    async close() {
      if (exitError) return;
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };

  try {
    await rpc("boot", { cookies: current.cookies }, bootTimeoutMs);
  } catch (err) {
    await engine.close();
    throw err;
  }
  return engine;
}

// ---------------------------------------------------------------------------------------------------------------
// Child process: Paper's bundle in happy-dom.

// Module loader hook: lets `import("https://app.paper.design/assets/x.js")` and the bundle's relative imports load
// straight from Paper's CDN (always the live release, which satisfies the sync server's minClient).
const HOOKS = `
export async function resolve(specifier, context, next) {
  const parent = context.parentURL || "";
  if (specifier.startsWith("https:")) return { url: specifier, shortCircuit: true, format: "module" };
  if (parent.startsWith("https:") && /^(\\.{1,2})?\\//.test(specifier))
    return { url: new URL(specifier, parent).href, shortCircuit: true, format: "module" };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (!url.startsWith("https:")) return next(url, context);
  if (!url.startsWith("${APP}/")) throw new Error("lite: refusing to load module from " + url);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("lite: " + res.status + " loading " + url);
      return { format: "module", source: await res.text(), shortCircuit: true };
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}`;

const FRAME_MS = 50; // ponytail: fixed 20fps rAF; lower if tool latency is frame-bound, raise if idle CPU matters more
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {() => any} fn @param {number} timeoutMs */
async function until(fn, timeoutMs, step = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

async function runChild() {
  const { register } = await import("node:module");
  register("data:text/javascript," + encodeURIComponent(HOOKS));
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  const { default: WindowBrowserContext } = await import("happy-dom/lib/window/WindowBrowserContext.js");

  /** @type {any} */ let handlers = null;
  /** @type {any} */ let jar = null;
  let lastCookies = "";

  const send = (msg) => process.send?.(msg);
  const relay = (level) => (...a) => send({ log: { level, text: a.map(String).join(" ").slice(0, 500) } });

  function syncCookies() {
    const cookies = paperCookies(jar.getCookies().map(toPlaywrightCookie));
    const key = sessionKey({ cookies });
    if (key !== lastCookies) {
      lastCookies = key;
      return cookies;
    }
    return undefined;
  }

  async function boot({ cookies }) {
    GlobalRegistrator.register({
      url: `${APP}/`,
      width: 1440,
      height: 900,
      settings: {
        handleDisabledFileLoadingAsSuccess: true, // CSS/classic scripts (analytics) are not loaded, but report load
        fetch: { disableSameOriginPolicy: true },
        navigation: { disableMainFrameNavigation: true },
        canvasAdapter: NULL_CANVAS,
        navigator: {
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        },
      },
    });
    const context = new WindowBrowserContext(window).getBrowserContext();
    jar = context.cookieContainer;
    // Paper sends its own If-None-Match on some API calls. happy-dom throws on a 304 it didn't cache itself, and the
    // throw happens inside its resolve, so that fetch never settles. Pass the 304 through like a browser does.
    const addToCache = context.responseCache.add.bind(context.responseCache);
    context.responseCache.add = (request, response) => {
      try {
        return addToCache(request, response);
      } catch {
        return null;
      }
    };
    jar.addCookies(cookies.map(toHappyCookie));
    lastCookies = sessionKey({ cookies: paperCookies(jar.getCookies().map(toPlaywrightCookie)) });
    installStubs();

    // Authoritative session check (same call Paper's own bootstrap makes).
    const me = await fetch(`${API}/auth/me`, { credentials: "include" });
    if (me.status === 401 || me.status === 403) {
      throw Object.assign(new Error(`Paper session is invalid (auth/me → ${me.status})`), { code: "auth" });
    }
    if (!me.ok) throw new Error(`api.paper.design/auth/me → ${me.status}`);

    const html = await (await fetch(`${APP}/`)).text();
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
    const scripts = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => new URL(m[1], APP).href);
    if (!scripts.length) throw new Error("no module scripts in app.paper.design HTML");
    for (const src of scripts) await import(src);
    relay("debug")("bundle loaded");

    if (!window.resolveMCPHandlers) throw new Error("Paper did not set up resolveMCPHandlers (WebMCP stub not detected)");
    handlers = await window.resolveMCPHandlers;
    if (!handlers) throw new Error("Paper's MCPHandlers failed to initialise");
    relay("debug")("handlers built");
    const ok = await until(() => handlers.__internalRoot, 30_000);
    if (!ok) throw new Error("Paper root state never initialised");
    await handlers.root.authState.hasLoaded;
    // File tools first wait up to 5s for every artboard to be measured by a ResizeObserver. With no layout engine
    // nothing is ever measured (nodes report pinned px sizes or null, as on unrendered pages), so that wait is dead
    // time: Paper's code catches the timeout and carries on. Skip it; tool results are identical.
    handlers.waitForMeasurement = async () => {};
  }

  // When Paper's session dies mid-life, its bootstrap/API code navigates to api.paper.design/auth/sign-in (happy-dom
  // just sets the URL since main-frame navigation is disabled).
  function signedIn() {
    if (location.origin !== APP || location.pathname.startsWith("/auth")) {
      throw Object.assign(new Error("Paper session is invalid (signed out)"), { code: "auth" });
    }
  }

  let currentFile = null;
  async function ensureFile(raw) {
    const fileId = parseFileId(raw);
    const open = () => handlers.__internalEditorState?.fileState?.data?.id ?? null;
    if (!fileId || open() === fileId) return;
    // Same steps as Paper's open_file (minus the metered tool wrapper): drop the current file's socket, then
    // navigate in-app. Without the unregister, going back to a previously opened file never loads it.
    const socket = handlers.__internalEditorState?.socketState;
    if (socket) handlers.root.socketCollection.unregisterSocket(socket);
    history.pushState(null, "", `/file/${fileId}`);
    // If the file never opens (no access, deleted), Paper's own handler reports the mismatch.
    await until(() => open() === fileId, 30_000);
    currentFile = open();
  }

  const ops = {
    boot,
    catalog: ({ clientInfo }) => handlers.getMCPServerConfig(clientInfo, true),
    async call({ tool, args, agentId, clientInfo }) {
      signedIn();
      await ensureFile(args?.fileId);
      const result = await handlers.handleToolCall(agentId, tool, args, clientInfo);
      signedIn();
      // The sync server raised minClient (new Paper release): only a fresh bundle helps, i.e. a new engine.
      if (handlers.__internalEditorState?.socketState?.reloadRequired) send({ stale: true });
      return result;
    },
    stats: () => ({ rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, file: currentFile }),
  };

  // One call at a time: Paper's UI state (open file, selection) is a single-user editor.
  let queue = Promise.resolve();
  process.on("message", (/** @type {any} */ msg) => {
    queue = queue.then(async () => {
      try {
        const result = await ops[msg.op](msg);
        send({ id: msg.id, result: JSON.parse(JSON.stringify(result ?? null)), cookies: jar && syncCookies() });
      } catch (err) {
        send({
          id: msg.id,
          error: { message: String(err?.message ?? err), code: err?.code ?? "internal" },
          cookies: jar && syncCookies(),
        });
      }
    });
  });
  process.on("unhandledRejection", (e) => relay("debug")("unhandled rejection:", e?.stack ?? e));
  process.on("uncaughtException", (e) => relay("debug")("uncaught exception:", e?.stack ?? e));
  process.on("disconnect", () => process.exit(0));
}

// A 2D context that draws nothing. Paper's editor UI asserts the HUD canvas has a context; without one the editor
// React tree throws into its error boundary, which also unmounts the router (file switching stops working).
// Raster tools never run here (not in LITE_TOOLS).
function fake2d(canvas) {
  const noop = () => {};
  const base = {
    canvas,
    measureText: (t) => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0, text: t }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createConicGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({ setTransform: noop }),
    getImageData: (x, y, w, h) => new ImageData(Math.max(1, w), Math.max(1, h)),
    createImageData: (w, h) => new ImageData(Math.max(1, w), Math.max(1, h)),
    getTransform: () => new DOMMatrix(),
    getLineDash: () => [],
    isPointInPath: () => false,
    isPointInStroke: () => false,
    getContextAttributes: () => ({}),
  };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) });
}
const NULL_CANVAS = {
  getContext: (caller, type) => (type === "2d" ? fake2d(caller.canvas) : null),
  toDataURL: () => "data:,",
  toBlob: (caller, cb) => cb(null),
};

// Browser APIs happy-dom lacks that Paper's bootstrap touches.
function installStubs() {
  // happy-dom runs requestAnimationFrame on setImmediate, so Paper's draw loops spin a core. Pace frames like a
  // throttled background tab instead.
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), FRAME_MS);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  Object.defineProperty(navigator, "modelContext", {
    value: { registerTool: () => () => {}, unregisterTool() {}, provideContext() {} },
    configurable: true,
  });
  // happy-dom fires a skipped stylesheet's load event synchronously inside appendChild, before Vite's preload helper
  // attaches its listener, so `import()` of any chunk with CSS deps (MCPHandlers) would hang. Browsers fire it async.
  const dispatch = HTMLLinkElement.prototype.dispatchEvent;
  HTMLLinkElement.prototype.dispatchEvent = function (event) {
    if (event.type !== "load" && event.type !== "error") return dispatch.call(this, event);
    setTimeout(() => dispatch.call(this, event));
    return true;
  };
  // happy-dom's CSS parser rejects rules browsers accept (e.g. `@property`, which Paper inserts for token variables).
  // The throw escapes a React effect and takes down the editor (and router) via the error boundary. Styles don't
  // matter without layout, so drop the rule like an unsupported one.
  const insertRule = CSSStyleSheet.prototype.insertRule;
  CSSStyleSheet.prototype.insertRule = function (rule, index) {
    try {
      return insertRule.call(this, rule, index);
    } catch (err) {
      if (err?.name !== "SyntaxError") throw err;
      return index ?? 0;
    }
  };
}

if (process.argv[2] === "--lite-child") runChild();
