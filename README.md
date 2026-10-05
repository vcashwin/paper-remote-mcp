# paper-mcp

> **Run the Paper Design MCP without the desktop app.**

Sign in with your [Paper](https://paper.design) account, host the Paper editor **headlessly in a browser**, and expose the _same_ MCP tools the desktop app exposes (`write_html`, `get_screenshot`, `get_jsx`, `create_file`, …) over stdio — for Claude Code, Cursor, Codex, or any MCP client.

Sign in once, then it runs headless:

```bash
npx paper-mcp login      # one-time: sign in with your Paper account (OAuth)
npx paper-mcp doctor     # verify Node + browser + sign-in + tools
npx paper-mcp mcp        # start the stdio MCP server
```

> Status: v0.1, community project. Not affiliated with or endorsed by Paper. Uses only your own authenticated account and Paper's own public endpoints.

---

## Why this exists

Paper ships an MCP server, but it is wired into the **desktop app**. If you look at how it actually works (see [How it works](#how-it-works)), the MCP "server" inside Paper Desktop is a thin proxy — every tool call is executed by running JavaScript against `window.mcpHandlers` inside the **Paper editor renderer**. There is no standalone implementation of the tools; they manipulate the live editor.

So "just run it with `npx` and skip the app" has one hard requirement: **something has to host the editor renderer.** That something doesn't have to be Paper's Electron app — it can be a browser page you control. `paper-mcp` does exactly that:

- **No desktop app.** A headless Chromium (or your installed Chrome) loads `app.paper.design`.
- **Real sign-in.** You authenticate through Paper's normal WorkOS AuthKit OAuth flow, once; the session is reused headlessly afterward.
- **Same tools.** The tool catalog, instructions, and behavior come straight from Paper's own renderer, so they track Paper's updates automatically.
- **npx-friendly & extensible.** Plain ESM, no build step, clean module boundaries, and a programmatic API.

---

## Install & first run

Requires **Node 20+** and a Chromium-based browser. The easiest path uses your existing **Google Chrome**; otherwise install Playwright's bundled Chromium once:

```bash
# Option A — use your installed Google Chrome (nothing extra to download).
# Option B — install Playwright's Chromium:
npx playwright install chromium
```

Then:

```bash
npx paper-mcp login
```

A browser window opens at `app.paper.design`. Sign in exactly as you normally would (SSO and password managers work). `login` finishes on its own once Paper's API confirms the session (`/auth/me` → 200); press **Enter** to re-check right away. Your session is saved to `~/.paper-mcp/profiles/production/`.

Verify everything:

```bash
npx paper-mcp doctor
```

```
paper-mcp 0.1.0
node           v22.x
environment    production (https://app.paper.design)
browser        ✓ launched
sign-in        ✓ authenticated (Paper API /auth/me → 200)
handlers       ✓ 36 tools available
desktop app    • not running (fine — mcp mode does not need it)
```

---

## Register it with your agent

`paper-mcp mcp` is a standard **stdio** MCP server. Add it the same way you'd add any stdio server.

### Claude Code

`~/.claude.json` (or project `.mcp.json`):

```json
{
  "mcpServers": {
    "paper": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "paper-mcp", "mcp"]
    }
  }
}
```

Or in one line:

```bash
claude mcp add paper -- npx -y paper-mcp mcp
```

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "paper": { "command": "npx", "args": ["-y", "paper-mcp", "mcp"] }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.paper]
command = "npx"
args = ["-y", "paper-mcp", "mcp"]
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "paper": { "type": "stdio", "command": "npx", "args": ["-y", "paper-mcp", "mcp"] }
  }
}
```

> Pin a file to open at startup with `"args": ["-y", "paper-mcp", "mcp", "--file", "<fileId-or-url>"]`.
> Run `npx paper-mcp login` first — the server inherits that saved session.

---

## Commands

| Command                     | What it does                                                               |
| --------------------------- | -------------------------------------------------------------------------- |
| `paper-mcp mcp` _(default)_ | Start the stdio MCP server backed by a headless editor.                    |
| `paper-mcp login`           | Interactive OAuth sign-in; stores the session for headless reuse.          |
| `paper-mcp logout`          | Delete the locally saved session (e.g. to switch accounts).                |
| `paper-mcp doctor`          | Diagnose Node, browser, sign-in, tool availability, desktop app.           |
| `paper-mcp relay`           | **Bonus:** thin stdio→HTTP relay to a _running_ Paper Desktop (see below). |
| `paper-mcp help`            | Show help.                                                                 |

### Options

| Flag                | Meaning                                                   |
| ------------------- | --------------------------------------------------------- |
| `--file <id\|url>`  | File to open on start and use as the default tool target. |
| `--env <name>`      | `production` (default) or `staging`.                      |
| `--profile <dir>`   | Override the session directory.                           |
| `--headful`         | Show the browser window (debugging).                      |
| `--client-name <s>` | How to identify this client to Paper.                     |
| `--url <url>`       | `relay` only: Paper Desktop MCP URL.                      |

Environment variables: `PAPER_MCP_ENV`, `PAPER_MCP_PROFILE`, `PAPER_MCP_LOG` (`silent|error|warn|info|debug`).

## How it works

```
  Agent (Claude Code / Cursor / …)
        │  MCP over stdio
        ▼
  ┌─────────────────────────┐
  │        paper-mcp         │
  │  MCP stdio server        │
  │        │                 │
  │        ▼ page.evaluate   │
  │  headless Chromium ──────┼──►  https://app.paper.design  (your session)
  │   • WebMCP shim injected │          Paper editor renderer
  │   • window.mcpHandlers   │          • getMCPServerConfig()
  └─────────────────────────┘          • handleToolCall()
