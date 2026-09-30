/**
 * Shared helpers for MCP tool handlers. Exported for reuse by all tool
 * modules (system + phase-2 crm/financial/sales/purchase/logistics).
 */

import { z } from "zod";

/**
 * Optional per-call division (administration) override, shared by all
 * division-scoped tools. Defaults to EXACT_DIVISION / the current division.
 */
/** Shared dry-run flag for all write tools: preview by default, post on false. */
export const dryRunParam = z
  .boolean()
  .optional()
  .describe(
    "When true (the DEFAULT), nothing is posted: the tool returns a preview of the exact body it would send. Set false explicitly to post."
  );

/** Audit line for write actions (lands in CloudWatch on Lambda). */
export function audit(tool: string, division: unknown, summary: string): void {
  console.log(
    JSON.stringify({ audit: { tool, division: division ?? "default", summary } })
  );
}

export const divisionParam = z
  .union([z.number().int().positive(), z.string()])
  .optional()
  .describe(
    "Division (administration) to query: a division code, or a division name — names are matched automatically against the administration list (e.g. 'acme holding' or a unique part of the name). Defaults to the configured/current division."
  );

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
