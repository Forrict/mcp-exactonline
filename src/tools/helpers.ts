/**
 * Shared helpers for MCP tool handlers. Exported for reuse by all tool
 * modules (system + phase-2 crm/financial/sales/purchase/logistics).
 */

import { z } from "zod";

/** Loose GUID format (8-4-4-4-12 hex). Exact GUIDs are not always RFC 4122 versioned. */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Schema for GUID parameters. GUIDs are interpolated into OData paths and
 * `$filter` expressions (`guid'...'`), so they must be validated strictly to
 * rule out injection of extra OData syntax.
 */
export const guid = z.string().regex(GUID_RE, "Must be a GUID (8-4-4-4-12 hex digits).");

/**
 * Escape a string literal for an OData v3 `$filter` expression by doubling any
 * embedded single quotes and wrapping it in quotes. e.g. `O'Brien` -> `'O''Brien'`.
 */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

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

/** Audit line for write actions (lands in CloudWatch on Lambda). Callers must pass identifiers, never names or other personal data. */
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
