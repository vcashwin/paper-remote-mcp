// One call per Paper MCP tool through the lite engine, on the scratch file only. The meter mock drops
// /meter/record-mcp, so these calls are not recorded against the account's weekly quota; still run it deliberately,
// it drives the real service:
//   PAPER_SESSION_FILE=/path/session.json node runtime/live-matrix.mjs [out.json]
// Writes per-tool { ok, isError, ms, excerpt } so LITE_TOOLS in lite.js can be checked against real results.
// Skipped: create_folder (would create a second resource in the account).
import { readFileSync, writeFileSync } from 'node:fs';
import { createLiteEngine, LITE_TOOLS } from './lite.js';

const SCRATCH = 'paper-remote-mcp scratch (ASH-259)';
const sessionFile = process.env.PAPER_SESSION_FILE;
if (!sessionFile) {
  console.error('Set PAPER_SESSION_FILE to a Playwright cookie array (or { cookies }).');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(sessionFile, 'utf8'));
const engine = await createLiteEngine({
  session: { cookies: Array.isArray(raw) ? raw : raw.cookies },
  log: { debug() {}, info: console.log, warn: console.warn, error: console.error },
});
const clientInfo = { name: 'live-matrix', transport: 'http' };
const results = {};

/** Last JSON text block of a Paper result (file tools prepend a file header block). */
function data(r) {
  for (const c of [...(r?.content ?? [])].reverse()) {
    try {
      const v = JSON.parse(c.text);
      return v?.data ?? v;
    } catch {}
  }
  return null;
}
/** First value under any of `keys`, searching depth-first. */
function find(v, keys) {
  if (!v || typeof v !== 'object') return undefined;
  for (const k of keys) if (typeof v[k] === 'string') return v[k];
  for (const k of keys) if (Array.isArray(v[k]) && typeof v[k][0] === 'string') return v[k][0];
  for (const x of Object.values(v)) {
    const hit = find(x, keys);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function call(tool, args) {
  const missing = (v) =>
    v === undefined ||
    (!!v && typeof v === 'object' && Object.entries(v).some(([k, x]) => k === 'undefined' || missing(x)));
  if (missing(args)) {
    results[tool] = { skipped: `missing input: ${JSON.stringify(args)}` };
    console.log(`SKIP ${tool}`);
    return null;
  }
  const t0 = Date.now();
  let r;
  try {
    r = await engine.call({ tool, args, agentId: 'live-matrix', clientInfo });
  } catch (err) {
    results[tool] = { ok: false, threw: `${err.code}: ${err.message}`, ms: Date.now() - t0 };
    console.log(`THROW ${tool} ${err.message}`);
    return null;
  }
  const text = (r.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : `[${c.type} ${c.mimeType ?? ''} ${c.data?.length ?? 0}b]`))
    .join('\n');
  if (/Weekly MCP limit reached/.test(text)) {
    console.error('Weekly MCP limit reached; stopping.');
    await finish();
  }
  results[tool] = {
    ok: !r.isError,
    isError: !!r.isError,
    ms: Date.now() - t0,
    lite: LITE_TOOLS.has(tool),
    excerpt: text.slice(0, 600),
  };
  console.log(
    `${r.isError ? 'ERR ' : 'ok  '} ${tool.padEnd(28)} ${String(Date.now() - t0).padStart(6)}ms ${text.replace(/\s+/g, ' ').slice(0, 120)}`,
  );
  return r;
}

async function finish() {
  writeFileSync(process.argv[2] ?? 'live-matrix.json', JSON.stringify(results, null, 2));
  await engine.close();
  process.exit(0);
}

await call('get_guide', { topic: 'paper-mcp-instructions' });
const list = data(await call('list_resources', { limit: 200 }));
let fileId = list?.resources?.find((x) => x.name === SCRATCH && x.type !== 'folder')?.id;
if (!fileId) fileId = data(await call('create_file', { name: SCRATCH }))?.fileId;
else results.create_file = { skipped: 'scratch file exists' };
if (!fileId) await finish();
const parentId = list?.resources?.find((x) => x.id === fileId)?.parentId;

// Structure
const info = data(await call('get_basic_info', { fileId }));
const pageId = info?.pageId;
const newPage = find(data(await call('create_page', { fileId, name: 'lite matrix' })), ['pageId', 'id']);
await call('update_pages', { fileId, updates: [{ pageId: newPage, name: 'lite matrix (renamed)' }] });
const pageIds = (info?.pages ?? []).map((p) => p.id);
await call('arrange_pages', {
  fileId,
  order: newPage ? [...pageIds.filter((id) => id !== newPage), newPage] : undefined,
});

// Content
const board = find(
  data(
    await call('create_artboard', {
      fileId,
      pageId,
      name: 'lite matrix',
      styles: { width: '480px', height: '320px', backgroundColor: '#ffffff' },
    }),
  ),
  ['nodeId', 'id', 'ids', 'nodeIds'],
);
await call('write_html', {
  fileId,
  targetNodeId: board,
  mode: 'insert-children',
  html: '<div style="display:flex;flex-direction:column;gap:8px;padding:24px"><h1 style="font-family:Inter;font-size:28px;margin:0">Hello lite</h1><p style="font-family:Inter;font-size:14px;margin:0">Body copy</p></div>',
});

// Reads
await call('get_tree_summary', { fileId, nodeId: board });
await call('get_children', { fileId, nodeId: board });
await call('get_node_info', { fileId, nodeId: board });
await call('get_jsx', { fileId, nodeId: board });
const found = data(await call('find_nodes', { fileId, textValue: 'Hello lite' }));
const text = found?.nodes?.[0]?.id;
await call('get_selection', { fileId });
await call('get_font_family_info', { fileId, familyNames: ['Inter'] });
await call('get_fill_image', { fileId, nodeId: board });

// Writes
await call('set_text_content', { fileId, updates: [{ nodeId: text, html: 'Hello lite engine' }] });
await call('rename_nodes', { fileId, updates: [{ nodeId: text, name: 'Matrix title' }] });
await call('update_styles', { fileId, updates: [{ nodeIds: [board], styles: { backgroundColor: '#f4f4f5' } }] });
const dup = find(data(await call('duplicate_nodes', { fileId, nodes: [{ id: board }] })), [
  'nodeId',
  'id',
  'ids',
  'nodeIds',
  'newNodeId',
]);
await call('move_nodes', { fileId, moves: [{ nodeId: text, parentId: board }] });

// Layout / raster (expected to differ from the browser engine)
await call('get_computed_styles', { fileId, nodeIds: [board] });
await call('get_screenshot', { fileId, nodeId: board });
await call('export', { fileId, nodes: { [board]: [{ format: 'png' }] } });
await call('export_combined_pdf', { fileId, nodeIds: [board] });

// Tokens
await call('create_tokens', { fileId, tokens: [{ type: 'color', name: '--lite-matrix', value: '#ff0000' }] });
await call('get_tokens', { fileId });
await call('set_tokens', { fileId, tokens: [{ name: '--lite-matrix', delete: true }] });

// Comments (scratch file has none: these exercise the not-found paths)
await call('list_comment_threads', { fileId });
await call('list_comment_thread_authors', { fileId });
await call('get_comment_thread', { fileId, commentThreadId: 'none' });
await call('set_comment_thread_status', { fileId, commentThreadId: 'none', status: 'resolved' });

// Cleanup + resources (scratch file only)
await call('delete_nodes', { fileId, nodeIds: dup ? [dup] : undefined });
await call('finish_working_on_nodes', { fileId, nodeIds: [board] });
await call('rename_resource', { resourceId: fileId, name: SCRATCH });
await call('archive_resources', { resourceIds: [fileId] });
await call('unarchive_resources', { resourceIds: [fileId] });
await call('move_resources', { resourceIds: [fileId], parentId });
await call('open_file', { fileId });
await finish();
