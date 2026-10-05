// Everything logs to STDERR. stdout is reserved for the MCP JSON-RPC stream —
// writing anything else there corrupts the protocol and the client disconnects.

/** @type {Record<string, number>} */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const current = LEVELS[process.env.PAPER_MCP_LOG || 'info'] ?? LEVELS.info;

/** @param {keyof typeof LEVELS} level @param {unknown[]} args */
function emit(level, args) {
  if ((LEVELS[level] ?? 0) > current) return;
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} [paper-remote-mcp] ${level}: ${args.map(stringify).join(' ')}\n`);
}

/** @param {unknown} v */
function stringify(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  /** @param {...unknown} a */ error: (...a) => emit('error', a),
  /** @param {...unknown} a */ warn: (...a) => emit('warn', a),
  /** @param {...unknown} a */ info: (...a) => emit('info', a),
  /** @param {...unknown} a */ debug: (...a) => emit('debug', a),
};
