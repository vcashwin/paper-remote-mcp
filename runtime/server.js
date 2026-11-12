// Container HTTP API (docs/remote-runtime.md): one Paper account per container. Routes tool calls to the lite
// engine when it can run them and to a lazily started Chromium otherwise. Never logs bodies, cookies or secrets.
//
// Sessions: each request carries the caller's Paper session, but the engines keep their own cookie jars (Paper renews
// the session inside them). The caller's session only boots an engine, or reboots one that Paper signed out.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createBrowserEngine } from './browser.js';
import { engineError, paperCookies, parseFileId } from './paper.js';
import { createSignIn } from './signin.js';

/** @typedef {import('./paper.js').Session} Session */
/** @typedef {import('./paper.js').ClientInfo} ClientInfo */
/** @typedef {import('./paper.js').Log} Log */
/** @typedef {{ name: string, inputSchema?: { properties?: Record<string, unknown> } }} Tool */
/** @typedef {{ tools: Tool[], instructions: string }} Catalog */
/** @typedef {{ tool: string, args: Record<string, unknown>, agentId: string, clientInfo: ClientInfo }} ToolCall */
/**
 * @typedef {{ catalog(c: ClientInfo): Promise<Catalog>, call(c: ToolCall): Promise<any>, close(): Promise<void> }}
 *   Engine
 */
/** @typedef {Engine & { stale: boolean, session(): Session }} LiteEngine  stale: replace it before the next call */

const MAX_BODY = 4 * 1024 * 1024;
const STATUS = { auth: 401, limit: 429, bad_request: 400, too_large: 413 };
const DEFAULT_CLIENT = { name: 'paper-remote-mcp', transport: 'webmcp' };

/** @param {(s: string) => void} out @returns {(s: string) => void} */
const stamped = (out) => (s) => out(`${new Date().toISOString()} ${s}`);
/** @type {Log} */
const defaultLog = {
  debug: process.env.DEBUG ? stamped(console.log) : () => {},
  info: stamped(console.log),
  warn: stamped(console.warn),
  error: stamped(console.error),
};

// ponytail: Paper reports its weekly MCP limit only as tool-error text ("Weekly MCP limit reached. …"); match it
// until Paper exposes a code.
/** @param {any} result @returns {string | undefined} */
const limitText = (result) =>
  result?.isError
    ? result.content?.find?.((/** @type {any} */ c) => c.type === 'text' && /MCP limit reached/i.test(c.text))?.text
    : undefined;

/** @param {any} err @returns {string | undefined} */
const codeOf = (err) => err?.code;

/**
 * @param {{
 *   loadLite?: () => Promise<{
 *     LITE_TOOLS: Set<string>,
 *     createLiteEngine(o: { session: Session, log: Log }): Promise<LiteEngine>,
 *   }>,
 *   createBrowser?: (o: { session: Session, log: Log }) => Promise<Engine>,
 *   signIn?: typeof createSignIn,
 *   log?: Log,
 *   browserIdleMs?: number,
 *   liteRetryMs?: number,
 * }} [options]
 */
