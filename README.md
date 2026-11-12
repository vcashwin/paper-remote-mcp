# paper-remote-mcp

Run [Paper](https://paper.design)'s MCP server without the desktop app.

![paper-remote-mcp — Paper's MCP, without the app.](./.github/banner.svg)

`paper-remote-mcp` loads the Paper editor in a headless browser, signed in as you, and exposes the same tools Paper Desktop does (`write_html`, `get_screenshot`, `get_jsx`, `create_file`, …) over stdio. It works with Claude Code, Cursor, Codex, or any MCP client.

```bash
npx paper-remote-mcp login    # one-time OAuth sign-in
npx paper-remote-mcp doctor   # check browser, sign-in, tools
claude mcp add paper -- npx -y paper-remote-mcp mcp
```

> Community project. Not affiliated with or endorsed by Paper.

## Remote server (OAuth, nothing to install)

`remote/` is a hosted way in: one URL, OAuth in the browser, nothing to install. A Cloudflare Worker is the OAuth front door and the MCP endpoint; Paper's own MCP tools run in a container per active Paper account (`runtime/`, see [docs/remote-runtime.md](docs/remote-runtime.md)). Signing in happens on our page: you give your Paper email, and a short-lived container drives Paper's real sign-in page with what you type (your password, or the code Paper emails you). The pages use Linefold's design system.

```bash
claude mcp add --transport http paper https://<your-worker>/mcp
```

```
  MCP client ──OAuth 2.1 (DCR or CIMD, PKCE)──► remote/worker.js (Cloudflare Worker)
      │                                            │ consent → sign-in pages
      │                                            ▼
      │                                PaperSignIn DO ─► container: Paper's sign-in page ─► session cookies
      │
      └──── /mcp, Bearer <sealed session> ─► Worker ─► PaperAccount DO (per Paper user) ─► container: Paper's tools
```

**Nothing is stored on the server.** There is no database, KV, or log of tokens. Everything the Worker hands out is AES-256-GCM ciphertext under one secret (`SEAL_KEY`), sealed for a single purpose, and it carries its own state:

| What the client holds | Inside (encrypted)                                     | Lives                    |
| --------------------- | ------------------------------------------------------ | ------------------------ |
| `client_id` (DCR)     | its redirect URIs, name, logo                          | until `SEAL_KEY` changes |
| authorization `code`  | Paper session cookies, user, the client's PKCE request | 60 s                     |
| `access_token`        | Paper session cookies, user id, grant id               | 1 h                      |
| `refresh_token`       | the same, plus the client id                           | 30 days                  |

A Paper session is the cookies Paper's sign-in sets for its app on `paper.design` (the filter is `paperCookies` in `runtime/paper.js`). Tokens are compressed before sealing, about 3 KB each. Each request uses only the session sealed in its own token: the account's Durable Object passes it to its container, one call at a time, and remembers nothing. Every refresh asks Paper (`/auth/me`) whether that session is still signed in: if not, the client must sign in again; if so, the cookie renewals Paper sends back go into the new tokens. If Paper can't be reached, the refresh fails with 503 and the refresh token stays valid. Initialize and `tools/list` answer from a per-client catalog cache (1 h) while the account's container starts in the background; a container sleeps after 10 idle minutes.

**Trust: read this before you deploy or connect.**

- **You type your Paper password on this server's domain, not Paper's.** That is what a phishing page looks like. Only sign in on an instance you (or someone you trust) deployed, and check the URL. The consent page shows where the client's code goes and marks clients that registered themselves (DCR) as unverified.
- Your password or emailed code passes through the Worker and the sign-in container on its way to Paper's real sign-in page. Neither stores or logs it.
- **Every token carries a live Paper session**, sealed under `SEAL_KEY`. Whoever has `SEAL_KEY` and a token can act as you in Paper. A leaked `SEAL_KEY` exposes every session in every outstanding token until its refresh token expires (30 days) or the user signs out in Paper; rotating it signs everyone out.
- **Revoking = signing out in Paper.** There is no server-side revocation (nothing is stored); an access token keeps working until it expires, so a sign-out takes effect within an hour. Removing the server from your client just drops its tokens.
- While an account is active, its container holds the Paper session in memory (never on disk or in storage).
- A code can be replayed within its 60 s, but it is useless without the client's PKCE verifier.
- Sign-in is rate limited (Workers Rate Limiting): 10 steps a minute per IP, 2 sign-in starts a minute per email. Containers are capped by `max_instances` in `remote/wrangler.toml` (cost and capacity knobs).

**Deploy** (needs **Workers Paid** for Containers, and Docker running: wrangler builds the image from `runtime/Dockerfile`):

```bash
cd remote
npm install                           # @cloudflare/containers
npx wrangler secret put SEAL_KEY      # paste: openssl rand -base64 32
npx wrangler deploy
```

Optional `PUBLIC_URL`: set it when a proxy in front changes the origin the Worker sees (e.g. a tunnel). Local dev, containers included (Docker runs them): put `SEAL_KEY=…` in `remote/.dev.vars`, then `npm run remote:dev`. Run the tests with `npm test`.

The local `npx` server below is still the way to drive the editor directly (and the open file) from your own machine.

## Requirements

- Node 20+
- Google Chrome, or Playwright's Chromium (`npx playwright install chromium`)

## Setup

**1. Sign in.** `npx paper-remote-mcp login` opens a browser window at `app.paper.design`. Sign in as usual; the session is saved to `~/.paper-mcp/profiles/production/` and reused headlessly.

**2. Verify.**

```
$ npx paper-remote-mcp doctor
browser        ✓ launched
sign-in        ✓ authenticated (Paper API /auth/me → 200)
handlers       ✓ 36 tools available
```

**3. Add it to your agent.**

<details open>
<summary>Claude Code</summary>

```bash
claude mcp add paper -- npx -y paper-remote-mcp mcp
```

</details>

<details>
<summary>Cursor — <code>~/.cursor/mcp.json</code></summary>

```json
{ "mcpServers": { "paper": { "command": "npx", "args": ["-y", "paper-remote-mcp", "mcp"] } } }
```

</details>

<details>
<summary>Codex — <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.paper]
command = "npx"
args = ["-y", "paper-remote-mcp", "mcp"]
```

</details>

<details>
<summary>VS Code — <code>.vscode/mcp.json</code></summary>

```json
{ "servers": { "paper": { "type": "stdio", "command": "npx", "args": ["-y", "paper-remote-mcp", "mcp"] } } }
```

</details>

To open a specific file on start, append `--file <fileId-or-url>` to the args.

## Commands

| Command            | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `mcp` _(default)_  | Start the stdio MCP server backed by a headless editor.   |
| `login` / `logout` | Sign in, or delete the saved session.                     |
| `doctor`           | Check Node, browser, sign-in, and tool availability.      |
| `relay`            | Forward stdio to a _running_ Paper Desktop (no CLI binary needed). |

| Flag               | Meaning                                     |
| ------------------ | ------------------------------------------- |
| `--file <id\|url>` | File to open and use as the default target. |
| `--env <name>`     | `production` (default) or `staging`.        |
| `--profile <dir>`  | Override the session directory.             |
| `--headful`        | Show the browser window.                    |

Env vars: `PAPER_MCP_ENV`, `PAPER_MCP_PROFILE`, `PAPER_MCP_LOG` (`silent|error|warn|info|debug`).

## How it works

Paper Desktop's MCP server is a thin proxy: every tool call runs against `window.mcpHandlers` inside the editor page. Paper only builds those handlers in the desktop shell or in a browser that supports WebMCP.

`paper-remote-mcp` injects a no-op `navigator.modelContext` before the page loads. Paper then builds its real handlers and keeps using normal cookie auth. The stdio server maps `tools/list` to `getMCPServerConfig()` and `tools/call` to `handleToolCall()`, and navigates to another file when a tool call names a different `fileId`. The tool list and instructions come from Paper itself, so they stay in sync with Paper's updates.

## Limitations

- One file is open at a time; switching files costs a page reload.
- The headless browser takes a few seconds to start and uses a few hundred MB of RAM.
- It depends on Paper's web internals. If Paper changes them, `doctor` will report it.
- It uses its own Chrome profile, not your everyday one: Chrome locks a profile to one process and blocks automation of the default profile.

## Troubleshooting

- **"Profile is in use by another browser":** your agent is already running the server. Quit it, or pass a different `--profile`.
- **Not signed in after `login`:** run `login` again and wait for `✓ Signed in`. If Google sign-in is refused, use **Continue with email**.
- **Switch accounts:** `logout`, then `login`.

## Programmatic API

```js
import { createEditorHost } from 'paper-remote-mcp';

const host = await createEditorHost({ fileId: '…' });
await host.start();
const result = await host.handleToolCall('agent-1', 'get_basic_info', {}, { name: 'my-app' });
await host.close();
```

## Development

```bash
git clone https://github.com/vcashwin/paper-remote-mcp && cd paper-remote-mcp
npm install
node src/cli.js login     # one-time sign-in (skip if already signed in)
node src/cli.js doctor    # browser ✓, sign-in ✓, 36 tools ✓
npm run typecheck
```

Point your agent at the local checkout so code changes apply on the next server start:

```bash
# Claude Code (user scope = every project)
claude mcp add -s user paper-remote -- node "$PWD/src/cli.js" mcp
claude mcp get paper-remote          # should show ✔ Connected

# Codex
codex mcp add paper-remote -- node "$PWD/src/cli.js" mcp
```

Or for Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.paper-remote]
command = "node"
args = ["/absolute/path/to/paper-remote-mcp/src/cli.js", "mcp"]
```

Only one server can use a profile at a time. To run Claude and Codex together, give one its own with `--profile ~/.paper-mcp/codex` (and run `login` with that profile once).

MIT © vcashwin
