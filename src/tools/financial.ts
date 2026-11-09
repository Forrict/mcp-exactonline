import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { toExactDate } from "../client.js";
import { okJson, errText, divisionParam, guid, odataString } from "./helpers.js";

/**
 * Register the "financial" tools on the MCP server. These expose the general
 * ledger, journals, financial transaction lines, outstanding receivables /
 * payables (incl. aging), and financial periods from Exact Online.
 */
export function registerFinancialTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_list_gl_accounts",
    {
      title: "List GL accounts",
      description:
        "List general ledger (GL) accounts from the chart of accounts. Each account has a " +
        "Code, Description, Type (Exact GL account type code) with a human-readable " +
        "TypeDescription, BalanceSide (D=debit / C=credit), BalanceType (B=balance sheet / " +
        "W=profit & loss), an optional Costcenter, and IsBlocked. Common Exact GL account " +
        "type codes: 10=cash, 12=bank, 20=accounts receivable, 22=accounts payable, " +
        "110=revenue, 111=cost of goods. Use `search` to substring-match the Description and " +
        "`type` to filter by the Exact GL account type code. Backed by GET " +
        "/{division}/financial/GLAccounts, ordered by Code.",
      inputSchema: {
        division: divisionParam,
        search: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring to match against the account Description."
          ),
        type: z
          .number()
          .int()
          .optional()
          .describe(
            "Exact GL account type code to filter by, e.g. 10=cash, 12=bank, 20=accounts receivable, 22=accounts payable, 110=revenue, 111=cost of goods."
          ),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of accounts to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const { search, type, top } = args;
        const filters: string[] = [];
        if (search) {
          filters.push(`substringof(${odataString(search)}, Description)`);
        }
        if (type !== undefined) {
          filters.push(`Type eq ${type}`);
        }
        const max = top ?? 100;
        const path = await client.divisionPath("financial/GLAccounts", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "ID,Code,Description,Type,TypeDescription,BalanceSide,BalanceType,Costcenter,IsBlocked",
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

  server.registerTool(
    "exact_list_journals",
    {
      title: "List journals",
      description:
        "List the financial journals (also called day books / dagboeken) used to post " +
        "transactions, such as sales, purchase, cash, bank and general journals. Each journal " +
        "has a Code, Description, Type (numeric journal type), and for bank/cash journals a " +
        "linked Bank, BankAccountDescription and Currency. Backed by GET " +
        "/{division}/financial/Journals.",
      inputSchema: {
        division: divisionParam,
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of journals to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath("financial/Journals", args.division);
        const result = await client.getAll(
          path,
          {
            $select:
              "ID,Code,Description,Type,Bank,BankAccountDescription,Currency",
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
    "exact_list_transaction_lines",
    {
      title: "List financial transaction lines",
      description:
        "List individual financial transaction lines (general ledger postings) from the " +
        "financialtransaction/TransactionLines endpoint. Each line records a posting to a GL " +
        "account within a journal entry, including the Date, FinancialYear, FinancialPeriod, " +
        "JournalCode, EntryNumber, GLAccountCode + GLAccountDescription, Description, AmountDC, " +
        "AccountName (customer/supplier), InvoiceNumber, CostCenter, CostUnit and " +
        "Type. AmountDC is the amount expressed in the division's (default) currency, where a " +
        "debit is positive and a credit is negative. Filter by date range, GL account code, " +
        "account (customer/supplier GUID), financial year and/or journal code. Backed by GET " +
        "/{division}/financialtransaction/TransactionLines, ordered by Date descending.",
      inputSchema: {
        division: divisionParam,
        date_from: z
          .string()
          .optional()
          .describe(
            "Inclusive lower bound for the transaction Date, as an ISO date string (e.g. '2024-01-01'). Maps to Date ge datetime'...'."
          ),
        date_to: z
          .string()
          .optional()
          .describe(
            "Inclusive upper bound for the transaction Date, as an ISO date string (e.g. '2024-12-31'). Maps to Date le datetime'...'."
          ),
        gl_account_code: z
          .string()
          .optional()
          .describe(
            "GL account code to filter by (GLAccountCode eq '...')."
          ),
        account_id: guid
          .optional()
          .describe(
            "Account (customer/supplier) GUID to filter by (Account eq guid'...')."
          ),
        financial_year: z
          .number()
          .int()
          .optional()
          .describe("Financial year to filter by (FinancialYear eq N)."),
        journal_code: z
          .string()
          .optional()
          .describe("Journal code to filter by (JournalCode eq '...')."),
        description_contains: z
          .string()
          .optional()
          .describe(
            "Substring to match in the line Description (substringof)."
          ),
        account_name_contains: z
          .string()
          .optional()
          .describe(
            "Substring to match in the AccountName (customer/supplier)."
          ),
        min_amount: z
          .number()
          .optional()
          .describe("Inclusive lower bound for AmountDC (AmountDC ge N)."),
        max_amount: z
          .number()
          .optional()
          .describe("Inclusive upper bound for AmountDC (AmountDC le N)."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe(
            "Maximum number of transaction lines to return (default 100, max 500)."
          ),
      },
    },
    async (args) => {
      try {
        const {
          date_from,
          date_to,
          gl_account_code,
          account_id,
          financial_year,
          journal_code,
          top,
        } = args;
        const filters: string[] = [];
        if (date_from) {
          filters.push(`Date ge ${toExactDate(date_from)}`);
        }
        if (date_to) {
          filters.push(`Date le ${toExactDate(date_to)}`);
        }
        if (gl_account_code) {
          filters.push(`GLAccountCode eq ${odataString(gl_account_code)}`);
        }
        if (account_id) {
          filters.push(`Account eq guid'${account_id}'`);
        }
        if (financial_year !== undefined) {
          filters.push(`FinancialYear eq ${financial_year}`);
        }
        if (journal_code) {
          filters.push(`JournalCode eq ${odataString(journal_code)}`);
        }
        if (args.description_contains) {
          filters.push(
            `substringof(${odataString(args.description_contains)}, Description)`
          );
        }
        if (args.account_name_contains) {
          filters.push(
            `substringof(${odataString(args.account_name_contains)}, AccountName)`
          );
        }
        if (args.min_amount !== undefined) {
          filters.push(`AmountDC ge ${args.min_amount}`);
        }
        if (args.max_amount !== undefined) {
          filters.push(`AmountDC le ${args.max_amount}`);
        }
        const max = top ?? 100;
        const path = await client.divisionPath("financialtransaction/TransactionLines", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "ID,Date,FinancialYear,FinancialPeriod,JournalCode,EntryNumber,GLAccountCode,GLAccountDescription,Description,AmountDC,AccountName,InvoiceNumber,CostCenter,CostUnit,Type",
            $orderby: "Date desc",
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
    "exact_get_receivables",
    {
      title: "Get receivables",
      description:
        "List outstanding accounts receivable: unpaid (or partially paid) sales invoices that " +
        "customers still owe money on. Each item includes the AccountId + AccountName of the " +
        "customer, the outstanding Amount, CurrencyCode, DueDate, InvoiceNumber, YourRef and " +
        "EntryNumber. Backed by GET /{division}/read/financial/ReceivablesList, ordered by " +
        "DueDate.",
      inputSchema: {
        division: divisionParam,
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of receivable items to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath("read/financial/ReceivablesList", args.division);
        const result = await client.getAll(
          path,
          {
            $select:
              "AccountId,AccountName,Amount,CurrencyCode,DueDate,InvoiceNumber,YourRef,EntryNumber",
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
    "exact_get_payables",
    {
      title: "Get payables",
      description:
        "List outstanding accounts payable: unpaid (or partially paid) purchase invoices that " +
        "the company still owes to its suppliers. Each item includes the AccountId + " +
        "AccountName of the supplier, the outstanding Amount, CurrencyCode, DueDate, " +
        "InvoiceNumber, YourRef and EntryNumber. Backed by GET " +
        "/{division}/read/financial/PayablesList, ordered by DueDate.",
      inputSchema: {
        division: divisionParam,
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of payable items to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath("read/financial/PayablesList", args.division);
        const result = await client.getAll(
          path,
          {
            $select:
              "AccountId,AccountName,Amount,CurrencyCode,DueDate,InvoiceNumber,YourRef,EntryNumber",
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
    "exact_get_aging_receivables",
    {
      title: "Get aging receivables",
      description:
        "Get accounts receivable aging: outstanding customer balances split into aging buckets " +
        "per customer. Each row includes the AccountId + AccountName, CurrencyCode, and the " +
        "amounts falling into successive aging periods (AgeGroup1Amount is the most current " +
        "bucket, through AgeGroup4Amount the most overdue), plus the TotalAmount outstanding. " +
        "Useful for assessing overdue exposure and collections risk. Backed by GET " +
        "/{division}/read/financial/AgingReceivablesList.",
      inputSchema: {
        division: divisionParam,
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of customer aging rows to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath("read/financial/AgingReceivablesList", args.division);
        const result = await client.getAll(
          path,
          {
            $select:
              "AccountId,AccountName,CurrencyCode,AgeGroup1Amount,AgeGroup2Amount,AgeGroup3Amount,AgeGroup4Amount,TotalAmount",
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
    "exact_get_financial_periods",
    {
      title: "Get financial periods",
      description:
        "List the financial periods (accounting periods) defined for the administration. Each " +
        "period has an ID, FinYear (financial year), FinPeriod (period number within the year), " +
        "and its StartDate / EndDate. Optionally filter to a single financial year. Backed by " +
        "GET /{division}/financial/FinancialPeriods.",
      inputSchema: {
        division: divisionParam,
        financial_year: z
          .number()
          .int()
          .optional()
          .describe("Financial year to filter by (FinYear eq N)."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of periods to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const { financial_year, top } = args;
        const max = top ?? 50;
        const path = await client.divisionPath("financial/FinancialPeriods", args.division);
        const result = await client.getAll(
          path,
          {
            $filter:
              financial_year !== undefined
                ? `FinYear eq ${financial_year}`
                : undefined,
            $select: "ID,FinYear,FinPeriod,StartDate,EndDate",
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
