import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { toExactDate } from "../client.js";
import { okJson, errText, divisionParam } from "./helpers.js";

/**
 * Register the "purchase" tools on the MCP server: booked purchase entries
 * (accounts payable), individual entry drill-down with lines, and purchase
 * orders.
 */
export function registerPurchaseTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_list_purchase_entries",
    {
      title: "List purchase entries",
      description:
        "List booked purchase invoices (accounts payable entries) from the " +
        "purchase journal. Backed by GET /{division}/purchaseentry/PurchaseEntries. " +
        "Filter by date range (EntryDate), supplier, your reference, or entry number.",
      inputSchema: {
        division: divisionParam,
        date_from: z
          .string()
          .optional()
          .describe("ISO date; EntryDate >= this value."),
        date_to: z
          .string()
          .optional()
          .describe("ISO date; EntryDate <= this value."),
        supplier_id: z
          .string()
          .optional()
          .describe("Supplier account GUID to filter on (Supplier eq guid'...')."),
        your_ref: z
          .string()
          .optional()
          .describe("Filter on YourRef (supplier's reference/invoice number)."),
        entry_number: z
          .number()
          .int()
          .optional()
          .describe("Filter on the exact EntryNumber."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of rows to return (default 50, cap 500)."),
      },
    },
    async (args) => {
      try {
        const { date_from, date_to, supplier_id, your_ref, entry_number, top } =
          args;
        const filters: string[] = [];
        if (date_from) filters.push(`EntryDate ge ${toExactDate(date_from)}`);
        if (date_to) filters.push(`EntryDate le ${toExactDate(date_to)}`);
        if (supplier_id) filters.push(`Supplier eq guid'${supplier_id}'`);
        if (your_ref) {
          filters.push(`YourRef eq '${your_ref.replace(/'/g, "''")}'`);
        }
        if (entry_number !== undefined) {
          filters.push(`EntryNumber eq ${entry_number}`);
        }
        const max = top ?? 50;
        const path = await client.divisionPath("purchaseentry/PurchaseEntries", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "EntryID,EntryNumber,EntryDate,Supplier,SupplierName,Description," +
              "AmountDC,VATAmountDC,Currency,DueDate,YourRef,Journal," +
              "PaymentCondition,Status",
            $orderby: "EntryDate desc",
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
    "exact_get_purchase_entry",
    {
      title: "Get purchase entry",
      description:
        "Return a single booked purchase invoice (purchase entry) with its full " +
        "header plus all GL detail lines. Backed by GET " +
        "/{division}/purchaseentry/PurchaseEntries(guid'...') and PurchaseEntryLines.",
      inputSchema: {
        division: divisionParam,
        entry_id: z
          .string()
          .describe("EntryID GUID of the purchase entry."),
      },
    },
    async (args) => {
      try {
        const { entry_id } = args;
        const entryPath = await client.divisionPath(`purchaseentry/PurchaseEntries(guid'${entry_id}')`, args.division);
        const entry = await client.request("GET", entryPath, {
          params: {
            $select:
              "EntryID,EntryNumber,EntryDate,FinancialYear,FinancialPeriod," +
              "Supplier,SupplierName,Description,AmountDC,AmountFC,VATAmountDC," +
              "VATAmountFC,Currency,ExchangeRate,DueDate,YourRef,InvoiceNumber," +
              "Journal,JournalDescription,PaymentCondition,PaymentConditionDescription," +
              "PaymentReference,Status,Created,Creator,CreatorFullName,Modified,Modifier",
          },
        });
        const linesPath = await client.divisionPath("purchaseentry/PurchaseEntryLines", args.division);
        const lines = await client.getAll(linesPath, {
          $filter: `EntryID eq guid'${entry_id}'`,
          $select:
            "ID,LineNumber,GLAccount,GLAccountCode,GLAccountDescription," +
            "Description,AmountDC,VATAmountDC,VATCode,CostCenter,CostUnit,Project",
        });
        return okJson({ entry, lines });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_list_purchase_orders",
    {
      title: "List purchase orders",
      description:
        "List purchase orders with receipt and invoice status. Backed by GET " +
        "/{division}/purchaseorder/PurchaseOrders. Filter by OrderDate range or supplier.",
      inputSchema: {
        division: divisionParam,
        date_from: z
          .string()
          .optional()
          .describe("ISO date; OrderDate >= this value."),
        date_to: z
          .string()
          .optional()
          .describe("ISO date; OrderDate <= this value."),
        supplier_id: z
          .string()
          .optional()
          .describe("Supplier account GUID to filter on (Supplier eq guid'...')."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of rows to return (default 50, cap 500)."),
      },
    },
    async (args) => {
      try {
        const { date_from, date_to, supplier_id, top } = args;
        const filters: string[] = [];
        if (date_from) filters.push(`OrderDate ge ${toExactDate(date_from)}`);
        if (date_to) filters.push(`OrderDate le ${toExactDate(date_to)}`);
        if (supplier_id) filters.push(`Supplier eq guid'${supplier_id}'`);
        const max = top ?? 50;
        const path = await client.divisionPath("purchaseorder/PurchaseOrders", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "PurchaseOrderID,OrderNumber,OrderDate,Supplier,SupplierName," +
              "Description,AmountDC,Currency,ReceiptStatus,InvoiceStatus,YourRef",
            $orderby: "OrderDate desc",
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
