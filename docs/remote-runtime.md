# Remote runtime: Paper's own MCP tools, hosted, without a browser per user

Status: in progress (ASH-259). This file is the contract the pieces are built against.

## Why

`mcp.paper.design` runs Paper's web editor in a server-side browser (`remote_agent` mode). We do the same job
lighter: Paper's tool code (`MCPHandlers` chunk) mostly works on the document model (`editorState`), which syncs as
JSON over `wss://sync.paper.design/sync/<fileId>`. Only layout tools (screenshot, export, computed styles, HTML
measurement) need a real layout engine. So each account gets a **lite engine** (Paper's bundle in a lightweight DOM in
Node) and a **browser engine** (Chromium) that starts only when a tool needs it.

Paper's own tool wrapper gates metered tools on `GET /meter/balance` and reports usage to
`workers.paper.design/meter/record-mcp` on every call. Both engines inject `meterMock` (`runtime/paper.js`):
`/meter/balance` answers with a synthetic always-full balance (`mcpCap: 10000`), so the client-side weekly-limit
gate never trips, and `/meter/record-mcp` is acknowledged locally without reaching Paper, so no usage is recorded.

## Pieces

```
MCP client ──OAuth + /mcp──► Worker (remote/worker.js)        stateless: Paper cookies sealed in our tokens
                                │ tools/call, catalog
                                ▼
                   Durable Object per Paper account          (no storage: memory only)
                                │ container.fetch
                                ▼
                   Container (runtime/server.js, Node 22)   one per active account, sleeps when idle
                     ├─ lite engine   (runtime/lite.js)     Paper bundle in happy-dom, sync socket, handlers
                     └─ browser engine (runtime/browser.js) Playwright Chromium, src/editor/host.js approach
```

Sign-in needs no container: it is two plain POSTs from the Worker (below).

## Session

A Paper session is the set of cookies Paper's sign-in sets on `.paper.design` (Playwright cookie objects, filtered
to domains ending in `paper.design`): the sealed session cookie and the `paper-preauth-user-info` cookie Paper's
auth bootstrap needs (without it the app never loads the user). Paper's API only accepts this cookie session for
first-party clients, so sign-in uses **Paper's own OAuth, the way Paper Desktop signs in**:

1. After consent, our page opens Paper's hosted sign-in (`api.workos.com/user_management/authorize` with Paper
   Desktop's public first-party client and a fresh PKCE pair, redirecting to Paper's `desktop-redirect` page).
2. The user signs in on Paper's page — no password or emailed code ever touches this server — and Paper shows an
   "Opening Paper…" page whose `paper://auth/callback?code=…` link the user pastes back.
3. The Worker exchanges the code with Paper (`POST api.paper.design/auth/desktop-callback`, with the PKCE verifier
   that never left the sealed flow) for `sealedSession` + `cosmeticInfo`, mints the two cookies, and confirms the
   session with `/auth/me` (also who the session is for).

The coupling: we ride Paper Desktop's public client, so a rotation or a tightened `desktop-callback` breaks
sign-in until re-extracted — the same class of coupling as driving Paper's web bundle at all.

`Session = { cookies: PlaywrightCookie[] }`

The Worker seals the session into the client's access token (1 h) and refresh token (30 days). Nothing is written to
disk, KV or DO storage, and nothing remembers a session between requests: each request uses only the session sealed in
its own token. On refresh the Worker calls `GET https://api.paper.design/auth/me` with the token's cookies: 401 →
`invalid_grant` (sign in again); 200 → the `Set-Cookie` renewals Paper sends back (it renews the session cookie on
every call) are merged in and sealed into new tokens; no answer or 5xx → 503 `temporarily_unavailable`, the refresh
token stays valid. So signing out in Paper ends every token within an hour.

## Container HTTP API (internal, port 8080, only reachable through the Worker's container binding)

All bodies JSON. Errors: `{ "error": { "code": "auth" | "limit" | "bad_request" | "internal", "message": string } }`
with HTTP 401 (`auth`: Paper session missing or expired), 429 (`limit`), 400, 500.

- `GET /healthz` → `{ ok: true, engines: { lite: "ready"|"cold"|"failed", browser: "running"|"stopped" } }`
- `POST /catalog` `{ session, clientInfo: { name, transport: "remote" } }` → `{ tools: Tool[], instructions: string }`
  The tool list and instructions from Paper's `getMCPServerConfig(clientInfo, true)`. The Worker caches it per client
  name for an hour (module memory + the colo's Cache API); on `initialize` it still calls `/catalog` in the background
  to start the account's container, so the first `tools/call` doesn't wait for a cold start.
- `POST /call` `{ session, tool, args, agentId, clientInfo: { name, transport: "remote" } }`
  → `{ result: CallToolResult, engine: "lite" | "browser" }`
  `result` is Paper's own MCP-shaped result (`{ content, isError? }`).
  Routing: tools in `LITE_TOOLS` run on the lite engine; anything else, or a lite failure that is not a tool error,
  runs on the browser engine. A tool naming a `fileId` opens that file first (as `ensureFile` does today).

## Worker ↔ container

- `PaperAccount` Durable Object, addressed by Paper user id, owns one container (`instance_type` standard-1,
  sleep after 10 idle minutes, `max_instances` 50). It serialises calls per account and keeps nothing.

## Out of scope / never

- No persistent storage of Paper sessions; never log cookies or the one-time codes from Paper's sign-in link.
