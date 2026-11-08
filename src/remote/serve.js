// `paper-remote-mcp serve`: configuration from the environment, then listen.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSecrets } from './seal.js';
import { openStore } from './store.js';
import { createPaper } from './paper.js';
import { createRemoteServer } from './server.js';
import { log } from '../log.js';

/** A positive integer from the environment, or the default; anything else is a startup error. @param {string} name @param {number} fallback */
function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number (got "${raw}").`);
  return value;
}

/**
 * @param {{ port?: number, host?: string, data?: string, env?: string, headless?: boolean }} [options]
 */
export async function startRemoteServer(options = {}) {
  const publicUrl = process.env.PAPER_MCP_URL;
  if (!publicUrl) throw new Error('PAPER_MCP_URL must be set to this server\'s public URL, e.g. https://paper-mcp.example.com (http://localhost:8787 for local use).');
  const origin = new URL(publicUrl).origin;
  const secrets = createSecrets(process.env.PAPER_MCP_SEAL_KEY ?? '');
  const port = options.port ?? positiveInt('PORT', 8787);
  if (!Number.isInteger(port) || port <= 0) throw new Error('--port must be a positive whole number.');
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const data = options.data ?? process.env.PAPER_MCP_DATA ?? join(homedir(), '.paper-mcp', 'remote');
  mkdirSync(data, { recursive: true });

  const maxEditors = positiveInt('PAPER_MCP_MAX_EDITORS', 8), idleMinutes = positiveInt('PAPER_MCP_IDLE_MINUTES', 10);
  const store = await openStore(join(data, 'paper-mcp.sqlite'));
  const remote = createRemoteServer({
    store,
    secrets,
    origin,
    paper: (sessions) =>
      createPaper({
        sessions,
        env: options.env,
        headless: options.headless !== false,
        maxEditors,
        idleMs: idleMinutes * 60_000,
      }),
  });

  await new Promise((resolve, reject) => remote.server.once('error', reject).listen(port, host, () => resolve(undefined)));
  log.info(`Paper remote MCP listening on http://${host}:${port} — public URL ${origin}/mcp`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.info('Shutting down…');
    await remote.close().catch(() => {});
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return remote;
}
