// The remote server's HTML pages (landing, consent, sign-in), in Linefold's design system: the CSS (style.js) is the
// Linefold MCP consent page's, light and dark tokens resolved, so the hashed class names below must match it. Every
// value is escaped.
import { CSS } from './style.js';

/** @param {string} value */
const escape = (value) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Our own mark (a folded sheet), not Paper's logo: this server is not Paper's.
const MARK = `<svg width="56" height="56" viewBox="0 0 56 56" role="img" aria-label="Paper Remote MCP"><rect width="56" height="56" rx="12" fill="var(--color-control-primary)"/><path d="M19 14h13l8 8v20H19z" fill="var(--color-control-primary-label)" opacity=".92"/><path d="M32 14v8h8z" fill="var(--color-control-primary)" opacity=".55"/></svg>`;
const ARROWS = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" class="_icon_5lfxx_2" style="--icon-default-color: var(--color-label-muted);"><path d="M5.378 7.5a.6.6 0 0 1 .6.6l-.002 1.774c2.375.224 8.027.917 8.027 1.328 0 .311-2.675.796-8.024 1.453l-.001 1.747a.6.6 0 0 1-.992.454L1.14 11.548a.4.4 0 0 1 0-.607l3.848-3.297a.6.6 0 0 1 .39-.144Zm4.79-6.291a.6.6 0 0 1 .846-.064l3.847 3.309a.4.4 0 0 1 0 .607l-3.848 3.296a.6.6 0 0 1-.99-.455V6.128C7.65 5.904 1.998 5.21 1.998 4.799c0-.31 2.675-.795 8.024-1.452l.001-1.747a.6.6 0 0 1 .145-.391Z"/></svg>`;
const PLACEHOLDER = `<svg width="56" height="56" viewBox="0 0 48 48" aria-hidden="true"><g stroke="var(--color-bg-border)" stroke-width="0.5" fill="none"><rect width="48" height="48" fill="var(--color-bg-shade)" stroke="none"/><path d="M24 0V48M33 0V48M15 0V48M0 24H48M0 33H48M0 15H48M48 0L0 48M0 0L48 48"/><circle cx="24" cy="24" r="18"/><circle cx="24" cy="24" r="13"/></g></svg>`;
// Additions on the same tokens: the landing page's code line and list, the sign-in page's field and error line.
const EXTRA = `._input{font:inherit;font-size:var(--font-size-small);color:var(--color-label-title);background:var(--color-bg-base);border:var(--thin-pixel) solid var(--color-bg-border);border-radius:6px;padding:9px 12px;width:100%;box-sizing:border-box}._input:focus{outline:2px solid var(--color-control-primary);outline-offset:-1px}._error{color:#e5484d}._code{font-family:var(--font-monospace,ui-monospace,Menlo,monospace);font-size:var(--font-size-small);color:var(--color-label-title);background:var(--color-bg-shade);border:var(--thin-pixel) solid var(--color-bg-border);border-radius:6px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}._list{display:flex;flex-direction:column;gap:12px;align-self:stretch;min-width:0}`;

/** @param {string} title @param {string} body */
const html = (title, body) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex"><title>${title}</title><style>${CSS}${EXTRA}</style></head><body>${body}</body></html>`;

const span = (/** @type {string} */ s, cls = '') => `<span class="_text_1ajf8_17 ${cls}">${s}</span>`;

/** Where a redirect URI sends the browser: its host, and "this computer" for a loopback one @param {string} uri */
function destination(uri) {
  const { host, hostname } = new URL(uri);
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? `${host} (this computer)` : host || uri;
}

/**
 * The consent page `/authorize` shows: the client asking, where its codes go, and what approving does. A client with
 * a metadata document (CIMD) shows that document's host; a registered one (DCR) could be anyone, and says so.
 * @param {{ clientName: string, redirectUri: string, logoUri?: string, clientHost?: string, state: string,
 *   csrfToken: string }} p
 */
