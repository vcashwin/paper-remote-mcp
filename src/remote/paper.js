// Everything remote mode does with real Paper, behind one small interface (the seam
// tests replace with a fake):
//
//   validate(storageState)   is this a signed-in Paper session? → { user, storageState } | null
//   signIn()                 drive Paper's own sign-in page headlessly, one step at a time
//   config(accountId)        Paper's tool catalog + instructions (cached; same for everyone)
//   call(accountId, …)       one tool call on that account's editor
//
// The editor pool: one shared browser; per account an isolated BrowserContext made
// from its sealed session, kept warm, evicted when idle (LRU past the cap), calls
// serialised per account, and the session's cookies written back (Paper renews them).
import { launchBrowser } from '../browser.js';
import { createEditorHost, AuthRequiredError } from '../editor/host.js';
import { whoAmI } from '../auth/session.js';
import { resolveEnv } from '../config.js';
import { log } from '../log.js';

/** Paper no longer accepts the account's session: the account must link again. */
export class AccountUnlinked extends Error {
  /** @param {string} accountId */
  constructor(accountId) {
    super('Your Paper session has ended. Reconnect to link your Paper account again.');
    this.name = 'AccountUnlinked';
    this.accountId = accountId;
  }
}

/** All editors are busy and the pool is full. */
export class PoolBusy extends Error {
  constructor() {
    super('The server is at capacity; try again shortly.');
    this.name = 'PoolBusy';
  }
}

/**
 * @typedef {{ cookies: any[], origins: any[] }} StorageState
 * @typedef {{ id: string, email: string }} PaperUser
 * @typedef {{ step: 'email' | 'password' | 'code' | 'done' | 'unsupported', error?: string, user?: PaperUser, storageState?: StorageState }} SignInStep
 * @typedef {{ submit(value: string): Promise<SignInStep>, close(): Promise<void> }} SignIn
 * @typedef {{ load(id: string): StorageState | null, save(id: string, s: StorageState): void, unlink(id: string): void }} Sessions
 * @typedef {{
 *   validate(s: StorageState): Promise<{ user: PaperUser, storageState: StorageState } | null>,
 *   signIn(): Promise<SignIn>,
 *   config(accountId: string): Promise<{ tools: any[], instructions?: string }>,
 *   call(accountId: string, agentId: string, name: string, args: Record<string, unknown>): Promise<unknown>,
 *   drop(accountId: string): Promise<void>,
 *   close(): Promise<void>,
 * }} Paper
 */

const CLIENT_INFO = { name: 'paper-remote-mcp', transport: 'webmcp' };
const CHECK_EVERY_MS = 5 * 60_000;
const CATALOG_TTL_MS = 10 * 60_000;
const VIEWPORT = { width: 1440, height: 900 };

/**
 * @param {{ sessions: Sessions, env?: string, maxEditors?: number, idleMs?: number, headless?: boolean }} options
 * @returns {Paper}
 */
