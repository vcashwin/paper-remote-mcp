// The few HTML pages remote mode serves: consent, link, account, setup. Plain
// strings, no framework; every interpolated value goes through `esc`.

/** @param {unknown} value */
export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--accent:#2563eb;--danger:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#09090b;--card:#18181b;--fg:#fafafa;--muted:#a1a1aa;--line:#27272a;--accent:#3b82f6}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,system-ui,-apple-system,sans-serif}
main{width:min(440px,92vw);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
main.wide{width:min(720px,94vw)}
h1{font-size:20px;margin:0 0 6px}p{margin:6px 0 14px}.muted{color:var(--muted);font-size:13.5px}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button,.button{display:inline-block;padding:9px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer;text-decoration:none}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--danger)}
.row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}.row>*{flex:1}
code,pre{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.error{color:var(--danger);font-size:13.5px;min-height:1em}hr{border:0;border-top:1px solid var(--line);margin:22px 0}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:8px 4px;border-top:1px solid var(--line);vertical-align:middle}td:last-child{text-align:right}
.code{font:600 26px ui-monospace,Menlo,monospace;letter-spacing:3px;text-align:center;padding:10px;border:1px dashed var(--line);border-radius:10px}
[hidden]{display:none!important}`;

/** A value as a JS literal safe inside <script> (no `</script>` breakout). @param {unknown} value */
const jsLiteral = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** @param {string} title @param {string} body @param {{ wide?: boolean }} [o] */
export const page = (title, body, { wide = false } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main${wide ? ' class="wide"' : ''}>${body}</main></body></html>`;

/** @param {string} title @param {string} message */
export const messagePage = (title, message) => page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);

/**
 * @param {{ clientName: string, redirectHost: string, email: string, state: string, csrf: string, switchUrl: string }} o
 */
export const consentPage = (o) =>
  page(
    'Connect Paper',
    `<h1>Allow ${esc(o.clientName)} to use Paper?</h1>
<p>It will read and edit your Paper files as <b>${esc(o.email)}</b>, using Paper's own design tools.</p>
<p class="muted">After you allow it, you'll go back to <code>${esc(o.redirectHost)}</code>. You can disconnect it from your account page at any time.</p>
<form method="post" action="/authorize">
<input type="hidden" name="state" value="${esc(o.state)}"><input type="hidden" name="csrf_token" value="${esc(o.csrf)}">
<div class="row"><button name="action" value="cancel">Cancel</button><button class="primary" name="action" value="approve" autofocus>Allow</button></div>
</form>
<p class="muted" style="margin-top:18px">Not ${esc(o.email)}? <a href="${esc(o.switchUrl)}">Use a different Paper account</a></p>`
  );

/**
 * Link a Paper account: sign in through the server (email → password / code), or
 * hand over a session from your own computer with a link code.
 * @param {{ next: string, origin: string }} o
 */
export const linkPage = (o) =>
  page(
    'Link your Paper account',
    `<h1>Sign in to Paper</h1>
<p class="muted">This server signs in to Paper for you, the same way Paper's own sign-in page does. Your password is never stored.</p>
<form id="signin">
<label for="value" id="label">Paper email</label>
<input id="value" name="value" type="email" autocomplete="username" required autofocus>
<div class="error" id="error"></div>
<div class="row"><button class="primary" id="submit">Continue</button></div>
</form>
<hr>
<details id="alt"><summary>Use Google or SSO? Link from your computer instead</summary>
<p class="muted">Run this on a computer with Chrome, sign in there however you like, and this page continues by itself:</p>
<pre id="command">…</pre>
</details>
<script>
const next = ${jsLiteral(o.next)}, origin = ${jsLiteral(o.origin)};
const $ = (id) => document.getElementById(id);
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
let currentStep = 'email';
const reset = () => { currentStep = 'email'; $('label').textContent = 'Paper email'; $('value').type = 'email'; $('value').autocomplete = 'username'; };
const steps = {
  password: ['Paper password', 'password', 'current-password'],
  code: ['The code Paper just sent you', 'text', 'one-time-code'],
};
$('signin').onsubmit = async (e) => {
  e.preventDefault();
  $('submit').disabled = true; $('error').textContent = '';
  try {
    const r = await post('/link/signin', { start: currentStep === 'email', value: $('value').value });
    if (r.step === 'done') return location.assign(next);
    if (r.step === 'unsupported') { $('error').textContent = 'This account signs in with Google or SSO. Use "Link from your computer" below.'; $('alt').open = true; reset(); return; }
    if (r.error) $('error').textContent = r.error;
    const s = steps[r.step];
    if (s) { $('label').textContent = s[0]; $('value').type = s[1]; $('value').autocomplete = s[2]; if (!r.error || r.step !== currentStep) $('value').value = ''; currentStep = r.step; $('value').focus(); }
    if (r.step === 'email') reset();
  } catch { $('error').textContent = 'Something went wrong. Try again.'; }
  finally { $('submit').disabled = false; }
};
(async () => {
  const { code, poll } = await post('/link/code', {});
  $('command').textContent = 'npx -y paper-remote-mcp link ' + code + ' --server ' + origin;
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await post('/link/code/status', { code, poll }).catch(() => ({}));
    if (r.linked) return location.assign(next);
    if (r.expired) { $('command').textContent = 'This code expired. Reload the page for a new one.'; return; }
  }
})();
</script>`
  );

