// Lite engine: Paper's own web client (live bundle from app.paper.design) running in Node with happy-dom as the DOM,
// so Paper's MCPHandlers chunk serves tool calls without Chromium. See docs/remote-runtime.md.
//
// Each engine is a child process (this file run with --lite-child): Paper's bundle runs as native Node ES modules
// (fetched over https by a module loader hook) against happy-dom globals. A child per engine keeps globals isolated
// and makes close()/reload a process exit. Parent and child talk over IPC.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { engineError, meterMock, paperCookies, parseFileId, webmcpStub } from './paper.js';

const APP = 'https://app.paper.design';
const API = 'https://api.paper.design';

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
  'get_guide',
  'get_basic_info', // live; layout-dependent sizes null (Scratchpad: 642x617 in browser, null here)
  // code: app scope (Paper API + team state)
  'list_resources',
  'create_file',
  'rename_resource',
  'archive_resources',
  'unarchive_resources',
  'move_resources',
  'open_file',
  // code: document model
  'create_page',
  'update_pages',
  'arrange_pages',
  'get_selection', // no user in this tab: always empty (same as the headless browser engine)
  'get_node_info', // sizes as get_basic_info
  'get_children',
  'get_tree_summary',
  'get_jsx',
  'find_nodes',
  'list_comment_threads',
  'get_comment_thread',
  'list_comment_thread_authors',
  'set_comment_thread_status',
  'delete_nodes',
  'rename_nodes',
  'update_styles',
  'move_nodes',
  'finish_working_on_nodes',
  'get_tokens',
  'create_tokens',
  'set_tokens',
]);

// Playwright cookie <-> happy-dom ICookie. Playwright marks domain cookies with a leading dot; host-only cookies
// (e.g. __Host-*) carry the bare host. happy-dom models host-only as domain "" plus originURL.
/** @param {any} c */
export function toHappyCookie(c) {
  const dot = c.domain.startsWith('.');
  const host = dot ? c.domain.slice(1) : c.domain;
  return {
    key: c.name,
    value: c.value,
    domain: dot ? host : '',
    originURL: new URL(`https://${host}/`),
    path: c.path || '/',
    expires: c.expires > 0 ? new Date(c.expires * 1000) : null,
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false,
    sameSite: c.sameSite || 'Lax',
  };
}

/** @param {any} c */
export function toPlaywrightCookie(c) {
  return {
    name: c.key,
    value: c.value ?? '',
    domain: c.domain ? `.${c.domain}` : c.originURL.hostname,
    path: c.path || '/',
    expires: c.expires ? Math.floor(new Date(c.expires).getTime() / 1000) : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || 'Lax',
  };
}

/** @typedef {import('./server.js').LiteEngine} LiteEngine */

/**
 * Boot Paper's web client for one account in a child process. The child keeps its own cookie jar (Paper renews the
 * session in it); `session()` returns its current cookies.
 * Resolves once Paper's MCP handlers are built (signed in, root state loaded). Rejects with code 'auth' when
 * api.paper.design/auth/me says the session is invalid (also thrown by call() if Paper signs out mid-life).
 * call()/catalog() reject with 'unavailable' only when the request never reached Paper's handlers: the engine is
 * `stale` (Paper wants a newer bundle or a resync, the child exited, or an earlier call timed out). 'timeout' after
 * `callTimeoutMs` (the child is killed: Paper may or may not have finished), 'internal' if the child died mid-call.
 * @param {{ session: import('./paper.js').Session, log: import('./paper.js').Log, bootTimeoutMs?: number,
 *   callTimeoutMs?: number }} options
 * @returns {Promise<LiteEngine>}
 */