```

1. **Hosting the editor.** `paper-mcp` launches a persistent browser context (so cookies survive) and opens `app.paper.design`.
2. **The WebMCP shim (the key trick).** Paper's web bootstrap only builds `window.mcpHandlers` when it detects the Electron desktop shell **or** a WebMCP-capable browser:

   ```js
   const Rae = NUt();                   // NUt() === "does navigator.modelContext.registerTool exist?"
   (bn /* desktop */ || Rae) && (window.resolveMCPHandlers = /* build handlers */);
   ```

   `paper-mcp` injects a tiny no-op `navigator.modelContext` **before page scripts run**. That flips Paper into WebMCP mode, so it builds the real handlers — and, unlike pretending to be the desktop shell, it keeps using ordinary **web cookie auth** with no Electron/ipcRenderer surface to stub.

3. **Serving MCP.** The stdio server mirrors Paper Desktop's own bridge:
   - `tools/list` → `window.mcpHandlers.getMCPServerConfig(clientInfo, true)` (live catalog + instructions).
   - `tools/call` → `window.mcpHandlers.handleToolCall(agentId, name, args, clientInfo)`.
   - On a tool that names a different `fileId`, the page navigates to that file first (per-file routing, like the desktop's background tabs).

This is effectively a browser-based re-implementation of Paper Desktop's `PAPER_HEADLESS_MCP` mode.

### Authentication

Sign-in is Paper's normal **WorkOS AuthKit OAuth** flow, completed in the browser `paper-mcp` controls. The resulting session cookies persist in the profile directory, so headless runs are already authenticated — the same way a browser keeps you logged in between launches. `paper-mcp` never sees or stores your password, and talks only to Paper's own public endpoints with _your_ account.

> On Paper's MCP OAuth schema: Paper Desktop's local server intentionally is **not** an OAuth MCP server (it returns 404 on `/.well-known/oauth-*` so clients don't try an OAuth handshake). Its auth is WorkOS, not the MCP OAuth spec. `paper-mcp` follows the same model: OAuth to _Paper_ (to get your session), plain stdio to your _agent_ (no auth needed for a local stdio child process).

---

## `relay` mode (bonus)

If you _do_ keep Paper Desktop installed and running, `paper-mcp relay` is a zero-dependency re-implementation of Paper's bundled `paper mcp` Go binary: it forwards stdio MCP to the desktop's local server at `http://127.0.0.1:29979/mcp`.

