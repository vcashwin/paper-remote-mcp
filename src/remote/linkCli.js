// `paper-remote-mcp link <CODE> --server <url>`: hand this computer's Paper session
// to a hosted server, for accounts the server can't sign in to itself (Google, SSO).
// Uses the session `paper-remote-mcp login` keeps, signing in first if there is none.
// (Measured 2026-11-08: two copies of a Paper session renew independently without
// signing each other out, so sharing it is safe.)
import { login } from '../auth/browser-login.js';
import { profileDir, whoAmI } from '../auth/session.js';
import { launchContext } from '../browser.js';
import { resolveEnv } from '../config.js';

/** @param {string} dir @param {import('../config.js').PaperEnv} env */
async function readSession(dir, env) {
  const context = await launchContext(dir, { headless: true });
  try {
    const { user } = await whoAmI(context, env);
    return user ? await context.storageState() : null;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * @param {string} code
 * @param {{ server?: string, env?: string, profile?: string }} options
 */
export async function linkToServer(code, options) {
  const server = options.server || process.env.PAPER_MCP_SERVER;
  if (!code || !server) throw new Error('Usage: paper-remote-mcp link <CODE> --server <https://your-server> (copy the command from the link page).');
  const env = resolveEnv(options.env);
  const dir = profileDir(env.key, options.profile);

  let storageState = await readSession(dir, env);
  if (!storageState) {
    const ok = await login({ env: env.key, profile: options.profile, successMessage: '\n✓ Signed in. Sending the session to the server…\n' });
    if (!ok) return false;
    storageState = await readSession(dir, env);
    if (!storageState) throw new Error('Sign-in did not complete.');
  }

  const res = await fetch(new URL(`/link/code/${encodeURIComponent(code.trim().toUpperCase())}`, server), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ storageState }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = /** @type {{ ok?: boolean, email?: string, error?: string }} */ (await res.json().catch(() => ({})));
  if (!res.ok || !body.ok) throw new Error(body.error || `The server answered ${res.status}.`);
  process.stderr.write(`✓ Linked ${body.email || 'your Paper account'} to ${new URL(server).host}. The browser page continues by itself.\n`);
  return true;
}
