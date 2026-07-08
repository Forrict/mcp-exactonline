import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { createTokenProvider } from "./auth/oauth.js";
import { ExactClient } from "./client.js";
import { registerSystemTools } from "./tools/system.js";

import { registerCrmTools } from "./tools/crm.js";
import { registerFinancialTools } from "./tools/financial.js";
import { registerSalesTools } from "./tools/sales.js";
import { registerPurchaseTools } from "./tools/purchase.js";
import { registerLogisticsTools } from "./tools/logistics.js";

const SERVER_VERSION = "0.1.0";

/**
 * Build a fully-wired MCP server: loads config, sets up OAuth + the Exact
 * client, and registers all available tool modules.
 */
export function createServer(): McpServer {
  const config = loadConfig();
  const getToken = createTokenProvider(config);
  const client = new ExactClient(config, getToken);

  const server = new McpServer({
    name: "exact-online",
    version: SERVER_VERSION,
  });

  registerSystemTools(server, client);

  registerCrmTools(server, client);
  registerFinancialTools(server, client);
  registerSalesTools(server, client);
  registerPurchaseTools(server, client);
  registerLogisticsTools(server, client);

  return server;
}