export function consentPage({ clientName, redirectUri, logoUri, clientHost, state, csrfToken }) {
  const name = escape(clientName);
  const logo = logoUri && /^https:\/\//.test(logoUri) ? `<img src="${escape(logoUri)}" alt="">` : PLACEHOLDER;
  const row = (/** @type {string} */ key, /** @type {string} */ value, wrap = '') =>
    `<div class="_row_1ajf8_24">${span(key, '_medium_1ajf8_19 _key_1ajf8_26')}${span(value, wrap)}</div>`;
  return html(
    `${name} | Authorization Request`,
    `<form class="_form_1ajf8_4" action="/authorize" method="post"><input type="hidden" name="state" value="${escape(state)}"><input type="hidden" name="csrf_token" value="${escape(csrfToken)}">` +
      `<div class="_page_1ajf8_5"><div class="_center_1ajf8_7"><div class="_card_1ajf8_8">` +
      `<div class="_logos_1ajf8_11"><div class="_logo_1ajf8_11 _bordered_1ajf8_13"><span>${logo}</span></div>${ARROWS}<div class="_logo_1ajf8_11">${MARK}</div></div>` +
      `<div class="_heading_1ajf8_16">${span(`<strong>${name}</strong> wants to use your Paper account`, '_title_1ajf8_18')}</div>` +
      `<div class="_statement_1ajf8_28">${span(`Returns you to <strong>${escape(destination(redirectUri))}</strong>`, '_medium_1ajf8_19')}` +
      (clientHost
        ? span(`Client published by <strong>${escape(clientHost)}</strong>`, '_muted_1ajf8_20')
        : `<span role="alert">${span(`Unverified app — only continue if you started this from <strong>${name}</strong>.`, '_error')}</span>`) +
      `</div>` +
      `<div class="_details_1ajf8_21">${span('Details', '_medium_1ajf8_19 _muted_1ajf8_20')}<div class="theme-elevated" style="display: contents;"><section class="_table_1ajf8_22">` +
      row('Name:', name) +
      (clientHost ? row('Client ID host:', escape(clientHost)) : '') +
      row('Redirect URI:', escape(redirectUri), '_wrap_1ajf8_27') +
      row('Access:', 'Read and write your Paper files') +
      `</section></div></div>` +
      `<div class="_statement_1ajf8_28">` +
      span(
        `Continuing asks you to sign in to Paper on the next page. ${name} then uses Paper's MCP tools through this server, as you.`,
        '_muted_1ajf8_20',
      ) +
      span(
        'Nothing is stored here: your Paper session travels encrypted inside the token given to the client, and only this server can read it. While your tools run, a container holds it in memory. Paper Remote MCP is not affiliated with Paper.',
        '_muted_1ajf8_20',
      ) +
      `</div>` +
      `<div class="_actions_1ajf8_32"><button type="submit" name="action" value="deny" class="_base_19pyx_4 _secondary_19pyx_49 _normal_19pyx_116 _padText_19pyx_122 _overlay_19pyx_103">Cancel</button>` +
      `<button type="submit" name="action" value="approve" class="_base_19pyx_4 _primary_19pyx_48 _normal_19pyx_116 _padText_19pyx_122">Continue</button></div>` +
      `</div></div></div></form>`,
  );
}

const SIGN_IN = {
  email: {
    title: 'Sign in to Paper',
    label: 'Your Paper email',
    input: 'type="email" name="email" autocomplete="username" maxlength="320"',
  },
  password: {
    title: 'Enter your Paper password',
    label: 'Password',
    input: 'type="password" name="value" autocomplete="current-password"',
  },
  code: {
    title: 'Check your email',
    label: 'The code Paper emailed you',
    input: 'type="text" name="value" inputmode="numeric" autocomplete="one-time-code" spellcheck="false"',
  },
};

