// Single-tenant Node host for the remote server (docs/remote-runtime.md): worker.js's fetch handler over plain
// HTTP, with the PaperAccount container replaced by an in-process runtime (runtime/server.js). For a personal or
// team deployment behind a reverse proxy that does TLS (e.g. paper.linefold.app → 127.0.0.1:8080). One Paper
// account per process: the engines hold one account's editor state, so multi-user hosting is the Cloudflare
// deployment (wrangler.toml), not this.
//
//   SEAL_KEY=… PUBLIC_URL=https://paper.example.com PORT=8080 node remote/node.js
import http from 'node:http';
import { register } from 'node:module';

// '@cloudflare/containers' only exists on Workers: a stand-in whose class is never instantiated here (the same
// stub worker.test.js uses; registered before worker.js loads, which is why these imports are dynamic).
const STUB =
  'export class Container { constructor(ctx, env) { this.ctx = ctx; this.env = env; } async stop() {} }';
const HOOKS = `export async function resolve(specifier, context, next) {
  return specifier === '@cloudflare/containers'
    ? { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true }
    : next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);

const { default: worker } = await import('./worker.js');
const { createRuntime } = await import('../runtime/server.js');

const CALL_TIMEOUT = 120_000;
const PORT = Number(process.env.PORT || 8080);
// 0.0.0.0: in Docker the publish rule is what restricts exposure (e.g. -p 127.0.0.1:8081:8080). HOST=127.0.0.1
// tightens a bare local run to loopback.
const HOST = process.env.HOST || '0.0.0.0';
if (!process.env.SEAL_KEY) {
  console.error('SEAL_KEY is required (openssl rand -base64 32)');
  process.exit(2);
}

// The runtime in-process, playing the PaperAccount Durable Object's role (one account, so one stub for every name).
const runtime = createRuntime();
await /** @type {Promise<void>} */ (
  new Promise((resolve) => runtime.server.listen({ port: 0, host: '127.0.0.1' }, () => resolve()))
);
const runtimePort = /** @type {import('node:net').AddressInfo} */ (runtime.server.address()).port;

/** RPC: `/catalog` or `/call`, exactly the shape the Durable Object answers with. @param {string} path @param {object} body */
async function run(path, body) {
  try {
    const res = await fetch(`http://127.0.0.1:${runtimePort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  } catch {
    return { status: 504 };
  }
}

const env = {
  SEAL_KEY: /** @type {string} */ (process.env.SEAL_KEY),
  ...(process.env.PUBLIC_URL && { PUBLIC_URL: process.env.PUBLIC_URL }),
  PAPER_ACCOUNT: { getByName: () => ({ run }) },
};
// waitUntil promises (catalog cache writes, container warm-ups) just run in the background.
const ctx = { waitUntil: (/** @type {Promise<unknown>} */ p) => void p.catch(() => {}) };

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(/** @type {Buffer} */ (chunk));
    const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
      method: req.method,
      headers,
      ...(body && { body, duplex: 'half' }),
    });
    const response = await worker.fetch(request, env, ctx);
    /** @type {Record<string, string | string[]>} */
    const out = {};
    response.headers.forEach((value, name) => {
      if (name !== 'set-cookie') out[name] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
    console.log(`${req.method} ${req.url} ${response.status} ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`${req.method} ${req.url}:`, err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal error');
  }
});

server.listen(PORT, HOST, () => console.log(`paper-remote-mcp listening on http://${HOST}:${PORT}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    runtime.close().finally(() => process.exit(0));
  });
}