export async function createLiteEngine({ session, log, bootTimeoutMs = 60_000, callTimeoutMs = 45_000 }) {
  let cookies = paperCookies(session.cookies);
  const child = fork(fileURLToPath(import.meta.url), ['--lite-child'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
    // Paper's code runs in the child with Node globals in reach: give it none of our environment (SEAL_KEY etc.).
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (s) => {
      for (const line of String(s).split('\n')) if (line.trim()) log.debug(`[lite] ${line.slice(0, 500)}`);
    });
  }

  let seq = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  let exited = false;
  child.on('message', (/** @type {any} */ msg) => {
    if (msg.cookies) cookies = msg.cookies;
    if (msg.log) log[/** @type {keyof import('./paper.js').Log} */ (msg.log.level)]?.(`[lite] ${msg.log.text}`);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (!msg.error) return p.resolve(msg.result);
    if (msg.error.stale) engine.stale = true;
    p.reject(engineError(msg.error.code, msg.error.message));
  });
  child.on('error', (err) => log.warn(`lite: child process error (${err.message})`));
  child.on('exit', (code, signal) => {
    exited = engine.stale = true;
    for (const p of pending.values())
      p.reject(engineError('internal', `Lite engine exited mid-call (${signal ?? code}).`));
    pending.clear();
  });

  /** @param {string} op @param {object} payload @param {number} timeoutMs @returns {Promise<any>} */
  function rpc(op, payload, timeoutMs) {
    if (engine.stale) return Promise.reject(engineError('unavailable', 'Lite engine needs a restart.'));
    const id = seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // Stuck mid-call: kill it so the next call gets a fresh engine.
        engine.stale = true;
        child.kill('SIGKILL');
        const after = `${timeoutMs / 1000} s`;
        const message =
          op === 'call'
            ? `Paper's tool did not answer within ${after}; it may still have been applied. Check before retrying.`
            : `Lite engine ${op} timed out after ${after}.`;
        reject(engineError('timeout', message));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.send({ id, op, ...payload }, (err) => {
        if (!err) return;
        pending.get(id)?.reject(engineError('unavailable', 'Lite engine is not running.'));
        pending.delete(id);
      });
    });
  }

  /** @type {LiteEngine} */
  const engine = {
    stale: false,
    catalog: (clientInfo) => rpc('catalog', { clientInfo }, callTimeoutMs),
    call: ({ tool, args, agentId, clientInfo }) => rpc('call', { tool, args, agentId, clientInfo }, callTimeoutMs),
    session: () => ({ cookies }),
    async close() {
      if (exited) return;
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await gone;
    },
  };

  try {
    await rpc('boot', { cookies }, bootTimeoutMs);
  } catch (err) {
    await engine.close();
    throw err;
  }
  return engine;
}

// ---------------------------------------------------------------------------------------------------------------
// Child process: Paper's bundle in happy-dom.