```bash
paper-mcp relay            # requires the Paper desktop app to be open
```

This removes the need for Paper's shipped CLI binary, but **not** the desktop app. For a truly app-free setup, use `mcp` (the default).

---

## Limitations

- Tools run against the **open editor page**, so they act on one file at a time; `paper-mcp` navigates between files automatically when a tool call names a different `fileId`, which costs a short reload per switch.
- A headless browser isn't free — expect a few seconds of startup and a few hundred MB of RAM while the server runs.
- This rides on Paper's current web internals (the WebMCP shim, `window.mcpHandlers`). If Paper changes those, `paper-mcp doctor` will tell you, and the shim may need an update.
- Single user per profile directory; run multiple environments/accounts with `--profile`.

---

## Why a separate browser window?

`login` opens a visible Chrome window with its own profile (`~/.paper-mcp/profiles/<env>`), not your everyday Chrome profile:

- **Chrome allows one process per profile.** Your normal Chrome is almost always running and holds its profile, so using it would mean quitting Chrome every time the MCP server starts.
- **Chrome 136+ refuses automation on its default profile** on purpose, so tools can't take over your real browser.
- **Your profile's cookies are encrypted with your Keychain key.** Copying them out is what infostealer malware does, so `paper-mcp` doesn't.
- **The MCP server runs Chrome for as long as your agent runs**, so it needs a profile that won't collide with yours anyway.

The usual way to sign in through your everyday browser is the CLI pattern `gh auth login` uses: open your default browser, then redirect to a `localhost` callback. That needs Paper to allow such a redirect for third-party clients, and today Paper's sign-in only redirects to its own desktop app (`paper://`) or its web app. If Paper adds that (or personal access tokens), `paper-mcp` can switch to it.

You only sign in once. **Continue with email** (Paper emails you a code) works in any browser. If Google sign-in is refused in the separate window, use email instead.

## Troubleshooting

**`doctor` says "not signed in" after `login`.** Run `paper-mcp login` again and wait for `✓ Signed in`. Login only succeeds once Paper's API returns 200 for `/auth/me`. If it keeps saying not signed in after you finish in the browser, the status it prints (e.g. `/auth/me → 401`) tells you what Paper returned.

**"The Paper profile … is in use by another browser".** Chrome allows one process per profile. While your agent runs the `paper` MCP server, `login`, `logout` and `doctor` can't open the same profile. Quit the agent (or that process) first, or use a separate `--profile`.

**Switching accounts.** `paper-mcp logout`, then `paper-mcp login`.

**Browser won't launch.** `paper-mcp` uses your installed Google Chrome and falls back to Playwright's Chromium only when Chrome isn't installed (`npx playwright install chromium`). The same browser is used for `login` and `mcp`, so the session cookies stay readable.

---

## Programmatic API

```js
import { createEditorHost, startMcpServer, login } from 'paper-mcp';

const host = await createEditorHost({ fileId: 'XXXXXXXXXXXXXXXXXXXXXXXXXX', headless: true });
await host.start();
const { tools, instructions } = await host.getConfig({ name: 'my-app' });
const result = await host.handleToolCall('agent-1', 'get_basic_info', {}, { name: 'my-app' });
await host.close();
```

Exports: `createEditorHost`, `startMcpServer`, `startRelay`, `login`, `checkSession`, `launchContext`, `parseFileId`, `profileDir`, `profileLockHolder`, `resolveEnv`, `ENVIRONMENTS`, `DESKTOP_MCP`, `AuthRequiredError`, `ProfileInUseError`.

---

## Development

```bash
git clone https://github.com/vcashwin/paper-mcp
cd paper-mcp
npm install
node src/cli.js login
node src/cli.js doctor
npm run typecheck     # JSDoc types checked via tsc --checkJs
```

## License

MIT © vcashwin
