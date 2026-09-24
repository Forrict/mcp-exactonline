import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { createTokenProvider } from "./auth/oauth.js";
import type { TokenStore } from "./auth/tokenStore.js";
import { ExactClient } from "./client.js";
import { registerSystemTools } from "./tools/system.js";

import { registerCrmTools } from "./tools/crm.js";
import { registerFinancialTools } from "./tools/financial.js";
import { registerReportingTools } from "./tools/reporting.js";
import { registerMailboxTools } from "./tools/mailbox.js";
import { registerPipelineTools } from "./tools/pipeline.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerCashflowTools } from "./tools/cashflowExtra.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerHrTools } from "./tools/hr.js";
import { registerSubscriptionTools } from "./tools/subscriptions.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerWriteMoreTools } from "./tools/writes.js";
import { registerSalesTools } from "./tools/sales.js";
import { registerPurchaseTools } from "./tools/purchase.js";
import { registerLogisticsTools } from "./tools/logistics.js";

const SERVER_VERSION = "0.1.0";

/** Tools that create or modify data in Exact Online. */
const WRITE_TOOL_RE = /^exact_(create|update)_/;

export interface ServerOptions {
  /** Skip registering tools that create or modify data. */
  readOnly?: boolean;
}

/** Build an authenticated Exact client for the given config and token store. */
export function createExactClient(
  config: Config,
  store?: TokenStore
): ExactClient {
  return new ExactClient(config, createTokenProvider(config, store));
}

/**
 * Wrap server.registerTool so every tool gets MCP annotations (read-only vs.
 * write), letting clients such as Claude group tools and ask for confirmation
 * on writes. In read-only mode, write tools are not registered at all.
 */
function decorateToolRegistration(server: McpServer, readOnly: boolean): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: { title?: string; annotations?: ToolAnnotations },
    cb: unknown
  ) => unknown;

  const decorated = (
    name: string,
    config: { title?: string; annotations?: ToolAnnotations },
    cb: unknown
  ): unknown => {
    const writes = WRITE_TOOL_RE.test(name);
    if (writes && readOnly) return undefined;
    return register(
      name,
      {
        ...config,
        annotations: {
          title: config.title,
          readOnlyHint: !writes,
          destructiveHint: false,
          idempotentHint: !writes,
          openWorldHint: true,
          ...config.annotations,
        },
      },
      cb
    );
  };
  server.registerTool = decorated as McpServer["registerTool"];
}

/** Build an MCP server with all tool modules registered against `client`. */
export function createServer(
  client: ExactClient,
  options: ServerOptions = {}
): McpServer {
  const server = new McpServer({
    name: "exact-online",
    version: SERVER_VERSION,
  });
  decorateToolRegistration(server, options.readOnly ?? false);

  registerSystemTools(server, client);

  registerCrmTools(server, client);
  registerFinancialTools(server, client);
  registerReportingTools(server, client);
  registerMailboxTools(server, client);
  registerPipelineTools(server, client);
  registerDocumentTools(server, client);
  registerCashflowTools(server, client);
  registerProjectTools(server, client);
  registerHrTools(server, client);
  registerSubscriptionTools(server, client);
  registerInsightTools(server, client);
  registerWriteMoreTools(server, client);
  registerSalesTools(server, client);
  registerPurchaseTools(server, client);
  registerLogisticsTools(server, client);

  return server;
}
