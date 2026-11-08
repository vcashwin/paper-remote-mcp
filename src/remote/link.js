// Link Paper: hop 2 of the front door. Where Linefold redirects to its own OAuth
// server, we end up with a Paper session, one of two ways:
//
//   sign in through the server   POST /link/signin  — the server drives Paper's own
//                                 sign-in headlessly: email → password and/or a code
//   link from your computer      POST /link/code (the page gets a code + a poll secret);
//                                 `npx paper-remote-mcp link <CODE>` POSTs a session to
//                                 /link/code/<CODE>; the page polls /link/code/status
//
// Either way the session is validated (Paper's /auth/me), sealed, and this browser
// gets a signed account cookie (`__Host-pmcp_account`) so consent is one click next time.
import crypto from 'node:crypto';
import { cookie, cookies, html, json, readJson, redirect, sameOrigin } from './http.js';
import { linkPage } from './pages.js';
import { digest, equal, randomString } from './seal.js';
import { log } from '../log.js';

export const ACCOUNT_COOKIE = '__Host-pmcp_account';
const ACCOUNT_COOKIE_AGE = 30 * 86_400;
const CODE_LIFETIME = 10 * 60_000, JOB_LIFETIME = 10 * 60_000, MAX_JOBS = 20;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const MAX_SESSION_BYTES = 512 * 1024;

/** A relative path on this origin (never `//host` or a scheme). @param {string | null} next */
export const safeNext = (next) => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/account');

/**
 * @param {{
 *   store: import('./store.js').Store, secrets: import('./seal.js').Secrets,
 *   accounts: import('./accounts.js').Accounts, paper: import('./paper.js').Paper, origin: string,
 * }} o
 */
