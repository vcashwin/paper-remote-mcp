import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readlinkSync } from 'node:fs';

/**
 * Where we keep the signed-in browser profile. Playwright's persistent context
 * stores cookies (including Paper's sealed-session cookie) in this directory, so
 * once you `login` the headless `mcp` runs reuse the same authenticated session —
 * exactly how a browser keeps you logged in between launches.
 *
 * Override with PAPER_MCP_PROFILE. One directory per environment so prod and
 * staging sessions never collide.
 *
 * @param {string} envKey
 * @param {string} [override]
 */
export function profileDir(envKey, override) {
  const base = override || process.env.PAPER_MCP_PROFILE || join(homedir(), '.paper-mcp');
  const dir = join(base, 'profiles', envKey);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The live browser process holding a profile, if any. Chrome keeps a
 * `SingletonLock` symlink pointing at `<hostname>-<pid>` while it runs; a lock
 * whose pid is gone is stale (left by a crash) and doesn't count.
 *
 * @param {string} dir
 * @returns {{ pid: number } | null}
 */
export function profileLockHolder(dir) {
  let target;
  try {
    target = readlinkSync(join(dir, 'SingletonLock'));
  } catch {
    return null;
  }

  const pid = Number(target.slice(target.lastIndexOf('-') + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    process.kill(pid, 0);
    return { pid };
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM' ? { pid } : null;
  }
}

/**
 * Ask Paper's API who we are, using the browser context's cookies (Playwright's
 * `context.request` shares the context's cookie jar). This is the same endpoint
 * Paper Desktop uses to validate a session: 200 means signed in, 401 means not.
 *
 * Page-based signals are unreliable here: Paper defines `window.resolveMCPHandlers`
 * on app.paper.design a few milliseconds *before* redirecting a signed-out
 * visitor to the sign-in page.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {{ api: string, app: string }} env
 * @returns {Promise<{ signedIn: boolean, status: number | null }>}
 */
export async function checkSession(context, env) {
  try {
    const res = await context.request.get(`${env.api}/auth/me`, {
      headers: { origin: env.app, referer: `${env.app}/` },
      timeout: 15_000,
    });
    return { signedIn: res.status() === 200, status: res.status() };
  } catch {
    return { signedIn: false, status: null };
  }
}

/**
 * `checkSession` plus who is signed in: Paper's `/auth/me` user (id, email) when
 * the session is good.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {{ api: string, app: string }} env
 * @returns {Promise<{ status: number | null, user: { id: string, email: string } | null }>}
 */
export async function whoAmI(context, env) {
  try {
    const res = await context.request.get(`${env.api}/auth/me`, {
      headers: { origin: env.app, referer: `${env.app}/` },
      timeout: 15_000,
    });
    if (res.status() !== 200) return { status: res.status(), user: null };
    const body = await res.json().catch(() => null);
    const user = body?.user;
    return typeof user?.id === 'string' ? { status: 200, user: { id: user.id, email: String(user.email ?? '') } } : { status: 200, user: null };
  } catch {
    return { status: null, user: null };
  }
}
