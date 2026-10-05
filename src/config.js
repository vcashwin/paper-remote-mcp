// Service addresses and constants, mirrored from Paper Desktop's bundled
// `getServiceAddresses()` so this package talks to exactly the same backends.
//
// These are all public values (they ship inside the Paper Desktop binary and
// the web app). Nothing secret lives here.

/**
 * @typedef {Object} PaperEnv
 * @property {string} app        Main web app origin (hosts the editor + MCP handlers)
 * @property {string} api        REST / auth API origin
 * @property {string} auth       WorkOS AuthKit origin (sign-in UI)
 * @property {string} workers    Cloudflare Workers origin (auth redirect bouncer)
 * @property {string} cookieDomain
 * @property {string} workosClientId  Public WorkOS client id (PKCE, no secret)
 */

/** @type {Record<string, PaperEnv>} */
export const ENVIRONMENTS = {
  production: {
    app: 'https://app.paper.design',
    api: 'https://api.paper.design',
    auth: 'https://auth.paper.design',
    workers: 'https://workers.paper.design',
    cookieDomain: '.paper.design',
    // Public client id baked into Paper Desktop (src/auth/auth.ts).
    workosClientId: 'client_01JFDMX4SFDGNY1NN3RRQ4A7Z3',
  },
  staging: {
    app: 'https://app.paper-staging.dev',
    api: 'https://api.paper-staging.dev',
    auth: 'https://auth.paper.design',
    workers: 'https://workers.paper-staging.dev',
    cookieDomain: '.paper-staging.dev',
    workosClientId: 'client_01JFDMX4AM830BWWPR2S94KRH1',
  },
};

/** The local HTTP MCP server Paper Desktop exposes, used by `relay` mode. */
export const DESKTOP_MCP = {
  host: '127.0.0.1',
  port: 29979,
  endpoint: '/mcp',
  /** Live tool catalog served by a running desktop app. */
  configPath: '/mcp/desktop/config.json',
  get url() {
    return `http://${this.host}:${this.port}${this.endpoint}`;
  },
};

export const DEFAULT_ENV = process.env.PAPER_MCP_ENV || 'production';

/** @param {string} [name] */
export function resolveEnv(name) {
  const key = name || DEFAULT_ENV;
  const env = ENVIRONMENTS[key];
  if (!env) {
    throw new Error(`Unknown Paper environment "${key}". Expected one of: ${Object.keys(ENVIRONMENTS).join(', ')}`);
  }
  return { key, ...env };
}

export const SERVER_INFO = {
  name: 'paper-remote-mcp',
  // Kept in sync with package.json manually; read lazily where it matters.
  version: '0.1.0',
};
