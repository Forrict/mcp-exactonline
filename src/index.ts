#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createExactClient, createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(createExactClient(config), {
    readOnly: config.readOnly,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // IMPORTANT: never write to stdout — the stdio transport owns it for JSON-RPC.
  process.stderr.write("exact-online MCP server started (stdio).\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal: ${message}\n`);
  process.exit(1);
});
