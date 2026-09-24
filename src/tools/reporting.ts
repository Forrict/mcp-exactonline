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
 * Register the "reporting" tools on the MCP server: aggregated financial
 * insight (reporting balance / P&L, budgets, bank entries, outgoing payments
 * and VAT codes).
 */
export function registerReportingTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_get_reporting_balance",
    {
      title: "Get reporting balance (P&L / balance sheet)",
      description:
        "Get aggregated balances per GL account per financial period: the basis for a " +
        "profit & loss statement and balance sheet. Each row has the GLAccountCode + " +
        "GLAccountDescription, ReportingYear, ReportingPeriod, BalanceType (B=balance " +
        "sheet, W=profit & loss), Amount (period movement; for P&L accounts costs are " +
        "positive and revenue negative), AmountCredit, AmountDebit and posting Count. " +
        "Filter by year/period range and BalanceType, e.g. balance_type 'W' for a P&L. " +
        "Backed by GET /{division}/financial/ReportingBalance.",
      inputSchema: {
        division: divisionParam,
        reporting_year: z
          .number()
          .int()
          .optional()
          .describe("Reporting year to filter by (ReportingYear eq N)."),
        period_from: z
          .number()
          .int()
          .optional()
          .describe("Inclusive lower bound for ReportingPeriod."),
        period_to: z
          .number()
          .int()
          .optional()
          .describe("Inclusive upper bound for ReportingPeriod."),
        balance_type: z
          .enum(["B", "W"])
          .optional()
          .describe(
            "Filter by BalanceType: 'B' = balance sheet accounts, 'W' = profit & loss accounts."
          ),
        gl_account_code: z
          .string()
          .optional()
          .describe("GL account code to filter by (GLAccountCode eq '...')."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of rows to return (default 500)."),
      },
    },
    async (args) => {
      try {
        const filters: string[] = [];
        if (args.reporting_year !== undefined) {
          filters.push(`ReportingYear eq ${args.reporting_year}`);
        }
        if (args.period_from !== undefined) {
          filters.push(`ReportingPeriod ge ${args.period_from}`);
        }
        if (args.period_to !== undefined) {
          filters.push(`ReportingPeriod le ${args.period_to}`);
        }
        if (args.balance_type) {
          filters.push(`BalanceType eq ${odataString(args.balance_type)}`);
        }
        if (args.gl_account_code) {
          filters.push(`GLAccountCode eq ${odataString(args.gl_account_code)}`);
        }
        const max = args.top ?? 500;
        const path = await client.divisionPath(
          "financial/ReportingBalance",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "ID,ReportingYear,ReportingPeriod,GLAccountCode,GLAccountDescription,BalanceType,Amount,AmountCredit,AmountDebit,Count,Status",
            $orderby: "GLAccountCode",
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
    "exact_list_budgets",
    {
      title: "List budgets",
      description:
        "List budget amounts per GL account per reporting period, for comparing budget " +
        "against actuals (see exact_get_reporting_balance for the actuals). Each row has " +
        "the GLAccountCode + GLAccountDescription, ReportingYear, ReportingPeriod, AmountDC " +
        "(budgeted amount in the division currency), the BudgetScenarioCode/Description it " +
        "belongs to, and optional Costcenter/Costunit/ItemCode. Backed by GET " +
        "/{division}/budget/Budgets.",
      inputSchema: {
        division: divisionParam,
        reporting_year: z
          .number()
          .int()
          .optional()
          .describe("Reporting year to filter by (ReportingYear eq N)."),
        gl_account_code: z
          .string()
          .optional()
          .describe("GL account code to filter by (GLAccountCode eq '...')."),
        budget_scenario_code: z
          .string()
          .optional()
          .describe("Budget scenario code to filter by (BudgetScenarioCode eq '...')."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of budget rows to return (default 500)."),
      },
    },
    async (args) => {
      try {
        const filters: string[] = [];
        if (args.reporting_year !== undefined) {
          filters.push(`ReportingYear eq ${args.reporting_year}`);
        }
        if (args.gl_account_code) {
          filters.push(`GLAccountCode eq ${odataString(args.gl_account_code)}`);
        }
        if (args.budget_scenario_code) {
          filters.push(
            `BudgetScenarioCode eq ${odataString(args.budget_scenario_code)}`
          );
        }
        const max = args.top ?? 500;
        const path = await client.divisionPath("budget/Budgets", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "ID,ReportingYear,ReportingPeriod,GLAccountCode,GLAccountDescription,AmountDC,BudgetScenarioCode,BudgetScenarioDescription,CostcenterDescription,CostunitDescription,ItemCode",
            $orderby: "ReportingYear,ReportingPeriod",
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
    "exact_list_bank_entries",
    {
      title: "List bank entries",
      description:
        "List bank statement entries (one per processed bank statement) with their " +
        "EntryNumber, JournalCode + JournalDescription (the bank journal), FinancialYear, " +
        "FinancialPeriod, OpeningBalanceFC and ClosingBalanceFC, StatusDescription and " +
        "Created date. Useful for cash flow questions and checking which statements have " +
        "been booked. Use exact_list_transaction_lines with the bank journal_code for the " +
        "individual statement lines. Backed by GET /{division}/financialtransaction/BankEntries.",
      inputSchema: {
        division: divisionParam,
        financial_year: z
          .number()
          .int()
          .optional()
          .describe("Financial year to filter by (FinancialYear eq N)."),
        journal_code: z
          .string()
          .optional()
          .describe("Bank journal code to filter by (JournalCode eq '...')."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of bank entries to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const filters: string[] = [];
        if (args.financial_year !== undefined) {
          filters.push(`FinancialYear eq ${args.financial_year}`);
        }
        if (args.journal_code) {
          filters.push(`JournalCode eq ${odataString(args.journal_code)}`);
        }
        const max = args.top ?? 100;
        const path = await client.divisionPath(
          "financialtransaction/BankEntries",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "EntryID,EntryNumber,JournalCode,JournalDescription,FinancialYear,FinancialPeriod,OpeningBalanceFC,ClosingBalanceFC,Status,StatusDescription,Created",
            $orderby: "Created desc",
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
    "exact_list_payments",
    {
      title: "List outgoing payments",
      description:
        "List outgoing payment obligations from the payment administration (cashflow): " +
        "purchase invoices and other liabilities to be paid or already paid. Each item has " +
        "the supplier AccountCode + AccountName, AmountDC (division currency), Description, " +
        "DueDate, InvoiceNumber, PaymentMethod, PaymentReference, Status (20=open, 30=" +
        "selected/processing, 40=processed, 50=paid) and YourRef. Filter by status and due " +
        "date range. Backed by GET /{division}/cashflow/Payments, ordered by DueDate.",
      inputSchema: {
        division: divisionParam,
        status: z
          .number()
          .int()
          .optional()
          .describe(
            "Payment status to filter by: 20=open, 30=selected, 40=processed, 50=paid."
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
          .describe("Maximum number of payments to return (default 100)."),
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
          "cashflow/Payments",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "ID,AccountCode,AccountName,AmountDC,Currency,Description,DueDate,InvoiceNumber,PaymentMethod,PaymentReference,Status,YourRef",
            $orderby: "DueDate",
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
    "exact_list_vat_codes",
    {
      title: "List VAT codes",
      description:
        "List the VAT (btw) codes defined in the administration, with Code, Description, " +
        "Percentage (as a fraction, e.g. 0.21 for 21%) and VatDocType. Useful when creating " +
        "invoices or interpreting transaction lines. Backed by GET /{division}/vat/VATCodes.",
      inputSchema: {
        division: divisionParam,
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of VAT codes to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath("vat/VATCodes", args.division);
        const result = await client.getAll(
          path,
          {
            $select: "ID,Code,Description,Percentage,VatDocType",
            $orderby: "Code",
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