// Module loader hook: lets `import("https://app.paper.design/assets/x.js")` and the bundle's relative imports load
// straight from Paper's CDN (always the live release, which satisfies the sync server's minClient). Paper's modules
// may import only other Paper modules: never `node:` built-ins or packages (only our own child bootstrap may).
export const HOOKS = `
export async function resolve(specifier, context, next) {
  const parent = context.parentURL || "";
  if (specifier.startsWith("https:")) return { url: specifier, shortCircuit: true, format: "module" };
  if (!parent.startsWith("https:")) return next(specifier, context);
  if (/^(\\.{1,2})?\\//.test(specifier))
    return { url: new URL(specifier, parent).href, shortCircuit: true, format: "module" };
  throw new Error("lite: refusing import of " + specifier + " from " + parent);
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
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @template T @param {() => T} fn @param {number} timeoutMs @returns {Promise<T | null>} */
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
  const { register } = await import('node:module');
  register('data:text/javascript,' + encodeURIComponent(HOOKS));
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  const { default: WindowBrowserContext } = await import('happy-dom/lib/window/WindowBrowserContext.js');

  /** @type {any} */ let handlers = null;
  /** @type {any} */ let jar = null;
  /** Paper asked for a page reload: a newer release (minClient) or a resync after a desync. */
  let reloadAsked = false;

  /** @param {object} msg */
  const send = (msg) => process.send?.(msg);
  /** @param {string} level */
  const relay =
    (level) =>
    (/** @type {unknown[]} */ ...a) =>
      send({ log: { level, text: a.map(String).join(' ').slice(0, 500) } });
  const editor = () => handlers.__internalEditorState;

  /** @param {{ cookies: import('./paper.js').Cookie[] }} msg */
  async function boot({ cookies }) {
    GlobalRegistrator.register({
      url: `${APP}/`,
      width: 1440,
      height: 900,
      settings: {
        enableJavaScriptEvaluation: false, // Paper's modules run as Node ES modules; no eval of page scripts
        handleDisabledFileLoadingAsSuccess: true, // CSS/classic scripts (analytics) are not loaded, but report load
        fetch: { disableSameOriginPolicy: true },
        navigation: { disableMainFrameNavigation: true },
        canvasAdapter: NULL_CANVAS,
        navigator: {
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        },
      },
    });
    const context = /** @type {import('happy-dom/lib/browser/types/IBrowserContext.js').default} */ (
      new WindowBrowserContext(/** @type {any} */ (window)).getBrowserContext()
    );
    jar = context.cookieContainer;
    // Paper sends its own If-None-Match on some API calls. happy-dom throws on a 304 it didn't cache itself, and the
    // throw happens inside its resolve, so that fetch never settles. Pass the 304 through like a browser does.
    const addToCache = context.responseCache.add.bind(context.responseCache);
    context.responseCache.add = (/** @type {any} */ request, /** @type {any} */ response) => {
      try {
        return addToCache(request, response);
      } catch {
        return /** @type {any} */ (null);
      }
    };
    jar.addCookies(cookies.map(toHappyCookie));
    installStubs();
    relay('warn')('meter: /meter/balance responses are synthetic (mcpCap 10000)');
    // Paper reloads the page when the sync server wants a newer client (minClient) or after a desync. Only a fresh
    // engine (new bundle, new socket) helps, so remember it and refuse further calls.
    window.location.reload = () => void (reloadAsked = true);

    // Authoritative session check (same call Paper's own bootstrap makes).
    const me = await fetch(`${API}/auth/me`, { credentials: 'include' });
    if (me.status === 401 || me.status === 403) {
      throw engineError('auth', `Paper session is invalid (auth/me → ${me.status})`);
    }
    if (!me.ok) throw new Error(`api.paper.design/auth/me → ${me.status}`);

    const html = await (await fetch(`${APP}/`)).text();
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? '';
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
    const scripts = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => new URL(m[1], APP).href);
    if (!scripts.length) throw new Error('no module scripts in app.paper.design HTML');
    for (const src of scripts) await import(src);
    relay('debug')('bundle loaded');

    const w = /** @type {any} */ (window);
    if (!w.resolveMCPHandlers) throw new Error('Paper did not set up resolveMCPHandlers (WebMCP stub not detected)');
    handlers = await w.resolveMCPHandlers;
    if (!handlers) throw new Error("Paper's MCPHandlers failed to initialise");
    relay('debug')('handlers built');
    const ok = await until(() => handlers.__internalRoot, 30_000);
    if (!ok) throw new Error('Paper root state never initialised');
    await handlers.root.authState.hasLoaded;
    // File tools first wait up to 5s for every artboard to be measured by a ResizeObserver. With no layout engine
    // nothing is ever measured (nodes report pinned px sizes or null, as on unrendered pages), so that wait is dead
    // time: Paper's code catches the timeout and carries on. Skip it; tool results are identical.
    handlers.waitForMeasurement = async () => {};
  }

  // When Paper's session dies mid-life, its bootstrap/API code navigates to api.paper.design/auth/sign-in (happy-dom
  // just sets the URL since main-frame navigation is disabled).
  function signedIn() {
    if (location.origin !== APP || location.pathname.startsWith('/auth')) {
      throw engineError('auth', 'Paper session is invalid (signed out)');
    }
  }

  // Refuse before Paper's handler runs, so the runtime can retry on a fresh engine without double-running anything.
  // (A file that is merely disconnected is Paper's to refuse: its wrapper fails writes with "currently disconnected".)
  function refuseIfStale() {
    if (reloadAsked || editor()?.socketState?.reloadRequired) {
      throw Object.assign(engineError('unavailable', 'Paper needs a newer client or a resync.'), { stale: true });
    }
  }

  /** @param {unknown} raw */
  async function ensureFile(raw) {
    const fileId = parseFileId(raw);
    const open = () => editor()?.fileState?.data?.id ?? null;
    if (!fileId || open() === fileId) return;
    // Same steps as Paper's open_file (minus the metered tool wrapper): drop the current file's socket, then
    // navigate in-app. Without the unregister, going back to a previously opened file never loads it.
    const socket = editor()?.socketState;
    if (socket) handlers.root.socketCollection.unregisterSocket(socket);
    history.pushState(null, '', `/file/${fileId}`);
    // If the file never opens (no access, deleted), Paper's own handler reports the mismatch.
    await until(() => open() === fileId, 30_000);
  }

  /** @type {Record<string, (msg: any) => Promise<unknown> | unknown>} */
  const ops = {
    boot,
    catalog: ({ clientInfo }) => handlers.getMCPServerConfig(clientInfo, true),
    async call({ tool, args, agentId, clientInfo }) {
      signedIn();
      refuseIfStale();
      await ensureFile(args?.fileId);
      refuseIfStale();
      const result = await handlers.handleToolCall(agentId, tool, args, clientInfo);
      signedIn();
      return result;
    },
  };

  // One call at a time: Paper's UI state (open file, selection) is a single-user editor.
  let queue = Promise.resolve();
  process.on('message', (/** @type {any} */ msg) => {
    queue = queue.then(async () => {
      const cookies = () => jar && paperCookies(jar.getCookies().map(toPlaywrightCookie));
      try {
        const result = await ops[msg.op](msg);
        send({ id: msg.id, result: JSON.parse(JSON.stringify(result ?? null)), cookies: cookies() });
      } catch (e) {
        const err = /** @type {any} */ (e);
        send({
          id: msg.id,
          error: { message: String(err?.message ?? err), code: err?.code ?? 'internal', stale: !!err?.stale },
          cookies: cookies(),
        });
      }
    });
  });
  process.on('unhandledRejection', (e) => relay('debug')('unhandled rejection:', /** @type {any} */ (e)?.stack ?? e));
  process.on('uncaughtException', (e) => relay('debug')('uncaught exception:', e?.stack ?? e));
  process.on('disconnect', () => process.exit(0));
}

// A 2D context that draws nothing. Paper's editor UI asserts the HUD canvas has a context; without one the editor
// React tree throws into its error boundary, which also unmounts the router (file switching stops working).
// Raster tools never run here (not in LITE_TOOLS).
/** @param {unknown} canvas @returns {any} */
function fake2d(canvas) {
  const noop = () => {};
  /** @type {Record<string | symbol, unknown>} */
  const base = {
    canvas,
    measureText: (/** @type {string} */ t) => ({
      width: 0,
      actualBoundingBoxAscent: 0,
      actualBoundingBoxDescent: 0,
      fontBoundingBoxAscent: 0,
      fontBoundingBoxDescent: 0,
      text: t,
    }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createConicGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({ setTransform: noop }),
    getImageData: (
      /** @type {number} */ x,
      /** @type {number} */ y,
      /** @type {number} */ w,
      /** @type {number} */ h,
    ) => new ImageData(Math.max(1, w), Math.max(1, h)),
    createImageData: (/** @type {number} */ w, /** @type {number} */ h) =>
      new ImageData(Math.max(1, w), Math.max(1, h)),
    getTransform: () => new DOMMatrix(),
    getLineDash: () => [],
    isPointInPath: () => false,
    isPointInStroke: () => false,
    getContextAttributes: () => ({}),
  };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) });
}
/** @type {import('happy-dom/lib/canvas/ICanvasAdapter.js').default} */
const NULL_CANVAS = {
  getContext: (caller, type) => (type === '2d' ? fake2d(caller.canvas) : null),
  toDataURL: () => 'data:,',
  toBlob: (caller, cb) => cb(null),
};

// Browser APIs happy-dom lacks that Paper's bootstrap touches.
function installStubs() {
  // happy-dom runs requestAnimationFrame on setImmediate, so Paper's draw loops spin a core. Pace frames like a
  // throttled background tab instead.
  window.requestAnimationFrame = (cb) => Number(setTimeout(() => cb(performance.now()), FRAME_MS));
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  webmcpStub();
  meterMock();
  // happy-dom fires a skipped stylesheet's load event synchronously inside appendChild, before Vite's preload helper
  // attaches its listener, so `import()` of any chunk with CSS deps (MCPHandlers) would hang. Browsers fire it async.
  const dispatch = HTMLLinkElement.prototype.dispatchEvent;
  HTMLLinkElement.prototype.dispatchEvent = function (/** @type {Event} */ event) {
    if (event.type !== 'load' && event.type !== 'error') return dispatch.call(this, event);
    setTimeout(() => dispatch.call(this, event));
    return true;
  };
  // happy-dom's CSS parser rejects rules browsers accept (e.g. `@property`, which Paper inserts for token variables).
  // The throw escapes a React effect and takes down the editor (and router) via the error boundary. Styles don't
  // matter without layout, so drop the rule like an unsupported one.
  const insertRule = CSSStyleSheet.prototype.insertRule;
  CSSStyleSheet.prototype.insertRule = function (/** @type {string} */ rule, /** @type {number | undefined} */ index) {
    try {
      return insertRule.call(this, rule, index);
    } catch (err) {
      if (/** @type {any} */ (err)?.name !== 'SyntaxError') throw err;
      return index ?? 0;
    }
  };
}

if (process.argv[2] === '--lite-child') runChild();
