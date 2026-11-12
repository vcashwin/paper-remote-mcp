// Paper sign-in, one step at a time: drives Paper's real sign-in page (WorkOS AuthKit at login.paper.design)
// in headless Chromium. Never logs the email, password, code, cookies or Playwright error messages (they can quote
// selectors and typed values): only the step label and the error's name.
import { chromium } from 'playwright';
import { whoAmI } from './browser.js';
import { CHROMIUM_ARGS, paperCookies } from './paper.js';

const SIGN_IN_URL =
  'https://api.paper.design/auth/sign-in?final_redirect_uri=' + encodeURIComponent('https://app.paper.design/');
const PAPER_HOSTS = new Set(['login.paper.design', 'auth.paper.design', 'app.paper.design', 'api.paper.design']);
const STEP_MS = 60_000; // per start/continue, plus at most one ~6 s poll; the Worker waits 90 s
const MAX_WRONG = 5;
const KEEP_DONE_MS = 60_000; // a Worker that timed out retries /signin/continue and gets the same result
const SSO_ONLY = 'This account signs in with Google or SSO. Use an email sign-in (password or one-time code) instead.';

/**
 * @typedef {{ step: 'password' | 'code' | 'done' | 'error', message?: string,
 *   session?: import('./paper.js').Session, user?: { id: string, email: string, name?: string } }} SignInStep
 */

/** @param {{ log: import('./paper.js').Log }} options */
export function createSignIn({ log }) {
  /** @type {import('playwright').Browser | null} */
  let browser = null;
  /** @type {import('playwright').BrowserContext} */
  let context;
  /** @type {import('playwright').Page} */
  let page;
  /** @type {'email' | 'password' | 'code' | 'over'} */
  let stage = 'email';
  let wrong = 0;
  /** @type {SignInStep | null} */
  let done = null;
  let at = '';
  let deadline = 0;

  const left = () => Math.max(1, deadline - Date.now());
  const email = () => page.locator('input[type=email], input[name=email]');
  const password = () => page.locator('input[type=password]');
  const otp = () => page.locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]');
  const sso = () => page.getByRole('link', { name: /google|sso|single sign-on|saml/i });
  /** @param {import('playwright').Locator} l */
  const visible = async (l) => (await l.count()) > 0 && (await l.first().isVisible());

  /** Name the Playwright step that runs next: a failure logs only this label. @param {string} label */
  const step = (label) => void (at = label);

  // ponytail: AuthKit renders errors in place (a React form, checked 2026-11-13), so errors are elements added after
  // a submit; a repeated identical error is re-added, which a before/after text diff would miss. A full-page form post
  // would only surface its error through the step timeout.
  const watch = () =>
    page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__signinObserver?.disconnect();
      w.__signinAdded = [];
      w.__signinObserver = new MutationObserver((records) => {
        for (const r of records) w.__signinAdded.push(...Array.from(r.addedNodes));
      });
      w.__signinObserver.observe(document.body, { childList: true, subtree: true });
    });
  /** Text lines of the elements added since watch() that are still on the page. */
  const addedLines = () =>
    page
      .evaluate(() => {
        const nodes = /** @type {Node[]} */ (/** @type {any} */ (window).__signinAdded ?? []);
        const text = nodes
          .filter((n) => n.isConnected)
          .map((n) => (n instanceof HTMLElement ? n.innerText : (n.textContent ?? '')));
        return [
          ...new Set(
            text
              .join('\n')
              .split('\n')
              .map((l) => l.trim()),
          ),
        ].filter(Boolean);
      })
      .catch(() => /** @type {string[]} */ ([]));

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

  /** Run a start/continue body; any throw ends the job. @param {() => Promise<SignInStep>} fn */
  async function guarded(fn) {
    deadline = Date.now() + STEP_MS;
    try {
      return await fn();
    } catch (err) {
      log.warn(`signin: ${at} failed (${err instanceof Error ? err.name : 'error'})`);
      return fail(
        at === 'open sign-in page' ? 'Paper sign-in page did not load. Try again.' : 'Sign-in failed. Start again.',
      );
    }
  }

  /** Wait for what Paper shows after a submit. @param {string} typed @returns {Promise<SignInStep>} */
  async function settle(typed) {
    step('read result');
    while (Date.now() < deadline) {
      await page.waitForTimeout(750);
      const { user } = await whoAmI(context, Math.min(5_000, left()));
      if (user) {
        done = { step: 'done', session: { cookies: paperCookies(await context.cookies()) }, user };
        setTimeout(() => (done = null), KEEP_DONE_MS).unref();
        await close();
        log.info('signin: done');
        return done;
      }
      let host = '';
      try {
        host = new URL(page.url()).hostname;
      } catch {}
      if (host && !PAPER_HOSTS.has(host)) return fail(SSO_ONLY);
      if (stage !== 'code' && (await visible(otp()))) return { step: (stage = 'code') };
      if (stage !== 'password' && (await visible(password()))) return { step: (stage = 'password') };
      if (stage === 'email' && !(await visible(email())) && (await visible(sso()))) return fail(SSO_ONLY);
      const added = (await addedLines()).filter((l) => l !== typed);
      const invalid = await page.locator('[aria-invalid="true"]').count();
      if (added.length && (invalid || added.length <= 2)) {
        log.info(`signin: Paper showed an error at the ${stage} step`);
        if (stage === 'email') return fail(added.join(' '));
        if (++wrong >= MAX_WRONG) return fail('Too many attempts. Start again.');
        return { step: /** @type {'password' | 'code'} */ (stage), message: added.join(' ') };
      }
    }
    return fail('Paper did not answer in time. Start again.');
  }

  return {
    /** @param {string} address @returns {Promise<SignInStep>} */
    start: (address) =>
      guarded(async () => {
        await close();
        stage = 'email';
        wrong = 0;
        done = null;
        step('launch browser');
        browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
        context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        page = await context.newPage();
        page.setDefaultTimeout(10_000);
        log.info('signin: opening Paper sign-in');
        step('open sign-in page');
        await page.goto(SIGN_IN_URL, { waitUntil: 'domcontentloaded', timeout: left() });
        await email()
          .first()
          .waitFor({ timeout: Math.min(30_000, left()) });
        step('submit email');
        await email().first().fill(address);
        await watch();
        const button = page.getByRole('button', { name: /continue with email|^continue$/i });
        await ((await button.count()) ? button.first().click() : email().first().press('Enter'));
        return settle(address);
      }),

    /** @param {string} value @returns {Promise<SignInStep>} */
    continue: (value) =>
      guarded(async () => {
        if (done) return done;
        if (stage !== 'password' && stage !== 'code') {
          return { step: 'error', message: 'No sign-in in progress. Start again with your email.' };
        }
        step(`submit ${stage}`);
        await watch();
        if (stage === 'password') {
          await password().first().fill(value);
          await page
            .locator('button[type=submit]')
            .filter({ hasText: /sign in|continue/i })
            .first()
            .click();
        } else {
          const boxes = otp();
          if ((await boxes.count()) > 1) {
            await boxes.first().click();
            await page.keyboard.type(value, { delay: 30 });
          } else {
            await boxes.first().fill(value);
          }
          const submit = page.locator('button[type=submit]');
          if ((await submit.count()) && (await submit.first().isEnabled()))
            await submit
              .first()
              .click()
              .catch(() => {});
        }
        return settle(value);
      }),

    close,
  };
}
