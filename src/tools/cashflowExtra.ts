import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { toExactDate } from "../client.js";
import { okJson, errText, divisionParam, guid, odataString } from "./helpers.js";

/**
 * Register the extra "cashflow" tools on the MCP server: incoming
 * receivables, direct debit mandates, exchange rates, the aggregated revenue
 * list and fixed assets.
 */
export function registerCashflowTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_list_incoming_receivables",
    {
      title: "List incoming receivables",
      description:
        "List incoming payment obligations from the payment administration (cashflow): " +
        "sales invoices and other amounts to be received from customers — the incoming " +
        "complement of exact_list_payments (outgoing). Each item has the customer " +
        "AccountCode + AccountName, AmountDC (division currency), Description, DueDate, " +
        "InvoiceNumber, PaymentMethod, PaymentReference, Status (indicative: 20=open, " +
        "30=selected, 40=processed, 50=paid) and YourRef. Filter by status and due date " +
        "range. Backed by GET /{division}/cashflow/Receivables.",
      inputSchema: {
        division: divisionParam,
        status: z
          .number()
          .int()
          .optional()
          .describe(
            "Receivable status to filter by (Status eq N); indicative values: 20=open, 30=selected, 40=processed, 50=paid."
          ),
        due_from: z
          .string()
          .optional()
          .describe(
            "Inclusive lower bound for DueDate, as an ISO date string (e.g. '2026-01-01')."
          ),
        due_to: z
          .string()
          .optional()
          .describe(
            "Inclusive upper bound for DueDate, as an ISO date string (e.g. '2026-12-31')."
          ),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of receivables to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const filters: string[] = [];
        if (args.status !== undefined) {
          filters.push(`Status eq ${args.status}`);
        }
        if (args.due_from) {
          filters.push(`DueDate ge ${toExactDate(args.due_from)}`);
        }
        if (args.due_to) {
          filters.push(`DueDate le ${toExactDate(args.due_to)}`);
        }
        const max = args.top ?? 100;
        const path = await client.divisionPath(
          "cashflow/Receivables",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "ID,AccountCode,AccountName,AmountDC,Currency,Description,DueDate,InvoiceNumber,PaymentMethod,PaymentReference,Status,YourRef",
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
    "exact_list_direct_debit_mandates",
    {
      title: "List direct debit mandates",
      description:
        "List SEPA direct debit mandates (incassomachtigingen) registered on customer " +
        "accounts, with all mandate fields such as Reference, SignatureDate, the linked " +
        "Account and bank account, and the mandate type. Filter by `account_id` to get " +
        "the mandates of one customer. Backed by GET /{division}/cashflow/DirectDebitMandates.",
      inputSchema: {
        division: divisionParam,
        account_id: guid
          .optional()
          .describe("Account GUID to filter by (Account eq guid'...')."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of mandates to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath(
          "cashflow/DirectDebitMandates",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: args.account_id
              ? `Account eq guid'${args.account_id}'`
              : undefined,
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
    "exact_list_exchange_rates",
    {
      title: "List exchange rates",
      description:
        "List currency exchange rates defined in the administration, with SourceCurrency, " +
        "TargetCurrency, the Rate and its StartDate. Filter by source and/or target " +
        "currency code (e.g. 'EUR', 'USD'). Backed by GET /{division}/financial/ExchangeRates.",
      inputSchema: {
        division: divisionParam,
        source_currency: z
          .string()
          .optional()
          .describe("Source currency code to filter by (SourceCurrency eq '...')."),
        target_currency: z
          .string()
          .optional()
          .describe("Target currency code to filter by (TargetCurrency eq '...')."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of exchange rates to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const filters: string[] = [];
        if (args.source_currency) {
          filters.push(`SourceCurrency eq ${odataString(args.source_currency)}`);
        }
        if (args.target_currency) {
          filters.push(`TargetCurrency eq ${odataString(args.target_currency)}`);
        }
        const max = args.top ?? 100;
        const path = await client.divisionPath(
          "financial/ExchangeRates",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
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
    "exact_get_revenue_list",
    {
      title: "Get revenue list by year and status",
      description:
        "Get aggregated revenue per year and invoice status: a quick top-level revenue " +
        "overview without paging through individual invoices. Filter by `year` to get one " +
        "year only. Backed by GET /{division}/read/financial/RevenueListByYearAndStatus.",
      inputSchema: {
        division: divisionParam,
        year: z
          .number()
          .int()
          .optional()
          .describe("Year to filter by (Year eq N)."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of rows to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath(
          "read/financial/RevenueListByYearAndStatus",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter:
              args.year !== undefined ? `Year eq ${args.year}` : undefined,
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
    "exact_list_assets",
    {
      title: "List fixed assets",
      description:
        "List fixed assets (vaste activa) registered for depreciation, with all asset " +
        "fields such as Code, Description, purchase date and value, depreciation method " +
        "and residual value. Backed by GET /{division}/assets/Assets.",
      inputSchema: {
        division: divisionParam,
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of assets to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath("assets/Assets", args.division);
        const result = await client.getAll(
          path,
          {
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