/**
 * The sign-in page, one step at a time: the email first, then what Paper asks for (its password, or the code it
 * emailed), with Paper's own error text when it has one. Continue shows it's working while Paper answers (up to a
 * minute): the page's one script, allowed by `nonce`.
 * @param {{ flow: string, step: 'email' | 'password' | 'code', email?: string, message?: string, nonce: string }} p
 */
export function signInPage({ flow, step, email = '', message, nonce }) {
  const { title, label, input } = SIGN_IN[step];
  const value = step === 'email' ? ` value="${escape(email)}"` : '';
  return html(
    `${title} | Paper Remote MCP`,
    `<form class="_form_1ajf8_4" action="/signin" method="post"><input type="hidden" name="flow" value="${escape(flow)}"><input type="hidden" name="step" value="${step}">` +
      (step === 'email' ? '' : `<input type="hidden" name="email" value="${escape(email)}">`) +
      `<div class="_page_1ajf8_5"><div class="_center_1ajf8_7"><div class="_card_1ajf8_8">` +
      `<div class="_logos_1ajf8_11"><div class="_logo_1ajf8_11">${MARK}</div></div>` +
      `<div class="_heading_1ajf8_16">${span(title, '_title_1ajf8_18')}</div>` +
      (step === 'email'
        ? ''
        : `<div class="_statement_1ajf8_28">${span(`Signing in as <strong>${escape(email)}</strong>`, '_muted_1ajf8_20')}</div>`) +
      (message
        ? `<div class="_statement_1ajf8_28" role="alert">${span(escape(String(message)), '_error')}</div>`
        : '') +
      `<label class="_details_1ajf8_21">${span(label, '_medium_1ajf8_19 _muted_1ajf8_20')}<input class="_input" ${input}${value} required autofocus></label>` +
      `<div class="_statement_1ajf8_28">${span("This server signs in to Paper's own sign-in page for you, with what you type here. It never stores your password or code. Paper Remote MCP is not affiliated with Paper.", '_muted_1ajf8_20')}</div>` +
      `<div class="_actions_1ajf8_32"><button type="submit" class="_base_19pyx_4 _primary_19pyx_48 _normal_19pyx_116 _padText_19pyx_122">Continue</button></div>` +
      `</div></div></div></form>` +
      `<script nonce="${escape(nonce)}">document.forms[0].addEventListener('submit',function(){var b=this.querySelector('button');b.disabled=true;b.setAttribute('aria-busy','true');b.textContent='Signing in…'})</script>`,
  );
}

/**
 * `/`: what this server is and the one line that connects an agent.
 * @param {string} mcpUrl
 */
export function homePage(mcpUrl) {
  const url = escape(mcpUrl);
  const step = (/** @type {string} */ label, /** @type {string} */ code) =>
    `<div class="_details_1ajf8_21">${span(label, '_medium_1ajf8_19 _muted_1ajf8_20')}<div class="_code">${code}</div></div>`;
  return html(
    'Paper Remote MCP',
    `<div class="_page_1ajf8_5"><div class="_center_1ajf8_7"><div class="_card_1ajf8_8">` +
      `<div class="_logos_1ajf8_11"><div class="_logo_1ajf8_11">${MARK}</div></div>` +
      `<div class="_heading_1ajf8_16">${span('Paper Remote MCP', '_title_1ajf8_18')}</div>` +
      `<div class="_statement_1ajf8_28">${span('Connect any MCP client to your Paper account over OAuth. No desktop app, nothing to install, nothing stored on this server.', '_muted_1ajf8_20')}</div>` +
      `<div class="_list">` +
      step('Server URL', url) +
      step('Claude Code', `claude mcp add --transport http paper ${url}`) +
      step('Cursor / VS Code (mcp.json)', escape(JSON.stringify({ mcpServers: { paper: { url: mcpUrl } } }))) +
      `</div>` +
      `<div class="_statement_1ajf8_28">${span('Your client opens a browser to sign in with Paper the first time. Paper Remote MCP is not affiliated with Paper.', '_muted_1ajf8_20')}</div>` +
      `</div></div></div>`,
  );
}
