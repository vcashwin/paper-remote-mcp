// Container HTTP API (docs/remote-runtime.md): one Paper account per container. Routes tool calls to the lite
// engine when it can run them and to a lazily started Chromium otherwise. Never logs bodies, cookies or secrets.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createBrowserEngine, paperCookies } from './browser.js';
import { createSignIn } from './signin.js';

const MAX_BODY = 4 * 1024 * 1024;
const STATUS = { auth: 401, limit: 429, bad_request: 400, too_large: 413 };
const DEFAULT_CLIENT = { name: 'paper-remote-mcp', transport: 'webmcp' };

/** @param {...unknown} a */
const defaultLog = (...a) => console.log(new Date().toISOString(), ...a);
/** @param {string} code @param {string} message */
const fail = (code, message) => Object.assign(new Error(message), { code });

/** @typedef {{ cookies: { name: string, value: string, domain: string }[] }} Session */
/** @typedef {{ catalog(c: object): Promise<any>, call(c: object): Promise<any>, session(): Promise<Session>, close(): Promise<void> }} Engine */

// ponytail: Paper reports its weekly MCP limit only as tool-error text ("Weekly MCP limit reached. …"); match it
// until Paper exposes a code.
/** @param {any} result @returns {string | undefined} */
const limitText = (result) =>
  result?.isError ? result.content?.find?.((/** @type {any} */ c) => c.type === 'text' && /MCP limit reached/i.test(c.text))?.text : undefined;

/** Identity of a Paper session: its app cookies (see paperCookies). @param {Session} s */
const sessionKey = (s) => paperCookies(s.cookies).map((c) => `${c.domain} ${c.name}=${c.value}`).sort().join(';');

/**
 * @param {{
 *   loadLite?: () => Promise<{ LITE_TOOLS: Set<string>, createLiteEngine(o: object): Promise<Engine> | Engine }>,
 *   createBrowser?: (o: object) => Promise<Engine>,
 *   signIn?: (o: object) => { start(email: string): Promise<any>, continue(value: string): Promise<any>, close(): Promise<void> },
 *   log?: (...a: unknown[]) => void,
 *   browserIdleMs?: number,
 * }} [options]
 */
