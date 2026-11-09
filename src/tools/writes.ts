import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { okJson, errText, divisionParam, dryRunParam, audit, guid } from "./helpers.js";

/**
 * Guarded write tools. Every tool here:
 * - defaults to dry_run: true, returning the exact request body it WOULD post;
 * - creates draft/unprocessed data only, so finalization happens in Exact;
 * - writes an audit line (tool, division, summary) to the logs.
 *
 * Tool names must match /^exact_(create|update)_/ so read-only mode hides them.
 */

export function registerWriteMoreTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_create_journal_entry",
    {
      title: "Create general journal entry (draft)",
      description:
        "Create a general journal (memoriaal) entry via POST " +
        "generaljournalentry/GeneralJournalEntries — e.g. reclassifying suspense " +
        "amounts, splitting a lease payment into interest and repayment, or moving " +
        "corporate tax between accounts. Lines need the GL account GUID (find it via " +
        "exact_list_gl_accounts), an AmountDC (debit positive, credit negative; lines " +
        "should sum to 0) and optionally an account GUID and VAT code. DRY RUN BY " +
        "DEFAULT: returns the body it would post; set dry_run=false to actually create " +
        "the entry, which lands unprocessed in Exact for you to review and finalize.",
      inputSchema: {
        division: divisionParam,
        journal_code: z
          .string()
          .describe("Code of the general journal to book in (see exact_list_journals)."),
        date: z
          .string()
          .optional()
          .describe("Entry date as ISO date (e.g. '2026-09-01'); default today."),
        description: z.string().optional().describe("Entry description."),
        lines: z
          .array(
            z.object({
              gl_account_id: guid
                .describe("GL account GUID (ID from exact_list_gl_accounts)."),
              amount_dc: z
                .number()
                .describe("Amount in division currency; debit positive, credit negative."),
              description: z.string().optional().describe("Line description."),
              account_id: guid
                .optional()
                .describe("Optional customer/supplier account GUID."),
              vat_code: z.string().optional().describe("Optional VAT code."),
            })
          )
          .min(2)
          .describe("Journal entry lines; amounts should balance to 0."),
        dry_run: dryRunParam,
      },
    },
    async (args) => {
      try {
        const total = args.lines.reduce((sum, line) => sum + line.amount_dc, 0);
        const body = {
          JournalCode: args.journal_code,
          GeneralJournalEntryLines: args.lines.map((line) => ({
            GLAccount: line.gl_account_id,
            AmountDC: line.amount_dc,
            ...(args.date ? { Date: args.date } : {}),
            ...(line.description ?? args.description
              ? { Description: line.description ?? args.description }
              : {}),
            ...(line.account_id ? { Account: line.account_id } : {}),
            ...(line.vat_code ? { VATCode: line.vat_code } : {}),
          })),
        };
        if (args.dry_run !== false) {
          return okJson({
            dry_run: true,
            would_post_to: "generaljournalentry/GeneralJournalEntries",
            balance_check: Math.round(total * 100) / 100,
            body,
            note: "Set dry_run=false to create this entry (as unprocessed draft in Exact).",
          });
        }
        if (Math.abs(total) > 0.005) {
          throw new Error(
            `Refusing to post: lines sum to ${total.toFixed(2)}, not 0. Fix the amounts or post manually in Exact.`
          );
        }
        audit(
          "exact_create_journal_entry",
          args.division,
          `journal ${args.journal_code}, ${args.lines.length} lines`
        );
        const path = await client.divisionPath(
          "generaljournalentry/GeneralJournalEntries",
          args.division
        );
        const created = await client.request("POST", path, { body });
        return okJson(created);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_create_purchase_entry",
    {
      title: "Create purchase entry (draft)",
      description:
        "Create a purchase entry (inkoopboeking) via POST purchaseentry/PurchaseEntries " +
        "— e.g. turning an inbox document into a booking. Needs the supplier account " +
        "GUID, a purchase journal code and one or more lines with a GL account GUID and " +
        "amount (excluding VAT unless you pass a VAT code per line). Optionally link the " +
        "source document via document_id. DRY RUN BY DEFAULT: returns the body it would " +
        "post; set dry_run=false to actually create the entry, which you then review and " +
        "process in Exact.",
      inputSchema: {
        division: divisionParam,
        supplier_id: guid.describe("Supplier account GUID."),
        journal_code: z.string().describe("Purchase journal code."),
        your_ref: z
          .string()
          .optional()
          .describe("The supplier's invoice number (YourRef)."),
        entry_date: z
          .string()
          .optional()
          .describe("Entry/invoice date as ISO date."),
        due_date: z.string().optional().describe("Due date as ISO date."),
        description: z.string().optional().describe("Entry description."),
        document_id: guid
          .optional()
          .describe("Optional GUID of the source document to link."),
        lines: z
          .array(
            z.object({
              gl_account_id: guid.describe("GL account GUID for the cost line."),
              amount_fc: z.number().describe("Line amount."),
              description: z.string().optional(),
              vat_code: z.string().optional(),
            })
          )
          .min(1)
          .describe("Cost lines."),
        dry_run: dryRunParam,
      },
    },
    async (args) => {
      try {
        const body = {
          Supplier: args.supplier_id,
          Journal: args.journal_code,
          ...(args.your_ref ? { YourRef: args.your_ref } : {}),
          ...(args.entry_date ? { EntryDate: args.entry_date } : {}),
          ...(args.due_date ? { DueDate: args.due_date } : {}),
          ...(args.description ? { Description: args.description } : {}),
          ...(args.document_id ? { Document: args.document_id } : {}),
          PurchaseEntryLines: args.lines.map((line) => ({
            GLAccount: line.gl_account_id,
            AmountFC: line.amount_fc,
            ...(line.description ? { Description: line.description } : {}),
            ...(line.vat_code ? { VATCode: line.vat_code } : {}),
          })),
        };
        if (args.dry_run !== false) {
          return okJson({
            dry_run: true,
            would_post_to: "purchaseentry/PurchaseEntries",
            body,
            note: "Set dry_run=false to create this purchase entry as a draft in Exact.",
          });
        }
        audit(
          "exact_create_purchase_entry",
          args.division,
          `supplier ${args.supplier_id}, ref ${args.your_ref ?? "-"}`
        );
        const path = await client.divisionPath(
          "purchaseentry/PurchaseEntries",
          args.division
        );
        const created = await client.request("POST", path, { body });
        return okJson(created);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_create_match_set",
    {
      title: "Match transaction lines (reconcile)",
      description:
        "Match (aflettering) open transaction lines against each other — e.g. a payment " +
        "against its invoice — via POST financial/MatchSets. Provide the GL account GUID " +
        "(usually the receivables or payables account) and the GUIDs of the transaction " +
        "lines to match (their ID from exact_list_transaction_lines); matched amounts " +
        "should net to zero. DRY RUN BY DEFAULT: returns the body it would post; set " +
        "dry_run=false to perform the match. Verify the result in Exact afterwards.",
      inputSchema: {
        division: divisionParam,
        gl_account_id: guid
          .describe("GL account GUID the lines are on (e.g. accounts receivable)."),
        transaction_line_ids: z
          .array(guid)
          .min(2)
          .describe("GUIDs of the transaction lines to match against each other."),
        dry_run: dryRunParam,
      },
    },
    async (args) => {
      try {
        const body = {
          GLAccount: args.gl_account_id,
          MatchLines: args.transaction_line_ids.map((id) => ({ ID: id })),
        };
        if (args.dry_run !== false) {
          return okJson({
            dry_run: true,
            would_post_to: "financial/MatchSets",
            body,
            note: "Set dry_run=false to perform the match.",
          });
        }
        audit(
          "exact_create_match_set",
          args.division,
          `${args.transaction_line_ids.length} lines on ${args.gl_account_id}`
        );
        const path = await client.divisionPath(
          "financial/MatchSets",
          args.division
        );
        const created = await client.request("POST", path, { body });
        return okJson(created);
      } catch (e) {
        return errText(e);
      }
    }
  );
}
