# Deploying the hosted Paper MCP server

`paper-remote-mcp serve` is a remote MCP server. Anyone with a Paper account adds one URL to their AI client, signs in to
Paper once in a popup, and gets Paper's own design tools. This guide covers running it, ideally the same way Linefold runs:
one Docker container behind a Cloudflare Tunnel. How it works is in
[docs/remote-architecture.md](docs/remote-architecture.md).

```
AI client ──HTTPS──▶ Cloudflare Tunnel ──▶ paper-mcp container (:8787)
                                            ├─ /mcp + OAuth front door
                                            ├─ SQLite on /data (grants, keys, sealed Paper sessions)
                                            └─ headless Chromium, one context per Paper account ──▶ app.paper.design
```

> **Trust.** The server holds live Paper sessions, and during sign-in it receives Paper passwords and codes. They are
> typed into Paper's own sign-in page and never stored or logged. Treat the host and `PAPER_MCP_SEAL_KEY` like a password
> vault. Run it for yourself or your team. Opening it to the public needs Paper's agreement.

## 1. Requirements

- Docker 24+ with Compose, on Linux or macOS. Or Node 22.5+ and Google Chrome or Playwright's Chromium, if you run it bare.
- A public HTTPS hostname, for example `paper-mcp.example.com`. Claude.ai and most clients require HTTPS (`localhost` is
  fine for local tests).
- Memory: one warm editor takes about **700 MB** (Chromium plus the Paper editor, measured with `docker stats`). Plan about
  **400 MB for each additional** warm editor, up to `PAPER_MCP_MAX_EDITORS`.
  - A 2 GB box serves about 3 people at once.
  - An 8 GB box serves about 15.
  - Idle editors close after `PAPER_MCP_IDLE_MINUTES`, so you are sizing for people *active* at the same time, not
    for total users.

## 2. Configuration