export function createRuntime({
  loadLite = () => import('./lite.js'),
  createBrowser = createBrowserEngine,
  signIn = createSignIn,
  log = defaultLog,
  browserIdleMs = 5 * 60_000,
} = {}) {
  /** @type {Session | null} */
  let current = null;
  /** Session keys the engines are on: the one they started with plus any renewal they reported. */
  let known = new Set();
  /** @type {Promise<{ LITE_TOOLS: Set<string>, createLiteEngine: Function } | null> | null} */
  let liteModule = null;
  /** @type {'cold' | 'ready' | 'failed'} */
  let liteState = 'cold';
  /** @type {Engine | null} */ let lite = null;
  /** @type {Engine | null} */ let browser = null;
  /** @type {NodeJS.Timeout | undefined} */ let idleTimer;
  /** @type {ReturnType<typeof signIn> | null} */ let job = null;

  // ponytail: one global queue (one account per container), so a sign-in or catalog waits behind a tool call.
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const loadLiteModule = () =>
    (liteModule ??= loadLite().catch((err) => {
      log(`lite: module unavailable (${err?.message ?? err})`);
      return null;
    }));

  async function closeBrowser() {
    clearTimeout(idleTimer);
    const b = browser;
    browser = null;
    if (b) await b.close().catch(() => {});
  }
  async function closeEngines() {
    const l = lite;
    lite = null;
    if (l) await l.close().catch(() => {});
    await closeBrowser();
  }

  /** Start over with fresh engines when the incoming session is a different Paper session. @param {unknown} s */
  async function useSession(s) {
    const session = /** @type {Session} */ (s);
    if (!Array.isArray(session?.cookies)) throw fail('auth', 'Paper session missing. Sign in again.');
    const key = sessionKey(session);
    if (!key) throw fail('auth', 'Paper session missing. Sign in again.');
    if (known.has(key)) return;
    if (current) log('session changed: restarting engines');
    await closeEngines();
    current = session;
    known = new Set([key]);
    liteState = 'cold';
  }

  /** @returns {Promise<Engine | null>} */
  async function getLite() {
    if (lite || liteState === 'failed') return lite;
    const mod = await loadLiteModule();
    if (!mod) return (liteState = 'failed'), null;
    try {
      const t = Date.now();
      lite = await mod.createLiteEngine({ session: current, log });
      liteState = 'ready';
      log(`lite: ready in ${Date.now() - t}ms`);
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'auth') throw err;
      liteState = 'failed';
      log(`lite: failed to start (${/** @type {any} */ (err)?.code ?? 'error'}: ${/** @type {any} */ (err)?.message})`);
    }
    return lite;
  }

  /** @returns {Promise<Engine>} */
  async function getBrowser() {
    if (!browser) {
      const t = Date.now();
      browser = await createBrowser({ session: current, log });
      log(`browser: ready in ${Date.now() - t}ms`);
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => serial(closeBrowser).then(() => log('browser: closed after idle')), browserIdleMs);
    idleTimer.unref();
    return browser;
  }

  /**
   * Run on lite if it can, else (or when lite fails with anything but auth/limit) on the browser.
   * @param {boolean} liteFirst @param {(e: Engine) => Promise<any>} fn
   */
  async function run(liteFirst, fn) {
    const l = liteFirst ? await getLite() : null;
    if (l) {
      try {
        return { value: await fn(l), engine: /** @type {const} */ ('lite'), used: l };
      } catch (err) {
        const code = /** @type {any} */ (err)?.code;
        if (code === 'auth' || code === 'limit') throw err;
        log(`lite: failed (${code ?? 'error'}: ${/** @type {any} */ (err)?.message}), falling back to browser`);
      }
    }
    const b = await getBrowser();
    return { value: await fn(b), engine: /** @type {const} */ ('browser'), used: b };
  }

  /** The engine's cookies if they differ from what the caller sent. @param {Session} sent @param {Engine} engine */
  async function renewed(sent, engine) {
    const now = await engine.session();
    const key = sessionKey(now);
    if (key === sessionKey(sent)) return undefined;
    known.add(key);
    return now;
  }

  /** @type {Record<string, (body: any) => Promise<unknown>>} */
  const routes = {
    '/catalog': (body) =>
      serial(async () => {
        await useSession(body.session);
        const { value } = await run(true, (e) => e.catalog(body.clientInfo ?? DEFAULT_CLIENT));
        return { tools: value.tools, instructions: value.instructions ?? '' };
      }),
    '/call': (body) =>
      serial(async () => {
        const { tool, args = {}, agentId = 'remote', clientInfo = DEFAULT_CLIENT } = body;
        if (typeof tool !== 'string' || !tool) throw fail('bad_request', '"tool" is required.');
        if (typeof args !== 'object' || Array.isArray(args) || args === null) throw fail('bad_request', '"args" must be an object.');
        await useSession(body.session);
        const mod = await getLiteTools();
        const { value, engine, used } = await run(mod.has(tool), (e) => e.call({ tool, args, agentId, clientInfo }));
        const limit = limitText(value);
        if (limit) throw fail('limit', limit);
        const session = await renewed(body.session, used);
        return { result: value, engine, ...(session && { session }) };
      }),
    '/signin/start': (body) =>
      serial(async () => {
        if (typeof body.email !== 'string' || !body.email.includes('@')) throw fail('bad_request', '"email" is required.');
        await job?.close();
        job = signIn({ log });
        return finishStep(await job.start(body.email.trim()));
      }),
    '/signin/continue': (body) =>
      serial(async () => {
        if (typeof body.value !== 'string' || !body.value) throw fail('bad_request', '"value" is required.');
        if (!job) throw fail('bad_request', 'No sign-in in progress. Start again with your email.');
        return finishStep(await job.continue(body.value));
      }),
  };

  const getLiteTools = async () => (await loadLiteModule())?.LITE_TOOLS ?? new Set();
  /** @param {{ step: string }} step */
  function finishStep(step) {
    if (step.step === 'done' || step.step === 'error') job = null;
    return step;
  }

  /** @param {http.IncomingMessage} req @returns {Promise<any>} */
  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw fail('too_large', 'Request body over 4 MB.');
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    } catch {}
    throw fail('bad_request', 'Body must be a JSON object.');
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const path = (req.url ?? '/').split('?')[0];
    /** @type {any} */ let body = {};
    let status = 200;
    /** @type {any} */ let out;
    try {
      if (path === '/healthz' && req.method === 'GET') {
        out = { ok: true, engines: { lite: liteState, browser: browser ? 'running' : 'stopped' } };
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
      if (status === 500) log(`error ${path}: ${e?.stack ?? err}`);
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    const extra = [body.tool && `tool=${body.tool}`, out?.engine && `engine=${out.engine}`, out?.step && `step=${out.step}`, out?.session && 'session=renewed']
      .filter(Boolean)
      .join(' ');
    log(`${req.method} ${path} ${status} ${Date.now() - started}ms${extra ? ` ${extra}` : ''}`);
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
  runtime.server.listen(port, () => defaultLog(`runtime listening on :${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => runtime.close().finally(() => process.exit(0)));
}