export function createRuntime({
  loadLite = () => import('./lite.js'),
  createBrowser = createBrowserEngine,
  signIn = createSignIn,
  log = defaultLog,
  browserIdleMs = 5 * 60_000,
  liteRetryMs = 60_000,
} = {}) {
  /** The latest caller's session: boots engines, never replaces a running one. @type {Session} */
  let incoming = { cookies: [] };
  /** @type {Promise<Awaited<ReturnType<typeof loadLite>> | null> | null} */
  let liteModule = null;
  /** @type {LiteEngine | null} */ let lite = null;
  /** No lite boot before this time (a failed boot backs off; Infinity when the module can't load). */
  let liteRetryAt = 0;
  /** @type {Engine | null} */ let browser = null;
  /** @type {NodeJS.Timeout | undefined} */ let idleTimer;
  /** @type {ReturnType<typeof signIn> | null} */ let job = null;
  /** Paper's tool list, for unknown-tool and fileId checks. @type {Catalog & { engine: 'lite' | 'browser' } | null} */
  let catalog = null;
  /** The file the engines last worked on: fills in a missing fileId so lite and browser agree. @type {string | null} */
  let currentFile = null;

  // ponytail: one global queue (one account per container), so a sign-in or catalog waits behind a tool call.
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const loadModule = () =>
    (liteModule ??= loadLite().catch((err) => {
      log.error(`lite: module unavailable (${err?.message ?? err})`);
      liteRetryAt = Infinity;
      return null;
    }));
  const liteTools = async () => (await loadModule())?.LITE_TOOLS ?? new Set();

  async function closeLite() {
    const l = lite;
    lite = null;
    await l?.close().catch(() => {});
  }
  async function closeBrowser() {
    clearTimeout(idleTimer);
    const b = browser;
    browser = null;
    await b?.close().catch(() => {});
  }
  async function closeEngines() {
    await closeLite();
    await closeBrowser();
  }

  /** @param {unknown} s */
  function acceptSession(s) {
    const raw = /** @type {any} */ (s)?.cookies;
    const cookies = Array.isArray(raw) ? paperCookies(raw.filter((c) => typeof c?.domain === 'string')) : [];
    if (!cookies.length) throw engineError('auth', 'Paper session missing. Sign in again.');
    incoming = { cookies };
  }

  /**
   * Lite, booted (or replaced when stale or crashed) as needed; null while it can't run.
   * @returns {Promise<LiteEngine | null>}
   */
  async function getLite() {
    if (lite?.stale) {
      log.info('lite: replacing engine (Paper wants a newer client, or it crashed or timed out)');
      await closeLite();
    }
    if (lite) return lite;
    const liteExports = await loadModule();
    if (!liteExports || Date.now() < liteRetryAt) return null;
    const started = Date.now();
    try {
      lite = await liteExports.createLiteEngine({ session: incoming, log });
      catalog = null; // a fresh bundle may be a newer Paper release
      log.info(`lite: ready in ${Date.now() - started}ms`);
    } catch (err) {
      if (codeOf(err) === 'auth') throw err;
      liteRetryAt = Date.now() + liteRetryMs;
      log.warn(
        `lite: failed to start (${codeOf(err) ?? 'error'}: ${/** @type {any} */ (err)?.message}); browser serves`,
      );
    }
    return lite;
  }

  /** @returns {Promise<Engine>} */
  async function getBrowser() {
    if (!browser) {
      const started = Date.now();
      // Lite's cookies, not the caller's: Paper may have renewed them, and both engines then share one session.
      browser = await createBrowser({ session: lite && !lite.stale ? lite.session() : incoming, log });
      log.info(`browser: ready in ${Date.now() - started}ms`);
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => serial(closeBrowser).then(() => log.info('browser: closed after idle')),
      browserIdleMs,
    );
    idleTimer.unref();
    return browser;
  }

  /**
   * Run `fn` on the engine for `tool` (null: the catalog, which every engine serves): lite when the tool is a lite
   * tool and lite is up, else the browser. Lite failing with 'unavailable' never reached Paper, so the call moves to
   * a fresh lite or the browser; any other failure after dispatch is final (no double writes or metering). Paper
   * signing an engine out restarts the engines from the caller's session and retries once.
   * @template T @param {string | null} tool @param {(e: Engine) => Promise<T>} fn
   */
  async function withEngine(tool, fn) {
    const useLite = tool === null || (await liteTools()).has(tool);
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      /** @type {'lite' | 'browser'} */
      let engine = 'browser';
      try {
        const l = useLite ? await getLite() : null;
        if (l) engine = 'lite';
        return { value: await fn(l ?? (await getBrowser())), engine };
      } catch (err) {
        if (engine === 'lite' && codeOf(err) === 'unavailable' && attempt < 2) {
          await closeLite();
        } else if (codeOf(err) === 'auth' && !authRetried) {
          authRetried = true;
          log.info("auth: Paper signed an engine out; restarting engines with the caller's session");
          await closeEngines();
        } else {
          throw err;
        }
      }
    }
  }

  /** @param {ClientInfo} clientInfo */
  async function loadCatalog(clientInfo) {
    const { value, engine } = await withEngine(null, (e) => e.catalog(clientInfo));
    return (catalog = { tools: value.tools, instructions: value.instructions ?? '', engine });
  }

  /** @type {Record<string, (body: any) => Promise<unknown>>} */
  const routes = {
    '/catalog': (body) =>
      serial(async () => {
        acceptSession(body.session);
        const { tools, instructions } = await loadCatalog(body.clientInfo ?? DEFAULT_CLIENT);
        return { tools, instructions };
      }),
    '/call': (body) =>
      serial(async () => {
        const { tool, agentId = 'remote', clientInfo = DEFAULT_CLIENT } = body;
        let { args = {} } = body;
        if (typeof tool !== 'string' || !tool) throw engineError('bad_request', '"tool" is required.');
        if (typeof args !== 'object' || Array.isArray(args) || args === null) {
          throw engineError('bad_request', '"args" must be an object.');
        }
        acceptSession(body.session);
        const { tools, engine: catalogEngine } = catalog ?? (await loadCatalog(clientInfo));
        const def = tools.find((t) => t.name === tool);
        if (!def) {
          return {
            result: { content: [{ type: 'text', text: `Unknown tool: ${tool}` }], isError: true },
            engine: catalogEngine,
          };
        }
        if (currentFile && args.fileId === undefined && def.inputSchema?.properties?.fileId) {
          args = { ...args, fileId: currentFile };
        }
        const { value, engine } = await withEngine(tool, (e) => e.call({ tool, args, agentId, clientInfo }));
        const limit = limitText(value);
        if (limit) throw engineError('limit', limit);
        if (!value?.isError) currentFile = parseFileId(args.fileId) ?? currentFile;
        return { result: value, engine };
      }),
    '/signin/start': (body) =>
      serial(async () => {
        if (typeof body.email !== 'string' || !body.email.includes('@')) {
          throw engineError('bad_request', '"email" is required.');
        }
        await job?.close();
        job = signIn({ log });
        return job.start(body.email.trim());
      }),
    // The job stays after 'done' or 'error': it answers a retried continue (done, for 60 s) or says to start again.
    '/signin/continue': (body) =>
      serial(async () => {
        if (typeof body.value !== 'string' || !body.value) throw engineError('bad_request', '"value" is required.');
        if (!job) throw engineError('bad_request', 'No sign-in in progress. Start again with your email.');
        return job.continue(body.value);
      }),
  };

  /** @param {http.IncomingMessage} req @returns {Promise<any>} */
  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw engineError('too_large', 'Request body over 4 MB.');
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    } catch {}
    throw engineError('bad_request', 'Body must be a JSON object.');
  }

  const liteHealth = () => (lite && !lite.stale ? 'ready' : Date.now() < liteRetryAt ? 'failed' : 'cold');

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const path = (req.url ?? '/').split('?')[0];
    /** @type {any} */ let body = {};
    let status = 200;
    /** @type {any} */ let out;
    try {
      if (path === '/healthz' && req.method === 'GET') {
        out = { ok: true, engines: { lite: liteHealth(), browser: browser ? 'running' : 'stopped' } };
      } else if (routes[path] && req.method === 'POST') {
        body = await readJson(req);
        out = await routes[path](body);
      } else {
        status = 404;
        out = { error: { code: 'bad_request', message: 'Not found.' } };
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      const code = e?.code in STATUS ? e.code : 'internal';
      status = STATUS[/** @type {keyof typeof STATUS} */ (code)] ?? 500;
      out = { error: { code: code === 'too_large' ? 'bad_request' : code, message: String(e?.message ?? err) } };
      if (status === 500) log.error(`${path}: ${e?.stack ?? err}`);
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    const extra = [
      body.tool && `tool=${body.tool}`,
      out?.engine && `engine=${out.engine}`,
      out?.step && `step=${out.step}`,
    ]
      .filter(Boolean)
      .join(' ');
    log.info(`${req.method} ${path} ${status} ${Date.now() - started}ms${extra ? ` ${extra}` : ''}`);
  });

  return {
    server,
    async close() {
      server.close();
      await job?.close();
      await closeEngines();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const runtime = createRuntime();
  const port = Number(process.env.PORT || 8080);
  runtime.server.listen(port, () => defaultLog.info(`runtime listening on :${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => runtime.close().finally(() => process.exit(0)));
}
