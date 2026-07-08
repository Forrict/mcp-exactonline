/**
 * Shared helpers for MCP tool handlers. Exported for reuse by all tool
 * modules (system + phase-2 crm/financial/sales/purchase/logistics).
 */

/** MCP tool result shape (subset we use). */
export interface ToolResult {
  // Index signature required for assignability to the SDK's CallToolResult.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Wrap a JSON-serializable value as a successful text tool result. */
export function okJson(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** Wrap an error as an error tool result with a readable message. */
export function errText(e: unknown): ToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
