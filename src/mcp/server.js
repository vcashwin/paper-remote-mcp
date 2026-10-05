import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createEditorHost, AuthRequiredError } from '../editor/host.js';
import { SERVER_INFO } from '../config.js';
import { log } from '../log.js';

/**
 * Start the Paper MCP server over stdio. Hosts a headless Paper editor and
 * proxies MCP tool traffic into its `window.mcpHandlers`, the same handlers the
 * desktop app exposes.
 *
 * @param {import('../editor/host.js').HostOptions & { clientName?: string }} [options]
 */
export async function startMcpServer(options = {}) {
  const host = await createEditorHost(options);

  try {
    await host.start();
  } catch (err) {
    await host.close();
    throw err;
  }

  // One stdio process serves exactly one client, so a single agent id is fine.
  const agentId = randomUUID();
  const clientInfo = { name: options.clientName || 'paper-remote-mcp', transport: 'webmcp' };

  // Prime the catalog once so we can hand the client Paper's own instructions.
  const initialConfig = await host.getConfig(clientInfo);
  log.info(`Paper exposed ${initialConfig.tools?.length ?? 0} tools.`);

  const server = new Server(
    { name: SERVER_INFO.name, version: SERVER_INFO.version },
    {
      capabilities: { tools: {} },
      instructions: initialConfig.instructions,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Re-fetch each time: the catalog can shift with the open file.
    const config = await host.getConfig(clientInfo);
    return { tools: config.tools ?? [] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = /** @type {Record<string, unknown>} */ (args ?? {});
    try {
      // Route to the requested file if the tool names one (desktop parity).
      if ('fileId' in toolArgs) {
        await host.ensureFile(toolArgs.fileId);
      }
      const result = await host.handleToolCall(agentId, name, toolArgs, clientInfo);
      return normalizeToolResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Tool "${name}" failed: ${message}`);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('Paper MCP server ready on stdio.');

  const shutdown = async () => {
    log.info('Shutting down…');
    await host.removeAgent(agentId);
    await server.close().catch(() => {});
    await host.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  transport.onclose = shutdown;

  return { server, host };
}

/**
 * Paper's renderer already returns MCP-shaped `{ content, isError }` results, but
 * guard against anything that isn't so the SDK never rejects a response.
 * @param {unknown} result
 */
function normalizeToolResult(result) {
  if (result && typeof result === 'object' && Array.isArray(/** @type {any} */ (result).content)) {
    return result;
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  return { content: [{ type: 'text', text }] };
}

export { AuthRequiredError };