export function createPaper({ sessions, env: envName, maxEditors = 8, idleMs = 10 * 60_000, headless = true }) {
  const env = resolveEnv(envName);
  /** @type {Promise<import('playwright').Browser> | null} */
  let browserPromise = null;
  const browser = () => (browserPromise ??= launchBrowser({ headless }));

  /** @type {Map<string, { host: Awaited<ReturnType<typeof createEditorHost>>, usedAt: number, checkedAt: number, busy: number }>} */
  const editors = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const locks = new Map();
  /** @type {{ value: { tools: any[], instructions?: string }, at: number } | null} */
  let catalog = null;

  /**
   * Run `fn` alone for this account (calls queue; other accounts run in parallel).
   * @template T @param {string} id @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  function exclusive(id, fn) {
    const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(id, tail);
    tail.then(() => locks.get(id) === tail && locks.delete(id));
    return run;
  }

  /** @param {string} id */
  async function evict(id) {
    const editor = editors.get(id);
    if (!editor) return;
    editors.delete(id);
    try {
      sessions.save(id, await editor.host.context.storageState());
    } catch (err) {
      log.debug('Could not save session on eviction:', err);
    }
    await editor.host.close();
  }

  async function makeRoom() {
    if (editors.size < maxEditors) return;
    const idle = [...editors].filter(([, e]) => !e.busy).sort((a, b) => a[1].usedAt - b[1].usedAt);
    if (!idle.length) throw new PoolBusy();
    await evict(idle[0][0]);
  }

  /** The account's editor, started if needed, marked busy. @param {string} id */
  async function editorFor(id) {
    const existing = editors.get(id);
    if (existing) {
      existing.busy++;
      return existing;
    }
    const storageState = sessions.load(id);
    if (!storageState) throw new AccountUnlinked(id);
    await makeRoom();
    const context = await (await browser()).newContext({ storageState, viewport: VIEWPORT });
    const host = await createEditorHost({ env: env.key, context });
    try {
      await host.start();
    } catch (err) {
      await host.close();
      if (err instanceof AuthRequiredError) {
        sessions.unlink(id);
        throw new AccountUnlinked(id);
      }
      throw err;
    }
    const editor = { host, usedAt: Date.now(), checkedAt: Date.now(), busy: 1 };
    editors.set(id, editor);
    sessions.save(id, await context.storageState());
    log.info(`Editor started (${editors.size}/${maxEditors} warm).`);
    return editor;
  }

  /**
   * @template T @param {string} id
   * @param {(host: Awaited<ReturnType<typeof createEditorHost>>) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withEditor(id, fn) {
    return exclusive(id, async () => {
      const editor = await editorFor(id); // marked busy
      try {
        // Every few minutes: is the session still good? (This also lets Paper renew
        // the cookie, which we keep.)
        if (Date.now() - editor.checkedAt > CHECK_EVERY_MS) {
          const { status } = await whoAmI(editor.host.context, env);
          if (status === 401) throw new AuthRequiredError();
          editor.checkedAt = Date.now();
          sessions.save(id, await editor.host.context.storageState());
        }
        return await fn(editor.host);
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          editors.delete(id);
          await editor.host.close();
          sessions.unlink(id);
          throw new AccountUnlinked(id);
        }
        throw err;
      } finally {
        editor.busy--;
        editor.usedAt = Date.now();
      }
    });
  }

  const sweep = setInterval(() => {
    for (const [id, editor] of editors) {
      const idle = (/** @type {typeof editor | undefined} */ e) => e && !e.busy && Date.now() - e.usedAt > idleMs;
      if (idle(editor)) exclusive(id, async () => idle(editors.get(id)) && (await evict(id))).catch(() => {});
    }
  }, 30_000);
  sweep.unref();

  /** Text lines on the page now, for spotting the error a submit added. @param {import('playwright').Page} page */
  const lines = async (page) =>
    new Set(
      (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => ''))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    );

  return {
    async validate(storageState) {
      const context = await (await browser()).newContext({ storageState });
      try {
        const { user } = await whoAmI(context, env);
        return user ? { user, storageState: await context.storageState() } : null;
      } finally {
        await context.close().catch(() => {});
      }
    },

    async signIn() {
      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 860 } });
      const page = await context.newPage();
      const close = () => context.close().catch(() => {});
      try {
        await page.goto(`${env.api}/auth/sign-in?final_redirect_uri=${encodeURIComponent(`${env.app}/`)}`, { waitUntil: 'domcontentloaded' });
        await page.locator('input[type=email], input[name=email]').first().waitFor({ timeout: 30_000 });
      } catch (err) {
        await close();
        throw err;
      }

      /** @type {SignInStep['step']} */
      let stage = 'email';
      const otp = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]');
      const password = page.locator('input[type=password]');
      const paperHosts = new Set(['login.paper.design', 'auth.paper.design', new URL(env.app).hostname, new URL(env.api).hostname]);

      /** Wait for what Paper wants next. @param {Set<string>} before @param {string} typed @returns {Promise<SignInStep>} */
      async function settle(before, typed) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          await page.waitForTimeout(1_000);
          const { user } = await whoAmI(context, env);
          if (user) {
            stage = 'done';
            const storageState = await context.storageState();
            await close();
            return { step: 'done', user, storageState };
          }
          let host = '';
          try {
            host = new URL(page.url()).hostname;
          } catch {}
          if (host && !paperHosts.has(host)) return { step: (stage = 'unsupported') };
          if (stage !== 'code' && (await otp.count()) && (await otp.first().isVisible())) return { step: (stage = 'code') };
          if (stage !== 'password' && (await password.count()) && (await password.first().isVisible())) return { step: (stage = 'password') };
          const added = [...(await lines(page))].filter((l) => !before.has(l) && l !== typed);
          const invalid = await page.locator('[aria-invalid="true"]').count();
          if (added.length && (invalid || added.length <= 2)) return { step: stage, error: added.join(' ') };
        }
        return { step: stage, error: 'Paper did not answer in time. Try again.' };
      }

      return {
        async submit(value) {
          const before = await lines(page);
          if (stage === 'email') {
            await page.locator('input[type=email], input[name=email]').first().fill(value);
            await page.getByRole('button', { name: /continue with email/i }).click();
          } else if (stage === 'password') {
            await password.first().fill(value);
            await page.locator('button[type=submit]').filter({ hasText: /sign in|continue/i }).first().click();
          } else if (stage === 'code') {
            const boxes = await otp.count();
            if (boxes > 1) {
              await otp.first().click();
              await page.keyboard.type(value, { delay: 30 });
            } else {
              await otp.first().fill(value);
            }
            const submit = page.locator('button[type=submit]');
            if ((await submit.count()) && (await submit.first().isEnabled())) await submit.first().click().catch(() => {});
          } else {
            return { step: stage };
          }
          return await settle(before, value);
        },
        close,
      };
    },

    async config(accountId) {
      if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.value;
      const value = await withEditor(accountId, (host) => host.getConfig(CLIENT_INFO));
      catalog = { value, at: Date.now() };
      return value;
    },

    call(accountId, agentId, name, args) {
      return withEditor(accountId, async (host) => {
        if ('fileId' in args) await host.ensureFile(args.fileId);
        return await host.handleToolCall(agentId, name, args, CLIENT_INFO);
      });
    },

    drop(accountId) {
      return exclusive(accountId, async () => {
        const editor = editors.get(accountId);
        editors.delete(accountId);
        await editor?.host.close();
      });
    },

    async close() {
      clearInterval(sweep);
      for (const id of [...editors.keys()]) await exclusive(id, () => evict(id)).catch(() => {});
      if (browserPromise) await (await browserPromise).close().catch(() => {});
    },
  };
}
