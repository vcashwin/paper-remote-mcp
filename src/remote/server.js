// `paper-remote-mcp serve`: the hosted, multi-user remote MCP server.
//
//   POST /mcp                                     stateless Streamable HTTP (one SDK Server per request)
//   /.well-known/oauth-protected-resource[/mcp]   RFC 9728
//   /.well-known/oauth-authorization-server, /authorize, /token, /register   the front door
//   /link…                                        Link Paper
//   /account                                      linked account, personal keys, connected apps, disconnect
//   /healthz, /                                   health; setup guide
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAccounts } from './accounts.js';
import { createClients } from './clients.js';
import { createFrontDoor, SCOPE } from './frontDoor.js';
import { cors, html, json, readForm, readJson, redirect, sameOrigin, text } from './http.js';
import { createLink } from './link.js';
import { accountPage, homePage, messagePage } from './pages.js';
import { AccountUnlinked, PoolBusy } from './paper.js';
import { normalizeToolResult } from '../mcp/server.js';
import { SERVER_INFO } from '../config.js';
import { log } from '../log.js';

const MAX_MCP_BODY = 4 * 1024 * 1024;

/**
 * @param {{
 *   store: import('./store.js').Store, secrets: import('./seal.js').Secrets,
 *   paper: (sessions: import('./paper.js').Sessions) => import('./paper.js').Paper,
 *   origin: string, allow?: string[],
 * }} o
 */
export function createRemoteServer({ store, secrets, paper: makePaper, origin, allow = [] }) {
  const accounts = createAccounts(store, secrets);
  const paper = makePaper(accounts.sessions);
  const clients = createClients(store, { allow });
  const link = createLink({ store, secrets, accounts, paper, origin });
  const frontDoor = createFrontDoor({ store, secrets, clients, link, origin });
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {boolean} presented */
  const challenge = (req, res, presented) =>
    json(res, 401, presented ? { error: 'invalid_token', error_description: 'Missing or invalid access token' } : { error: 'unauthorized', error_description: 'Authorization needed' }, {
      ...cors(req, false),
      'www-authenticate': `Bearer realm="paper", resource_metadata="${resourceMetadataUrl}", scope="${SCOPE}"${presented ? ', error="invalid_token"' : ''}`,
    });

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function mcp(req, res) {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors(req)).end();
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const who = bearer ? frontDoor.resolve(bearer) : undefined;
    if (!who || !who.linked) return challenge(req, res, !!bearer);
    if (req.method !== 'POST') return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless; POST only.' }, id: null }, { ...cors(req, false), allow: 'POST' });

    const body = await readJson(req, MAX_MCP_BODY);
    if (body === undefined) return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, cors(req, false));
    const messages = Array.isArray(body) ? body : [body];

    let instructions;
    if (messages.some((m) => m?.method === 'initialize')) {
      try {
        instructions = (await paper.config(who.accountId)).instructions;
      } catch (err) {
        if (err instanceof AccountUnlinked) return challenge(req, res, true);
        log.warn('Could not load Paper instructions:', err instanceof Error ? err.message : err);
      }
    }

    const server = new Server({ name: SERVER_INFO.name, version: SERVER_INFO.version }, { capabilities: { tools: {} }, ...(instructions && { instructions }) });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await paper.config(who.accountId)).tools ?? [] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        return normalizeToolResult(await paper.call(who.accountId, who.agentId, name, /** @type {Record<string, unknown>} */ (args ?? {})));
      } catch (err) {
        // An ended Paper session: this answer says so, and the next request gets 401 → the client reconnects.
        const message = err instanceof AccountUnlinked || err instanceof PoolBusy ? err.message : `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`;
        if (!(err instanceof AccountUnlinked)) log.warn(message);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    for (const [key, value] of Object.entries(cors(req, false))) res.setHeader(key, value);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function account(req, res) {
    const current = link.current(req);
    if (!current) return redirect(res, `${origin}/link`, { next: '/account' });
    /** @type {string | undefined} */
    let newKey;
    if (req.method === 'POST') {
      if (!sameOrigin(req, origin)) return text(res, 403, 'Cross-origin request refused');
      const form = await readForm(req), id = form.get('id') ?? '';
      switch (form.get('action')) {
        case 'create_key':
          newKey = frontDoor.createKey(current.id, (form.get('label') ?? '').trim().slice(0, 60));
          break;
        case 'revoke_key':
          store.run('delete from keys where id = ? and account_id = ?', id, current.id);
          break;
        case 'revoke_grant':
          store.run('delete from grants where id = ? and account_id = ?', id, current.id);
          break;
        case 'disconnect':
          await paper.drop(current.id);
          accounts.remove(current.id);
          return html(res, 200, messagePage('Disconnected', 'Your Paper session, keys and connected apps were deleted from this server.'), { 'set-cookie': link.clearCookie() });
        default:
          return text(res, 400, 'Unknown action');
      }
      if (!newKey) return redirect(res, `${origin}/account`); // post/redirect/get
    }
    html(
      res,
      200,
      accountPage({
        email: current.email,
        keys: store.all('select id, label, created_at, used_at from keys where account_id = ? order by created_at', current.id),
        grants: store.all('select id, client_name, created_at from grants where account_id = ? and refresh_digest is not null order by created_at', current.id),
        newKey,
        origin,
      })
    );
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @returns {Promise<void>} */
  async function route(req, res) {
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;
    try {
      if (path === '/mcp' || path === '/mcp/') return void (await mcp(req, res));
      if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
        if (req.method === 'OPTIONS') return void res.writeHead(204, cors(req)).end();
        return json(res, 200, { resource: frontDoor.resource, authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Paper' }, { ...cors(req, false), 'cache-control': 'public, max-age=3600' });
      }
      if (await frontDoor.handle(req, res, url)) return;
      if (path.startsWith('/link') && (await link.handle(req, res, url))) return;
      if (path === '/account') return await account(req, res);
      if (path === '/healthz') return json(res, 200, { ok: true });
      if (path === '/' && req.method === 'GET') return html(res, 200, homePage({ origin }));
      text(res, 404, 'Not found');
    } catch (err) {
      log.error(`${req.method} ${path} failed:`, err instanceof Error ? err.stack || err.message : err);
      if (!res.headersSent) text(res, 500, 'Internal error');
      else res.end();
    }
  }

  const server = http.createServer(route);
  return {
    server,
    paper,
    async close() {
      const closed = new Promise((resolve) => server.close(() => resolve(undefined)));
      server.closeAllConnections();
      await closed;
      await link.close();
      await paper.close();
    },
  };
}
