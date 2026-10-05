import { chromium } from 'playwright';
import { profileLockHolder } from './auth/session.js';
import { log } from './log.js';

/** The profile directory is held by another running browser (usually another paper-remote-mcp process). */
export class ProfileInUseError extends Error {
  /** @param {string} dir @param {number | null} pid */
  constructor(dir, pid) {
    super(
      `The Paper profile at ${dir} is in use by another browser${pid ? ` (pid ${pid})` : ''} — ` +
        'most likely the `paper` MCP server your agent launched. Quit that agent (or the process) and try again.'
    );
    this.name = 'ProfileInUseError';
    this.pid = pid;
  }
}

/** @param {unknown} err */
const messageOf = (err) => String(err instanceof Error ? err.message : err);

/** Chrome isn't installed, so falling back to bundled Chromium is safe. */
const isMissingChrome = (/** @type {unknown} */ err) =>
  /is not found|not installed|Executable doesn't exist|distribution/i.test(messageOf(err));

const isProfileLocked = (/** @type {unknown} */ err) => /ProcessSingleton|SingletonLock/i.test(messageOf(err));

/**
 * The single launcher for login, doctor and mcp, so a profile is always opened
 * by the same browser and therefore the same cookie store. Prefers the user's
 * installed Chrome (no download needed for `npx`), falling back to Playwright's
 * bundled Chromium only when Chrome isn't installed.
 *
 * @param {string} userDataDir
 * @param {{ headless: boolean, viewport?: { width: number, height: number } }} options
 */
export async function launchContext(userDataDir, { headless, viewport = { width: 1440, height: 900 } }) {
  const holder = profileLockHolder(userDataDir);
  if (holder) throw new ProfileInUseError(userDataDir, holder.pid);

  const common = { headless, viewport, args: ['--disable-blink-features=AutomationControlled'] };
  try {
    return await chromium.launchPersistentContext(userDataDir, { channel: 'chrome', ...common });
  } catch (err) {
    if (isProfileLocked(err)) throw new ProfileInUseError(userDataDir, null);
    if (!isMissingChrome(err)) throw err;
    log.info("Google Chrome not found; using Playwright's bundled Chromium (run `npx playwright install chromium` if this fails).");
  }

  try {
    return await chromium.launchPersistentContext(userDataDir, common);
  } catch (err) {
    if (isProfileLocked(err)) throw new ProfileInUseError(userDataDir, null);
    throw err;
  }
}
