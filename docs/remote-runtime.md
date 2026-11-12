# Remote runtime: Paper's own MCP tools, hosted, without a browser per user

Status: in progress (ASH-259). This file is the contract the pieces are built against.

## Why

`mcp.paper.design` runs Paper's web editor in a server-side browser (`remote_agent` mode). We do the same job
lighter: Paper's tool code (`MCPHandlers` chunk) mostly works on the document model (`editorState`), which syncs as
JSON over `wss://sync.paper.design/sync/<fileId>`. Only layout tools (screenshot, export, computed styles, HTML
measurement) need a real layout engine. So each account gets a **lite engine** (Paper's bundle in a lightweight DOM in
Node) and a **browser engine** (Chromium) that starts only when a tool needs it.

Paper's own tool wrapper enforces the weekly MCP limit and calls `workers.paper.design/meter/record-mcp` on every
call. We run that code unmodified and never mock `/meter/balance`, so usage is metered exactly as in Paper.

## Pieces

```
MCP client ──OAuth + /mcp──► Worker (remote/worker.js)        stateless: Paper cookies sealed in our tokens
                                │ tools/call, catalog, sign-in
                                ▼
                   Durable Object per Paper account / sign-in job   (no storage: memory only)
                                │ container.fetch
                                ▼
                   Container (runtime/server.js, Node 22)   one per active account, sleeps when idle
                     ├─ lite engine   (runtime/lite.js)     Paper bundle in happy-dom, sync socket, handlers
                     ├─ browser engine (runtime/browser.js) Playwright Chromium, src/editor/host.js approach
                     └─ sign-in        (runtime/signin.js)  drives Paper's sign-in page step by step
```

## Session

A Paper session is the set of cookies Paper's sign-in sets on `.paper.design` (Playwright cookie objects, filtered
to domains ending in `paper.design`). Paper only accepts its cookie session (`api.paper.design` ignores Bearer tokens),
so the user signs in to Paper's real sign-in page, driven by the container, once per connection.

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
- `POST /signin/start` `{ email }` → `SignInStep`
- `POST /signin/continue` `{ value }` → `SignInStep` (the container is per sign-in job, so it holds the job in memory)

`SignInStep = { step: "password" | "code" | "done" | "error", message?: string, session?: Session,
user?: { id: string, email: string, name?: string } }` (`done` carries `session` and `user`). A `done` the Worker
didn't receive in time (it waits 90 s) is kept for 60 s and returned to the retry of the same step.

## Worker ↔ container

- `PaperAccount` Durable Object, addressed by Paper user id, owns one container (`instance_type` standard-1,
  sleep after 10 idle minutes, `max_instances` 50). It serialises calls per account and keeps nothing.
- `PaperSignIn` Durable Object, addressed by a random job id, owns a short-lived container for one sign-in (sleep
  after 2 idle minutes, `max_instances` 25), stopped as soon as a step returns `done` or `error`.
- Sign-in abuse limits (Workers Rate Limiting bindings, approximate and per Cloudflare location): every sign-in step
  10/min per client IP (`CF-Connecting-IP`), sign-in starts 2/min per email (SHA-256 of the lowercased address).

## Out of scope / never

- No `/meter/balance` mock or any change to Paper's metering.
- No persistent storage of Paper sessions or passwords; never log cookies, passwords or codes.