/**
 * @param {{ email: string, keys: { id: string, label: string, created_at: number, used_at: number | null }[], grants: { id: string, client_name: string | null, created_at: number }[], newKey?: string, origin: string }} o
 */
export const accountPage = (o) => {
  const day = (/** @type {number | null} */ ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : 'never');
  const button = (/** @type {string} */ action, /** @type {string} */ id, /** @type {string} */ text) =>
    `<form method="post" action="/account" style="display:inline"><input type="hidden" name="id" value="${esc(id)}"><button class="danger" name="action" value="${action}">${text}</button></form>`;
  return page(
    'Paper account',
    `<h1>Paper account</h1><p>Linked as <b>${esc(o.email)}</b>.</p>
<p class="muted">Add <code>${esc(o.origin)}/mcp</code> to any MCP client. <a href="/">Setup guide</a></p>
${o.newKey ? `<hr><p><b>Your new key</b> — copy it now; it won't be shown again.</p><pre>${esc(o.newKey)}</pre><pre>claude mcp add --transport http paper ${esc(o.origin)}/mcp --header "Authorization: Bearer ${esc(o.newKey)}"</pre>` : ''}
<hr><h1 style="font-size:16px">Personal keys</h1><p class="muted">For clients that can't sign in with OAuth: send <code>Authorization: Bearer &lt;key&gt;</code>.</p>
<table>${o.keys.map((k) => `<tr><td>${esc(k.label)}</td><td class="muted">created ${day(k.created_at)} · used ${day(k.used_at)}</td><td>${button('revoke_key', k.id, 'Revoke')}</td></tr>`).join('') || '<tr><td class="muted">No keys.</td></tr>'}</table>
<form method="post" action="/account" class="row"><input name="label" placeholder="Key name, e.g. CI" maxlength="60"><button name="action" value="create_key">Create key</button></form>
<hr><h1 style="font-size:16px">Connected apps</h1>
<table>${o.grants.map((g) => `<tr><td>${esc(g.client_name || 'MCP client')}</td><td class="muted">since ${day(g.created_at)}</td><td>${button('revoke_grant', g.id, 'Disconnect')}</td></tr>`).join('') || '<tr><td class="muted">No connected apps.</td></tr>'}</table>
<hr><form method="post" action="/account"><input type="hidden" name="id" value=""><button class="danger" name="action" value="disconnect">Disconnect Paper and delete everything</button></form>
<p class="muted">Removes your Paper session, keys and connected apps from this server.</p>`,
    { wide: true }
  );
};

/** @param {{ origin: string }} o */
export const homePage = (o) => {
  const url = `${o.origin}/mcp`;
  return page(
    'Paper MCP',
    `<h1>Paper MCP</h1><p>Paper's design tools for any AI agent. Add this URL, then sign in to Paper once when your agent asks:</p>
<pre>${esc(url)}</pre>
<p><b>Claude Code</b></p><pre>claude mcp add --transport http paper ${esc(url)}</pre>
<p><b>Claude (claude.ai, Desktop, mobile)</b> — Settings › Connectors › Add custom connector › paste the URL.</p>
<p><b>Cursor</b> — <code>~/.cursor/mcp.json</code></p><pre>{ "mcpServers": { "paper": { "url": "${esc(url)}" } } }</pre>
<p><b>VS Code</b> — <code>.vscode/mcp.json</code></p><pre>{ "servers": { "paper": { "type": "http", "url": "${esc(url)}" } } }</pre>
<p><b>Codex</b> — <code>~/.codex/config.toml</code></p><pre>[mcp_servers.paper]
url = "${esc(url)}"</pre>
<p><b>ChatGPT</b> — Settings › Connectors (developer mode) › Create › paste the URL, authentication OAuth.</p>
<p><b>Anything that only speaks stdio</b></p><pre>npx -y mcp-remote ${esc(url)}</pre>
<p><b>No OAuth (CI, headless agents)</b> — create a personal key on your <a href="/account">account page</a> and send <code>Authorization: Bearer pmcp_key_…</code>.</p>`,
    { wide: true }
  );
};
