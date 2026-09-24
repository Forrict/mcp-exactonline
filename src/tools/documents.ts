import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { toExactDate } from "../client.js";
import { okJson, errText, divisionParam } from "./helpers.js";

/**
 * Escape a string literal for an OData v3 `$filter` expression by doubling any
 * embedded single quotes. e.g. `O'Brien` -> `O''Brien`.
 */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Register the "documents" tools on the MCP server: the document archive
 * (scanned invoices, contracts, correspondence) and its file attachments.
 */
export function registerDocumentTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_list_documents",
    {
      title: "List documents",
      description:
        "List documents from the document archive (scanned invoices, contracts, " +
        "correspondence), with ID, the human-readable HID number, Subject, Type, " +
        "Category, DocumentDate and Created. Filter by a substring of the Subject, the " +
        "linked account and a DocumentDate range. Note: Amount and Source are NOT valid " +
        "fields on this resource and cannot be selected or filtered. Backed by GET " +
        "/{division}/documents/Documents.",
      inputSchema: {
        division: divisionParam,
        subject_contains: z
          .string()
          .optional()
          .describe(
            "Substring to search for in Subject (substringof('...', Subject))."
          ),
        account_id: z
          .string()
          .optional()
          .describe("Account GUID to filter by (Account eq guid'...')."),
        date_from: z
          .string()
          .optional()
          .describe(
            "Inclusive lower bound for DocumentDate, as an ISO date string (e.g. '2026-01-01')."
          ),
        date_to: z
          .string()
          .optional()
          .describe(
            "Inclusive upper bound for DocumentDate, as an ISO date string (e.g. '2026-12-31')."
          ),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of documents to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const filters: string[] = [];
        if (args.subject_contains) {
          filters.push(
            `substringof(${odataString(args.subject_contains)}, Subject)`
          );
        }
        if (args.account_id) {
          filters.push(`Account eq guid'${args.account_id}'`);
        }
        if (args.date_from) {
          filters.push(`DocumentDate ge ${toExactDate(args.date_from)}`);
        }
        if (args.date_to) {
          filters.push(`DocumentDate le ${toExactDate(args.date_to)}`);
        }
        const max = args.top ?? 50;
        const path = await client.divisionPath(
          "documents/Documents",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select: "ID,HID,Subject,Type,Category,DocumentDate,Created",
            $top: max,
          },
          max
        );
        return okJson(result);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_list_document_attachments",
    {
      title: "List document attachments",
      description:
        "List the file attachments of archived documents, with ID, the parent Document " +
        "GUID, FileName, FileSize and a download Url. Filter by `document_id` to get the " +
        "attachments of one document from exact_list_documents. Backed by GET " +
        "/{division}/documents/DocumentAttachments.",
      inputSchema: {
        division: divisionParam,
        document_id: z
          .string()
          .optional()
          .describe("Document GUID to filter by (Document eq guid'...')."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of attachments to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath(
          "documents/DocumentAttachments",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: args.document_id
              ? `Document eq guid'${args.document_id}'`
              : undefined,
            $select: "ID,Document,FileName,FileSize,Url",
            $top: max,
          },
          max
        );
        return okJson(result);
      } catch (e) {
        return errText(e);
      }
    }
  );
}