Every setting is an environment variable; copy [`deploy/paper-mcp.env.example`](deploy/paper-mcp.env.example) to
`deploy/paper-mcp.env`, which git ignores.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `PAPER_MCP_URL` | **yes** | — | The public URL, for example `https://paper-mcp.example.com`. Its origin is the OAuth issuer, and `<origin>/mcp` is the MCP resource. It must match exactly what clients reach, or OAuth discovery fails. |
| `PAPER_MCP_SEAL_KEY` | **yes** | — | The secret all keys derive from: AES-256-GCM sealing of Paper sessions, plus signatures on OAuth state and cookies. Generate it with `openssl rand -base64 32` (at least 16 characters). |
| `PAPER_MCP_DATA` | no | `~/.paper-mcp/remote`, or `/data` in Docker | Holds the SQLite database (`paper-mcp.sqlite`). |
| `PORT` | no | `8787` | The listening port. |
| `HOST` | no | `127.0.0.1`, or `0.0.0.0` in Docker | The listening interface. |
| `PAPER_MCP_MAX_EDITORS` | no | `8` | The most warm editors (Paper accounts) at once. Past it, the least recently used idle editor closes. When all are busy, a call answers "at capacity". |
| `PAPER_MCP_IDLE_MINUTES` | no | `10` | An editor unused this long closes, and its renewed Paper cookie is saved. |
| `PAPER_MCP_ENV` | no | `production` | `production` (app.paper.design) or `staging`. |
| `PAPER_MCP_LOG` | no | `info` | `silent`, `error`, `warn`, `info` or `debug`. At `info` and below, logs never contain tokens, cookies, passwords or codes (`debug` adds the Paper page's own console output). |
| `TUNNEL_TOKEN` | with the tunnel | — | The Cloudflare Tunnel token, read by the optional `cloudflared` service. |

The same settings exist as CLI flags: `serve --port --host --data --env --headful`. `--headful` shows the browser, for
debugging on a desktop.

**Changing `PAPER_MCP_SEAL_KEY`** makes every stored Paper session unreadable. People then see "reconnect", link again,
and carry on. OAuth grants and personal keys keep working once their account is linked again. There is no rotation tool:
change the key only if it leaked.

## 3. Run it with Docker Compose

```bash
git clone https://github.com/vcashwin/paper-remote-mcp && cd paper-remote-mcp
cp deploy/paper-mcp.env.example deploy/paper-mcp.env
$EDITOR deploy/paper-mcp.env          # PAPER_MCP_URL, PAPER_MCP_SEAL_KEY (openssl rand -base64 32)
docker compose -f deploy/compose.yaml up -d --build
curl -s localhost:8787/healthz        # {"ok":true}
```

- The image ([`Dockerfile`](Dockerfile)) is `mcr.microsoft.com/playwright` pinned to the locked Playwright version. It
  includes Node 24 and the matching Chromium, and runs as the non-root `pwuser`.
- `shm_size: 1gb` matters: Chromium crashes with Docker's default 64 MB `/dev/shm`.
- The port is published on `127.0.0.1` only. The public way in is the tunnel (next step) or your own reverse proxy.

### Behind a Cloudflare Tunnel (the way Linefold runs)

1. In Cloudflare Zero Trust, go to **Networks › Tunnels › Create a tunnel** (type *cloudflared*) and copy the token into
   `TUNNEL_TOKEN`.
2. Add a public hostname, for example `paper-mcp.example.com`, with service `http://paper-mcp:8787`.
3. Start it with the tunnel profile:

   ```bash
   docker compose -f deploy/compose.yaml --profile tunnel up -d --build
   ```

4. Optionally, add a WAF rate-limit rule for `/register`, `/link/code/*` and `/link/signin`, for example 10 requests per
   10 s per IP. The server has no rate limiting of its own; Linefold leaves this to Cloudflare as well.

Cloudflare's default timeouts are fine. Tool calls are ordinary request/response POSTs (JSON, no long-lived streams), and
a cold editor start takes about 2–4 s.

**Running it next to Linefold on the same box:** add the `paper-mcp` service to that compose project instead, and add a
second public hostname to Linefold's existing tunnel that points at `http://paper-mcp:8787`. The two services share
nothing else.

### Behind another reverse proxy

Any HTTPS proxy works. Forward everything to `:8787`, allow request bodies of 4 MB, and don't buffer responses. Example
for Caddy: `paper-mcp.example.com { reverse_proxy 127.0.0.1:8787 }`.

## 4. Run it without Docker

```bash
export PAPER_MCP_URL=https://paper-mcp.example.com PAPER_MCP_SEAL_KEY=$(openssl rand -base64 32)
HOST=0.0.0.0 npx -y paper-remote-mcp serve
```

This needs Node 22.5+ (for `node:sqlite`), and Google Chrome or `npx playwright install chromium`. Use a process
manager (systemd, pm2) for restarts, and keep the seal key in the environment, not in the shell history.

For local testing, use `PAPER_MCP_URL=http://localhost:8787` and add `http://localhost:8787/mcp` to your client.

## 5. Connect clients

`GET /` on the server shows the steps below with the right URL filled in.

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http paper https://paper-mcp.example.com/mcp`, then `/mcp` › paper › Authenticate |
| Claude (claude.ai, Desktop, mobile) | Settings › Connectors › **Add custom connector** › paste the URL |
| Cursor | `~/.cursor/mcp.json`: `{ "mcpServers": { "paper": { "url": "https://paper-mcp.example.com/mcp" } } }` |
| VS Code | `.vscode/mcp.json`: `{ "servers": { "paper": { "type": "http", "url": "https://paper-mcp.example.com/mcp" } } }` |
| Codex | `~/.codex/config.toml`: `[mcp_servers.paper]` then `url = "https://paper-mcp.example.com/mcp"` |
| stdio-only clients | `npx -y mcp-remote https://paper-mcp.example.com/mcp` |
| CI and headless agents (no OAuth) | Create a key at `/account`, then send `Authorization: Bearer pmcp_key_…`. With Claude Code: `claude mcp add --transport http paper <url>/mcp --header "Authorization: Bearer pmcp_key_…"` |

The first connection opens a popup that links the person's Paper account. There are two ways to link:

- **Sign in to Paper** in the popup. The server drives Paper's own sign-in: email, then a password or a code, whatever
  Paper asks for.
- **Link from your computer**, for Google and SSO accounts. The popup shows a command like
  `npx -y paper-remote-mcp link ABCD-EFGH --server https://paper-mcp.example.com`. It reuses the computer's
  `paper-remote-mcp login` session, signing in first if needed, and the popup continues by itself.

After that, connecting another client is one **Allow** click. People manage personal keys, connected apps and
**Disconnect** at `/account`.

## 6. Operating it

- **Health:** `GET /healthz` returns `{"ok":true}`. The image's `HEALTHCHECK` uses it.
- **Logs:** `docker compose -f deploy/compose.yaml logs -f paper-mcp`. Use `PAPER_MCP_LOG=debug` for page console output
  and navigation detail.
- **Backups:**
  - The only state is `/data/paper-mcp.sqlite` (WAL mode). Back it up with
    `docker compose -f deploy/compose.yaml exec paper-mcp node -e "new (require('node:sqlite').DatabaseSync)('/data/paper-mcp.sqlite').exec(\"vacuum into '/data/backup.sqlite'\")"`
    and copy `backup.sqlite` off the box.
  - Restoring it needs the same `PAPER_MCP_SEAL_KEY`.
  - Losing the database only means everyone reconnects.
- **Upgrades:** `git pull && docker compose -f deploy/compose.yaml up -d --build`.
  - The schema is created and kept with `create table if not exists`.
  - Restarts close the warm editors after saving their sessions (SIGTERM), so nobody has to re-link.
- **Paper changes:**
  - The server relies on Paper's web sign-in page and on its WebMCP bootstrap (`window.mcpHandlers`), the same as local
    mode.
  - If tools stop loading, run `npx paper-remote-mcp doctor` on any machine. It checks the same bootstrap.
  - If sign-in through the server stops working, "link from your computer" still works.
- **Scaling:** one process and one SQLite file. To grow, give the box more memory and raise `PAPER_MCP_MAX_EDITORS`. More
  than one instance needs shared storage (Postgres) and sticky routing per account. That isn't built; see
  `docs/remote-architecture.md`.
- **Revoking access:**
  - A person: `/account` › Disconnect Paper. That deletes their sealed session, keys and grants.
  - Everyone: stop the server and delete the database.
  - To end the Paper session itself, sign out of Paper's other sessions in Paper's own settings.

## 7. Production checklist

- [ ] `PAPER_MCP_URL` is the exact public HTTPS origin, and `curl https://<host>/.well-known/oauth-protected-resource/mcp`
      returns that origin in `resource`.
- [ ] `PAPER_MCP_SEAL_KEY` is random, stored in a secret manager or a root-only env file, and backed up with the database.
- [ ] The container port is not public; only the tunnel or proxy reaches it.
- [ ] `shm_size` is set, and memory fits `PAPER_MCP_MAX_EDITORS`.
- [ ] The WAF rate limit is on `/register` and `/link/*`.
- [ ] There is a database backup job.
- [ ] Claude Code connects (`claude mcp add --transport http …`, then Authenticate) and `list_resources` returns your files.