export function createLink({ store, secrets, accounts, paper, origin }) {
  /** @type {Map<string, { signIn: import('./paper.js').SignIn, timer: NodeJS.Timeout, busy: boolean }>} */
  const jobs = new Map();

  const setAccount = (/** @type {string} */ id) => cookie(ACCOUNT_COOKIE, secrets.sign('account', { id, exp: Date.now() + ACCOUNT_COOKIE_AGE * 1000 }), ACCOUNT_COOKIE_AGE);
  const newCode = () => {
    const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  };

  /** @param {string} id */
  async function endJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    clearTimeout(job.timer);
    await job.signIn.close();
  }

  /** @param {import('./http.js').Req} req @param {import('./http.js').Res} res */
  async function signIn(req, res) {
    if (!sameOrigin(req, origin)) return json(res, 403, { error: 'Cross-origin request refused' });
    const body = await readJson(req);
    const value = typeof body?.value === 'string' ? body.value.trim() : '';
    if (!value || value.length > 512) return json(res, 400, { error: 'Enter a value.' });
    let id = typeof body.job === 'string' ? body.job : null;
    let job = id ? jobs.get(id) : undefined;
    if (id && !job) return json(res, 200, { step: 'email', error: 'That sign-in timed out. Start again with your email.' });
    if (!job) {
      if (jobs.size >= MAX_JOBS) return json(res, 503, { error: 'Too many sign-ins in progress. Try again in a minute.' });
      id = randomString(32);
      const started = await paper.signIn().catch((err) => {
        log.warn('Could not open Paper sign-in:', err instanceof Error ? err.message : err);
        return null;
      });
      if (!started) return json(res, 502, { error: "Couldn't reach Paper's sign-in page. Try again, or link from your computer." });
      const jobId = id;
      job = { signIn: started, busy: false, timer: setTimeout(() => endJob(jobId), JOB_LIFETIME) };
      job.timer.unref();
      jobs.set(id, job);
    }
    if (job.busy) return json(res, 409, { job: id, error: 'Still working on the last step…' });
    job.busy = true;
    try {
      const step = await job.signIn.submit(value);
      if (step.step === 'done' && step.user && step.storageState) {
        await endJob(/** @type {string} */ (id));
        const accountId = accounts.link(step.user, step.storageState);
        await paper.drop(accountId); // a re-link replaces any warm editor on the old session
        log.info('Paper account linked by sign-in.');
        return json(res, 200, { step: 'done' }, { 'set-cookie': setAccount(accountId) });
      }
      if (step.step === 'unsupported') await endJob(/** @type {string} */ (id));
      return json(res, 200, { job: id, step: step.step, ...(step.error && { error: step.error }) });
    } catch (err) {
      log.warn('Paper sign-in step failed:', err instanceof Error ? err.message : err);
      await endJob(/** @type {string} */ (id));
      return json(res, 200, { step: 'email', error: 'Paper sign-in failed. Start again, or link from your computer.' });
    } finally {
      job.busy = false;
    }
  }

  /** @param {import('./http.js').Req} req @param {import('./http.js').Res} res */
  function createCode(req, res) {
    if (!sameOrigin(req, origin)) return json(res, 403, { error: 'Cross-origin request refused' });
    const code = newCode(), poll = randomString(32), now = Date.now();
    store.run('delete from link_codes where expires_at < ?', now);
    store.run('insert into link_codes (code, poll_digest, expires_at) values (?, ?, ?)', code, digest(poll), now + CODE_LIFETIME);
    json(res, 200, { code, poll, expiresIn: CODE_LIFETIME / 1000 });
  }

  /** The page's poll: once a session was handed over for its code, this browser gets the account. */
  async function codeStatus(/** @type {import('./http.js').Req} */ req, /** @type {import('./http.js').Res} */ res) {
    if (!sameOrigin(req, origin)) return json(res, 403, { error: 'Cross-origin request refused' });
    const body = await readJson(req);
    const row = typeof body?.code === 'string' ? store.get('select * from link_codes where code = ?', body.code) : undefined;
    if (!row || typeof body.poll !== 'string' || !equal(digest(body.poll), row.poll_digest)) return json(res, 404, { error: 'Unknown code' });
    if (row.account_id) {
      store.run('delete from link_codes where code = ?', row.code);
      return json(res, 200, { linked: true }, { 'set-cookie': setAccount(row.account_id) });
    }
    if (row.expires_at < Date.now()) return json(res, 200, { expired: true });
    json(res, 200, { linked: false });
  }

  /** From the CLI: a Paper session for a code. No cookies, no browser. */
  async function claimCode(/** @type {import('./http.js').Req} */ req, /** @type {import('./http.js').Res} */ res, /** @type {string} */ code) {
    if (!CODE_RE.test(code)) return json(res, 400, { error: 'That is not a link code.' });
    const row = store.get('select * from link_codes where code = ? and expires_at > ? and account_id is null', code, Date.now());
    if (!row) return json(res, 404, { error: 'That code is unknown, used or expired. Reload the link page for a new one.' });
    const body = await readJson(req, MAX_SESSION_BYTES);
    const state = body?.storageState;
    if (!state || !Array.isArray(state.cookies)) return json(res, 400, { error: 'Expected { storageState }.' });
    const checked = await paper.validate({ cookies: state.cookies, origins: Array.isArray(state.origins) ? state.origins : [] });
    if (!checked) return json(res, 401, { error: 'Paper did not accept that session. Sign in again and retry.' });
    // Claim atomically: a code links exactly one account.
    const claimed = store.run('update link_codes set account_id = ? where code = ? and account_id is null', checked.user.id, code);
    if (!claimed.changes) return json(res, 409, { error: 'That code was just used.' });
    accounts.link(checked.user, checked.storageState);
    await paper.drop(checked.user.id);
    log.info('Paper account linked by code.');
    json(res, 200, { ok: true, email: checked.user.email });
  }

  return {
    /** The account this browser linked, if it is still linked. @param {import('./http.js').Req} req */
    current(req) {
      const signed = secrets.verify('account', cookies(req)[ACCOUNT_COOKIE]);
      const claim = /** @type {{ id?: string, exp?: number } | undefined} */ (signed);
      if (!claim?.id || !claim.exp || claim.exp < Date.now()) return undefined;
      const account = accounts.get(claim.id);
      return account?.linked ? account : undefined;
    },

    clearCookie: () => cookie(ACCOUNT_COOKIE, '', 0),

    /** @param {import('./http.js').Req} req @param {import('./http.js').Res} res @param {URL} url @returns {Promise<boolean>} */
    async handle(req, res, url) {
      const path = url.pathname;
      if (path === '/link' && req.method === 'GET') return html(res, 200, linkPage({ next: safeNext(url.searchParams.get('next')), origin })), true;
      if (path === '/link/switch' && req.method === 'GET') {
        redirect(res, `${origin}/link`, { next: safeNext(url.searchParams.get('next')) }, { 'set-cookie': cookie(ACCOUNT_COOKIE, '', 0) });
        return true;
      }
      if (req.method !== 'POST') return false;
      if (path === '/link/signin') return await signIn(req, res), true;
      if (path === '/link/code') return createCode(req, res), true;
      if (path === '/link/code/status') return await codeStatus(req, res), true;
      const claim = /^\/link\/code\/([^/]+)$/.exec(path);
      if (claim) return await claimCode(req, res, decodeURIComponent(claim[1]).toUpperCase()), true;
      return false;
    },

    async close() {
      for (const id of [...jobs.keys()]) await endJob(id);
    },
  };
}
