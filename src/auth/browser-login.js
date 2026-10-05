import { createInterface } from 'node:readline';
import { resolveEnv } from '../config.js';
import { launchContext } from '../browser.js';
import { checkSession, profileDir } from './session.js';
import { log } from '../log.js';

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 2_000;

/**
 * Interactive sign-in. Opens a real (headed) browser at app.paper.design where
 * you complete Paper's normal WorkOS AuthKit OAuth flow — the exact same sign-in
 * the desktop app triggers, including SSO / password managers. The resulting
 * session cookies persist in the profile directory, so later headless `mcp` runs
 * are already authenticated.
 *
 * Resolves true only once Paper's API confirms the session (`/auth/me` → 200).
 *
 * @param {{ env?: string, profile?: string }} [options]
 */
export async function login(options = {}) {
  const env = resolveEnv(options.env);
  const dir = profileDir(env.key, options.profile);

  log.info(`Opening a browser to sign in to Paper (${env.key}). Profile: ${dir}`);
  const context = await launchContext(dir, { headless: false, viewport: { width: 1280, height: 860 } });

  try {
    if ((await checkSession(context, env)).signedIn) {
      process.stderr.write('\n✓ Already signed in to Paper. Run `paper-remote-mcp logout` first to switch accounts.\n');
      return true;
    }

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${env.app}/`, { waitUntil: 'domcontentloaded' }).catch((err) => {
      log.warn('Initial navigation failed (you can still sign in in the window):', err);
    });

    process.stderr.write(
      `\nA separate Chrome window for paper-remote-mcp is open at ${env.app}.\n` +
        "It can't use your everyday Chrome profile, so you sign in here once and the session is kept.\n" +
        '"Continue with email" (Paper emails you a code) works anywhere; if Google sign-in is refused in this window, use that.\n' +
        'This finishes on its own once Paper confirms the session.\n'
    );

    const signedIn = await waitForSignIn(context, env);

    if (signedIn) {
      process.stderr.write('\n✓ Signed in. Session saved — restart your agent (or reconnect the `paper` MCP server).\n');
      // Let Chrome flush the session cookies to disk before shutting down.
      await page.waitForTimeout(1_000).catch(() => {});
    } else {
      process.stderr.write('\n✗ Not signed in. Run `paper-remote-mcp login` again when you are ready.\n');
      process.exitCode = 1;
    }
    return signedIn;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Poll Paper's API until the session is real. Enter re-checks immediately;
 * closing the browser window or timing out gives up.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {{ api: string, app: string }} env
 */
async function waitForSignIn(context, env) {
  let browserClosed = false;
  context.on('close', () => {
    browserClosed = true;
  });

  let enterPressed = false;
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin }) : null;
  rl?.on('line', () => {
    enterPressed = true;
  });
  if (rl) process.stderr.write('(Press Enter to check again right away.)\n');

  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (browserClosed) {
        process.stderr.write('\nThe browser window was closed before sign-in finished.\n');
        return false;
      }

      const { signedIn, status } = await checkSession(context, env);
      if (signedIn) return true;

      if (enterPressed) {
        enterPressed = false;
        process.stderr.write(`Not signed in yet (Paper API /auth/me → ${status ?? 'no response'}). Finish signing in, then press Enter again.\n`);
      }

      // Sleep, but wake early on Enter or a closed window.
      const wakeAt = Date.now() + POLL_INTERVAL_MS;
      while (Date.now() < wakeAt && !enterPressed && !browserClosed) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    process.stderr.write('\nTimed out waiting for sign-in.\n');
    return false;
  } finally {
    rl?.close();
  }
}
