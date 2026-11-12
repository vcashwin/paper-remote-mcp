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

The Worker seals the session into the client's access and refresh tokens. Nothing is written to disk, KV or DO storage.
When Paper renews its cookie, the container returns the new cookies and the Worker reseals them at the next refresh.

## Container HTTP API (internal, port 8080, only reachable through the Worker's container binding)

All bodies JSON. Errors: `{ "error": { "code": "auth" | "limit" | "bad_request" | "internal", "message": string } }`
with HTTP 401 (`auth`: Paper session missing or expired), 429 (`limit`), 400, 500.

- `GET /healthz` → `{ ok: true, engines: { lite: "ready"|"cold"|"failed", browser: "running"|"stopped" } }`
- `POST /catalog` `{ session }` → `{ tools: Tool[], instructions: string }`
  The tool list and instructions from Paper's `getMCPServerConfig(clientInfo, true)`.
- `POST /call` `{ session, tool, args, agentId, clientInfo: { name, transport? } }`
  → `{ result: CallToolResult, session?: Session, engine: "lite" | "browser" }`
  `result` is Paper's own MCP-shaped result (`{ content, isError? }`). `session` is present when cookies changed.
  Routing: tools in `LITE_TOOLS` run on the lite engine; anything else, or a lite failure that is not a tool error,
  runs on the browser engine. A tool naming a `fileId` opens that file first (as `ensureFile` does today).
- `POST /signin/start` `{ email }` → `SignInStep`
- `POST /signin/continue` `{ value }` → `SignInStep` (the container is per sign-in job, so it holds the job in memory)

`SignInStep = { step: "password" | "code" | "done" | "error", message?: string, session?: Session,
user?: { id: string, email: string, name?: string } }` (`done` carries `session` and `user`).

## Worker ↔ container

- `PaperAccount` Durable Object, addressed by Paper user id, owns one container (`instance_type` standard-1,
  sleep after 10 idle minutes). It serialises calls per account and keeps the latest renewed session in memory.
- `PaperSignIn` Durable Object, addressed by a random job id, owns a short-lived container for one sign-in.

## Out of scope / never

- No `/meter/balance` mock or any change to Paper's metering.
- No persistent storage of Paper sessions or passwords; never log cookies, passwords or codes.
