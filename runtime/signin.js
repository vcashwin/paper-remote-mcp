// Paper sign-in, one step at a time: drives Paper's real sign-in page (WorkOS AuthKit at login.paper.design)
// in headless Chromium. Never logs the email, password, code or cookies.
import { chromium } from 'playwright';
import { paperCookies, whoAmI } from './browser.js';

const SIGN_IN_URL = 'https://api.paper.design/auth/sign-in?final_redirect_uri=' + encodeURIComponent('https://app.paper.design/');
const PAPER_HOSTS = new Set(['login.paper.design', 'auth.paper.design', 'app.paper.design', 'api.paper.design']);
const STEP_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ step: 'password' | 'code' | 'done' | 'error', message?: string, session?: { cookies: any[] },
 *   user?: { id: string, email: string, name?: string } }} SignInStep
 */

/** @param {{ log: (...a: unknown[]) => void }} options */
export function createSignIn({ log }) {
  /** @type {import('playwright').Browser | null} */
  let browser = null;
  /** @type {import('playwright').BrowserContext} */
  let context;
  /** @type {import('playwright').Page} */
  let page;
  /** @type {'email' | 'password' | 'code' | 'over'} */
  let stage = 'email';

  const email = () => page.locator('input[type=email], input[name=email]');
  const password = () => page.locator('input[type=password]');
  const otp = () => page.locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]');
  const visible = async (/** @type {import('playwright').Locator} */ l) => (await l.count()) > 0 && (await l.first().isVisible());
  /** Text lines on the page, to spot the error line a submit adds. */
  const lines = async () =>
    new Set((await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean));

  async function close() {
    stage = 'over';
    await browser?.close().catch(() => {});
    browser = null;
  }

  /** @param {string} message @returns {Promise<SignInStep>} */
  async function fail(message) {
    await close();
    return { step: 'error', message };
  }

  /** Wait for what Paper shows after a submit. @param {Set<string>} before @param {string} typed @returns {Promise<SignInStep>} */
  async function settle(before, typed) {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(750);
      const { user } = await whoAmI(context);
      if (user) {
        const session = { cookies: paperCookies(await context.cookies()) };
        await close();
        log('signin: done');
        return { step: 'done', session, user };
      }
      let host = '';
      try {
        host = new URL(page.url()).hostname;
      } catch {}
      if (host && !PAPER_HOSTS.has(host)) return fail('This account signs in with Google or SSO. Use an email sign-in (password or one-time code) instead.');
      if (stage !== 'code' && (await visible(otp()))) return { step: (stage = 'code') };
      if (stage !== 'password' && (await visible(password()))) return { step: (stage = 'password') };
      const added = [...(await lines())].filter((l) => !before.has(l) && l !== typed);
      const invalid = await page.locator('[aria-invalid="true"]').count();
      if (added.length && (invalid || added.length <= 2)) {
        log(`signin: Paper showed an error at the ${stage} step`);
        return stage === 'email' ? fail(added.join(' ')) : { step: stage, message: added.join(' ') };
      }
    }
    return fail('Paper did not answer in time. Start again.');
  }

  return {
    /** @param {string} address @returns {Promise<SignInStep>} */
    async start(address) {
      await close();
      stage = 'email';
      browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'] });
      context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      page = await context.newPage();
      log('signin: opening Paper sign-in');
      try {
        await page.goto(SIGN_IN_URL, { waitUntil: 'domcontentloaded' });
        await email().first().waitFor({ timeout: STEP_TIMEOUT_MS });
      } catch (err) {
        log(`signin: sign-in page did not load: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
        return fail('Paper sign-in page did not load. Try again.');
      }
      const before = await lines();
      await email().first().fill(address);
      const button = page.getByRole('button', { name: /continue with email|^continue$/i });
      await ((await button.count()) ? button.first().click() : email().first().press('Enter'));
      return settle(before, address);
    },

    /** @param {string} value @returns {Promise<SignInStep>} */
    async continue(value) {
      if (stage !== 'password' && stage !== 'code') return { step: 'error', message: 'No sign-in in progress. Start again with your email.' };
      const before = await lines();
      if (stage === 'password') {
        await password().first().fill(value);
        await page.locator('button[type=submit]').filter({ hasText: /sign in|continue/i }).first().click();
      } else {
        const boxes = otp();
        if ((await boxes.count()) > 1) {
          await boxes.first().click();
          await page.keyboard.type(value, { delay: 30 });
        } else {
          await boxes.first().fill(value);
        }
        const submit = page.locator('button[type=submit]');
        if ((await submit.count()) && (await submit.first().isEnabled())) await submit.first().click().catch(() => {});
      }
      return settle(before, value);
    },

    close,
  };
}
