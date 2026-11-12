// node --test runtime/lite.test.js
// Live part: PAPER_SESSION_FILE=/path/to/session.json (Playwright cookie array) node --test runtime/lite.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LITE_TOOLS, createLiteEngine, parseFileId, toHappyCookie, toPlaywrightCookie } from "./lite.js";

const SCRATCH = "paper-remote-mcp scratch (ASH-259)";

test("parseFileId accepts ids, routes and URLs", () => {
  const id = "01KQ3Z0ZJ9W4P8V6X2N7T5R3MB";
  assert.equal(parseFileId(id), id);
  assert.equal(parseFileId(`https://app.paper.design/file/${id}?page=1`), id);
  assert.equal(parseFileId(`/file/${id}`), id);
  assert.equal(parseFileId("nope"), null);
  assert.equal(parseFileId(undefined), null);
});

test("cookies round-trip between Playwright and happy-dom shapes", () => {
  const cookies = [
    { name: "a", value: "1", domain: ".paper.design", path: "/", expires: 1893456000, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "__Host-b", value: "2", domain: "api.paper.design", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" },
  ];
  for (const c of cookies) assert.deepEqual(toPlaywrightCookie(toHappyCookie(c)), c);
  assert.equal(toHappyCookie(cookies[1]).domain, "", "host-only cookie stays host-only");
});

test("layout/raster tools are never routed to the lite engine", () => {
  for (const t of ["get_screenshot", "export", "export_combined_pdf", "get_computed_styles"]) {
    assert.ok(!LITE_TOOLS.has(t), t);
  }
});

const sessionFile = process.env.PAPER_SESSION_FILE;
test("live: boot, catalog, get_basic_info and a write on the scratch file", { skip: !sessionFile, timeout: 180_000 }, async (t) => {
  const raw = JSON.parse(readFileSync(/** @type {string} */ (sessionFile), "utf8"));
  const engine = await createLiteEngine({ session: { cookies: Array.isArray(raw) ? raw : raw.cookies }, log: { debug() {} } });
  const clientInfo = { name: "lite.test", transport: "http" };
  /** Paper's payload: the last JSON text block (file tools prepend a file header block). */
  const call = async (tool, args) => {
    const r = await engine.call({ tool, args, agentId: "lite-test", clientInfo });
    const text = r.content.map((c) => c.text ?? "").join("\n");
    if (/Weekly MCP limit reached/.test(text)) return null;
    assert.ok(!r.isError, `${tool}: ${text}`);
    const v = JSON.parse(r.content.at(-1).text);
    return v.data ?? v;
  };
  try {
    const { tools, instructions } = await engine.catalog(clientInfo);
    assert.ok(tools.length > 30 && typeof instructions === "string");
    for (const name of LITE_TOOLS) assert.ok(tools.some((x) => x.name === name), `catalog has ${name}`);
    assert.ok(engine.session().cookies.length > 0);

    const list = await call("list_resources", { limit: 200 });
    if (!list) return t.skip("weekly MCP limit reached (metered tools unavailable until Saturday 00:00 UTC)");
    const fileId =
      list.resources.find((r) => r.name === SCRATCH && r.type !== "folder")?.id ??
      (await call("create_file", { name: SCRATCH })).fileId;
    assert.ok(fileId, "scratch file id");

    const info = await call("get_basic_info", { fileId });
    assert.equal(info.fileName, SCRATCH);
    const name = `lite ${Date.now()}`;
    assert.ok(await call("update_pages", { fileId, updates: [{ pageId: info.pageId, name }] }));
    const after = await call("get_basic_info", { fileId });
    assert.equal(after.pages.find((p) => p.id === info.pageId)?.name, name);
  } finally {
    await engine.close();
  }
});
