// The remote server's two HTML pages, in linear-re's design system: CSS is the Linefold MCP consent page's
// (linear-re app/sync-server/mcp/consentTemplate.ts, generated from storybook Pages/McpConsentPage), light and dark tokens
// resolved, its classes kept. Every value put into a page is escaped.
import { CSS } from './style.js';

/** @param {string} value */
const escape = (value) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Our own mark (a folded sheet), not Paper's logo: this server is not Paper's.
const MARK = `<svg width="56" height="56" viewBox="0 0 56 56" role="img" aria-label="Paper Remote MCP"><rect width="56" height="56" rx="12" fill="var(--color-control-primary)"/><path d="M19 14h13l8 8v20H19z" fill="var(--color-control-primary-label)" opacity=".92"/><path d="M32 14v8h8z" fill="var(--color-control-primary)" opacity=".55"/></svg>`;
const ARROWS = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" class="_icon_5lfxx_2" style="--icon-default-color: var(--color-label-muted);"><path d="M5.378 7.5a.6.6 0 0 1 .6.6l-.002 1.774c2.375.224 8.027.917 8.027 1.328 0 .311-2.675.796-8.024 1.453l-.001 1.747a.6.6 0 0 1-.992.454L1.14 11.548a.4.4 0 0 1 0-.607l3.848-3.297a.6.6 0 0 1 .39-.144Zm4.79-6.291a.6.6 0 0 1 .846-.064l3.847 3.309a.4.4 0 0 1 0 .607l-3.848 3.296a.6.6 0 0 1-.99-.455V6.128C7.65 5.904 1.998 5.21 1.998 4.799c0-.31 2.675-.795 8.024-1.452l.001-1.747a.6.6 0 0 1 .145-.391Z"/></svg>`;
const PLACEHOLDER = `<svg width="56" height="56" viewBox="0 0 48 48" aria-hidden="true"><g stroke="var(--color-bg-border)" stroke-width="0.5" fill="none"><rect width="48" height="48" fill="var(--color-bg-shade)" stroke="none"/><path d="M24 0V48M33 0V48M15 0V48M0 24H48M0 33H48M0 15H48M48 0L0 48M0 0L48 48"/><circle cx="24" cy="24" r="18"/><circle cx="24" cy="24" r="13"/></g></svg>`;
// The landing page's additions: a code line and a list, on the same tokens.
const EXTRA = `._code{font-family:var(--font-monospace,ui-monospace,Menlo,monospace);font-size:var(--font-size-small);color:var(--color-label-title);background:var(--color-bg-shade);border:var(--thin-pixel) solid var(--color-bg-border);border-radius:6px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}._list{display:flex;flex-direction:column;gap:12px;align-self:stretch;min-width:0}`;

/** @param {string} title @param {string} body */
const html = (title, body) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex"><title>${title}</title><style>${CSS}${EXTRA}</style></head><body>${body}</body></html>`;

const text = (/** @type {string} */ s, cls = '') => `<span class="_text_1ajf8_17 ${cls}">${s}</span>`;

/**
 * The consent page `/authorize` shows: the client asking, where its codes go, and what approving does.
 * @param {{ clientName: string, redirectUri: string, logoUri?: string, state: string, csrfToken: string }} p
 */
export function consentPage({ clientName, redirectUri, logoUri, state, csrfToken }) {
  const name = escape(clientName);
  const logo = logoUri && /^https:\/\//.test(logoUri) ? `<img src="${escape(logoUri)}" alt="">` : PLACEHOLDER;
  const row = (/** @type {string} */ key, /** @type {string} */ value, wrap = '') =>
    `<div class="_row_1ajf8_24">${text(key, '_medium_1ajf8_19 _key_1ajf8_26')}${text(value, wrap)}</div>`;
  return html(
    `${name} | Authorization Request`,
    `<form class="_form_1ajf8_4" action="/authorize" method="post"><input type="hidden" name="state" value="${escape(state)}"><input type="hidden" name="csrf_token" value="${escape(csrfToken)}">` +
      `<div class="_page_1ajf8_5"><div class="_center_1ajf8_7"><div class="_card_1ajf8_8">` +
      `<div class="_logos_1ajf8_11"><div class="_logo_1ajf8_11 _bordered_1ajf8_13"><span>${logo}</span></div>${ARROWS}<div class="_logo_1ajf8_11">${MARK}</div></div>` +
      `<div class="_heading_1ajf8_16">${text(`<strong>${name}</strong> wants to use your Paper account`, '_title_1ajf8_18')}</div>` +
      `<div class="_details_1ajf8_21">${text('Details', '_medium_1ajf8_19 _muted_1ajf8_20')}<div class="theme-elevated" style="display: contents;"><section class="_table_1ajf8_22">` +
      row('Name:', name) +
      row('Redirect URI:', escape(redirectUri), '_wrap_1ajf8_27') +
      row('Access:', 'Read and write your Paper files') +
      `</section></div></div>` +
      `<div class="_statement_1ajf8_28">` +
      text(`Approving sends you to Paper to sign in. ${name} then reaches Paper's MCP tools through this server, as you.`, '_muted_1ajf8_20') +
      text('Nothing is stored here: your Paper tokens travel encrypted inside the token given to the client, and only this server can read them. Paper Remote MCP is not affiliated with Paper.', '_muted_1ajf8_20') +
      `</div>` +
      `<div class="_actions_1ajf8_32"><button type="submit" name="action" value="deny" class="_base_19pyx_4 _secondary_19pyx_49 _normal_19pyx_116 _padText_19pyx_122 _overlay_19pyx_103">Cancel</button>` +
      `<button type="submit" name="action" value="approve" class="_base_19pyx_4 _primary_19pyx_48 _normal_19pyx_116 _padText_19pyx_122">Continue to Paper</button></div>` +
      `</div></div></div></form>`
  );
}

/**
 * `/`: what this server is and the one line that connects an agent.
 * @param {string} mcpUrl
 */
export function homePage(mcpUrl) {
  const url = escape(mcpUrl);
  const step = (/** @type {string} */ label, /** @type {string} */ code) =>
    `<div class="_details_1ajf8_21">${text(label, '_medium_1ajf8_19 _muted_1ajf8_20')}<div class="_code">${code}</div></div>`;
  return html(
    'Paper Remote MCP',
    `<div class="_page_1ajf8_5"><div class="_center_1ajf8_7"><div class="_card_1ajf8_8">` +
      `<div class="_logos_1ajf8_11"><div class="_logo_1ajf8_11">${MARK}</div></div>` +
      `<div class="_heading_1ajf8_16">${text('Paper Remote MCP', '_title_1ajf8_18')}</div>` +
      `<div class="_statement_1ajf8_28">${text("Connect any MCP client to your Paper account over OAuth. No desktop app, no browser to run, nothing stored on this server.", '_muted_1ajf8_20')}</div>` +
      `<div class="_list">` +
      step('Server URL', url) +
      step('Claude Code', `claude mcp add --transport http paper ${url}`) +
      step('Cursor / VS Code (mcp.json)', escape(JSON.stringify({ mcpServers: { paper: { url: mcpUrl } } }))) +
      `</div>` +
      `<div class="_statement_1ajf8_28">${text('Your client opens a browser to sign in with Paper the first time. Paper Remote MCP is not affiliated with Paper.', '_muted_1ajf8_20')}</div>` +
      `</div></div></div>`
  );
}
