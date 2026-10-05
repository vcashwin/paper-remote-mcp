#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { rmSync } from 'node:fs';
import { startMcpServer } from './mcp/server.js';
import { startRelay } from './mcp/relay.js';
import { login } from './auth/browser-login.js';
import { checkSession, profileDir, profileLockHolder } from './auth/session.js';
import { ProfileInUseError } from './browser.js';
import { createEditorHost, AuthRequiredError } from './editor/host.js';
import { DESKTOP_MCP, resolveEnv, SERVER_INFO } from './config.js';
import { log } from './log.js';

const HELP = `paper-remote-mcp ${SERVER_INFO.version} — run the Paper Design MCP without the desktop app.

Usage:
  paper-remote-mcp <command> [options]

Commands:
  mcp        Start the MCP server over stdio (default). Hosts a headless Paper
             editor using your signed-in session.
  login      Open a browser to sign in to Paper once; the session is reused by
             later headless runs.
  logout     Delete the locally saved Paper session (e.g. to switch accounts).
  doctor     Check Node, the browser, your sign-in, and Paper Desktop.
  relay      Thin stdio -> HTTP relay to a RUNNING Paper Desktop app (bonus;
             still needs the desktop app).
  help       Show this help.

Options:
  --file <id|url>     File to open on start (and the default tool target).
  --env <name>        Paper environment: production (default) or staging.
  --profile <dir>     Override the profile/session directory.
  --headful           Show the browser window (default: headless) for mcp/doctor.
  --client-name <s>   Identify this client to Paper (default: paper-remote-mcp).
  --url <url>         relay only: Paper Desktop MCP URL (default: ${DESKTOP_MCP.url}).

First run:
  npx paper-remote-mcp login
  npx paper-remote-mcp doctor
Then register "npx paper-remote-mcp mcp" as a stdio MCP server in your agent.
`;

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'mcp';
  const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv;

  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      env: { type: 'string' },
      profile: { type: 'string' },
      headful: { type: 'boolean', default: false },
      'client-name': { type: 'string' },
      url: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.help || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${SERVER_INFO.version}\n`);
    return;
  }

  /** @type {import('./editor/host.js').HostOptions & { clientName?: string }} */
  const hostOptions = {
    env: values.env,
    profile: values.profile,
    fileId: values.file,
    headless: !values.headful,
    clientName: values['client-name'],
  };

  switch (command) {
    case 'login':
      await login({ env: values.env, profile: values.profile });
      return;

    case 'logout':
      logout({ env: values.env, profile: values.profile });
      return;

    case 'mcp':
      await startMcpServer(hostOptions);
      return; // keeps running

    case 'relay':
      await startRelay({ url: values.url, clientName: values['client-name'] });
      return; // keeps running

    case 'doctor':
      await doctor(hostOptions);
      return;

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

/**
 * Removes the local profile (cookies included). This signs this machine out; it
 * does not revoke the session on Paper's servers.
 * @param {{ env?: string, profile?: string }} options
 */
function logout(options) {
  const env = resolveEnv(options.env);
  const dir = profileDir(env.key, options.profile);
  const holder = profileLockHolder(dir);
  if (holder) throw new ProfileInUseError(dir, holder.pid);
  rmSync(dir, { recursive: true, force: true });
  process.stderr.write(`Signed out of Paper (${env.key}) on this machine: removed ${dir}\n`);
}

/** @param {import('./editor/host.js').HostOptions} hostOptions */
async function doctor(hostOptions) {
  /** @param {string} s */
  const out = (s) => process.stdout.write(s + '\n');
  const env = resolveEnv(hostOptions.env);
  out(`paper-remote-mcp ${SERVER_INFO.version}`);
  out(`node           ${process.version}`);
  out(`platform       ${process.platform}/${process.arch}`);
  out(`environment    ${env.key} (${env.app})`);

  let host;
  try {
    host = await createEditorHost({ ...hostOptions, readyTimeoutMs: 20_000 });
  } catch (err) {
    if (err instanceof ProfileInUseError) {
      out(`profile        • in use${err.pid ? ` by pid ${err.pid}` : ''} — likely the \`paper\` MCP server your agent is running`);
      out('               Quit that agent (or the process) to run the full check.');
    } else {
      out(`browser        ✗ could not launch (${messageOf(err)})`);
      out('\nFix: install Google Chrome, or run `npx playwright install chromium`.');
      process.exitCode = 1;
    }
    await checkDesktop(out);
    return;
  }
  out('browser        ✓ launched');

  try {
    const session = await checkSession(host.context, host.env);
    if (!session.signedIn) {
      out(`sign-in        ✗ not signed in (Paper API /auth/me → ${session.status ?? 'no response'})`);
      out('\nFix: run `paper-remote-mcp login`.');
      process.exitCode = 1;
      return;
    }
    out('sign-in        ✓ authenticated (Paper API /auth/me → 200)');

    await host.start();
    const config = await host.getConfig({ name: 'paper-remote-mcp-doctor', transport: 'webmcp' });
    out(`handlers       ✓ ${config.tools?.length ?? 0} tools available`);
  } catch (err) {
    out(`handlers       ✗ ${messageOf(err)}`);
    process.exitCode = 1;
  } finally {
    await host.close();
    await checkDesktop(out);
  }
}

/**
 * Is the desktop app also up? Only relevant for `relay`.
 * @param {(s: string) => void} out
 */
async function checkDesktop(out) {
  try {
    const res = await fetch(`http://${DESKTOP_MCP.host}:${DESKTOP_MCP.port}${DESKTOP_MCP.configPath}`, {
      signal: AbortSignal.timeout(2000),
    });
    out(`desktop app    ${res.ok ? '✓ running (relay available)' : '• not detected'}`);
  } catch {
    out('desktop app    • not running (fine — mcp mode does not need it)');
  }
}

main().catch((err) => {
  if (err instanceof AuthRequiredError || err instanceof ProfileInUseError) {
    log.error(err.message);
  } else {
    log.error(err instanceof Error ? err.stack || err.message : String(err));
  }
  process.exitCode = 1;
});
