import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { toExactDate } from "../client.js";
import { okJson, errText, divisionParam, odataString } from "./helpers.js";

interface BalanceRow {
  ReportingPeriod?: number;
  GLAccountCode?: string;
  GLAccountDescription?: string;
  Amount?: number;
}

interface OpenItem {
  AccountId?: string;
  AccountName?: string;
  Amount?: number;
  CurrencyCode?: string;
  DueDate?: string;
  InvoiceNumber?: number | string;
  YourRef?: string;
  EntryNumber?: number;
}

const OPEN_ITEM_SELECT =
  "AccountId,AccountName,Amount,CurrencyCode,DueDate,InvoiceNumber,YourRef,EntryNumber";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Fetch P&L (BalanceType W) reporting-balance rows for a year. */
async function fetchPlRows(
  client: ExactClient,
  division: number | string | undefined,
  year: number
): Promise<{ rows: BalanceRow[]; truncated: boolean }> {
  const path = await client.divisionPath("financial/ReportingBalance", division);
  const result = await client.getAll<BalanceRow>(
    path,
    {
      $filter: `ReportingYear eq ${year} and BalanceType eq 'W'`,
      $select: "ReportingPeriod,GLAccountCode,GLAccountDescription,Amount",
      $top: 500,
    },
    500
  );
  return { rows: result.results, truncated: result.truncated };
}

/**
 * Aggregate P&L rows. Exact stores costs as positive and revenue as negative
 * amounts on W accounts, so result = -(sum of Amount).
 */
function summarizePl(rows: BalanceRow[]): {
  revenue: number;
  costs: number;
  result: number;
} {
  let revenue = 0;
  let costs = 0;
  for (const row of rows) {
    const amount = row.Amount ?? 0;
    if (amount < 0) revenue += -amount;
    else costs += amount;
  }
  return {
    revenue: round2(revenue),
    costs: round2(costs),
    result: round2(revenue - costs),
  };
}

/**
 * Register the "insights" tools: aggregated multi-call reports computed
 * server-side so a client needs one call instead of many.
 */
export function registerInsightTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_pl_summary",
    {
      title: "Profit & loss summary",
      description:
        "One-call profit & loss summary for a year, computed from " +
        "financial/ReportingBalance (BalanceType W). group_by 'period' returns per-period " +
        "revenue, costs, result and cumulative result; group_by 'gl_account' returns the " +
        "year total per GL account (positive = cost, negative = revenue), plus overall " +
        "totals. Replaces manually adding up dozens of reporting-balance rows.",
      inputSchema: {
        division: divisionParam,
        year: z.number().int().describe("Reporting year, e.g. 2026."),
        group_by: z
          .enum(["period", "gl_account"])
          .optional()
          .describe("Aggregation: per 'period' (default) or per 'gl_account'."),
      },
    },
    async (args) => {
      try {
        const { rows, truncated } = await fetchPlRows(
          client,
          args.division,
          args.year
        );
        const totals = summarizePl(rows);
        if ((args.group_by ?? "period") === "gl_account") {
          const byAccount = new Map<
            string,
            { gl_account_code: string; description?: string; amount: number }
          >();
          for (const row of rows) {
            const code = row.GLAccountCode ?? "?";
            const entry = byAccount.get(code) ?? {
              gl_account_code: code,
              description: row.GLAccountDescription,
              amount: 0,
            };
            entry.amount = round2(entry.amount + (row.Amount ?? 0));
            byAccount.set(code, entry);
          }
          const accounts = [...byAccount.values()].sort((a, b) =>
            a.gl_account_code.localeCompare(b.gl_account_code)
          );
          return okJson({ year: args.year, totals, truncated, accounts });
        }
        const byPeriod = new Map<number, BalanceRow[]>();
        for (const row of rows) {
          const period = row.ReportingPeriod ?? 0;
          const list = byPeriod.get(period) ?? [];
          list.push(row);
          byPeriod.set(period, list);
        }
        let cumulative = 0;
        const periods = [...byPeriod.keys()]
          .sort((a, b) => a - b)
          .map((period) => {
            const summary = summarizePl(byPeriod.get(period)!);
            cumulative = round2(cumulative + summary.result);
            return { period, ...summary, cumulative_result: cumulative };
          });
        return okJson({ year: args.year, totals, truncated, periods });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_missing_bookings",
    {
      title: "Find likely missing bookings",
      description:
        "One-call bookkeeping hygiene check: (1) negative receivables and negative " +
        "payables (payments without a matching invoice), (2) open transaction lines on " +
        "suspense/clearing GL accounts (default 1940 and 1050), and (3) per-month counts " +
        "of sales invoices and purchase entries for the year so gaps (months without " +
        "bookings) stand out. Replaces roughly six separate calls per administration.",
      inputSchema: {
        division: divisionParam,
        year: z
          .number()
          .int()
          .optional()
          .describe("Year to inspect (default: current year)."),
        suspense_gl_codes: z
          .array(z.string())
          .optional()
          .describe(
            "GL account codes of suspense/clearing accounts to list open lines for (default ['1940','1050'])."
          ),
      },
    },
    async (args) => {
      try {
        const year = args.year ?? new Date().getFullYear();
        const suspenseCodes = args.suspense_gl_codes ?? ["1940", "1050"];
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year}-12-31`;

        const receivablesPath = await client.divisionPath(
          "read/financial/ReceivablesList",
          args.division
        );
        const payablesPath = await client.divisionPath(
          "read/financial/PayablesList",
          args.division
        );
        const linesPath = await client.divisionPath(
          "financialtransaction/TransactionLines",
          args.division
        );
        const salesPath = await client.divisionPath(
          "salesinvoice/SalesInvoices",
          args.division
        );
        const purchasePath = await client.divisionPath(
          "purchaseentry/PurchaseEntries",
          args.division
        );

        const [negativeReceivables, negativePayables] = [
          await client.getAll<OpenItem>(
            receivablesPath,
            { $filter: "Amount lt 0", $select: OPEN_ITEM_SELECT, $top: 100 },
            100
          ),
          await client.getAll<OpenItem>(
            payablesPath,
            { $filter: "Amount lt 0", $select: OPEN_ITEM_SELECT, $top: 100 },
            100
          ),
        ];

        const suspense: Record<string, unknown> = {};
        for (const code of suspenseCodes) {
          const lines = await client.getAll(
            linesPath,
            {
              $filter:
                `GLAccountCode eq ${odataString(code)} and ` +
                `Date ge ${toExactDate(yearStart)} and Date le ${toExactDate(yearEnd)}`,
              $select:
                "Date,JournalCode,EntryNumber,Description,AmountDC,AccountName,InvoiceNumber",
              $orderby: "Date desc",
              $top: 100,
            },
            100
          );
          suspense[code] = lines;
        }

        const monthOf = (iso?: string): number | undefined => {
          if (!iso) return undefined;
          const month = Number(iso.slice(5, 7));
          return Number.isInteger(month) ? month : undefined;
        };
        const countPerMonth = (dates: Array<string | undefined>): number[] => {
          const counts = Array.from({ length: 12 }, () => 0);
          for (const date of dates) {
            const month = monthOf(date);
            if (month) counts[month - 1]++;
          }
          return counts;
        };

        const sales = await client.getAll<{ InvoiceDate?: string }>(
          salesPath,
          {
            $filter: `InvoiceDate ge ${toExactDate(yearStart)} and InvoiceDate le ${toExactDate(yearEnd)}`,
            $select: "InvoiceDate",
            $top: 500,
          },
          500
        );
        const purchases = await client.getAll<{ EntryDate?: string }>(
          purchasePath,
          {
            $filter: `EntryDate ge ${toExactDate(yearStart)} and EntryDate le ${toExactDate(yearEnd)}`,
            $select: "EntryDate",
            $top: 500,
          },
          500
        );
        const salesPerMonth = countPerMonth(sales.results.map((r) => r.InvoiceDate));
        const purchasesPerMonth = countPerMonth(
          purchases.results.map((r) => r.EntryDate)
        );
        const monthsElapsed =
          year < new Date().getFullYear() ? 12 : new Date().getMonth() + 1;
        const gapMonths = (counts: number[]): number[] =>
          counts
            .map((count, i) => (count === 0 && i < monthsElapsed ? i + 1 : 0))
            .filter(Boolean);

        return okJson({
          year,
          negative_receivables: negativeReceivables,
          negative_payables: negativePayables,
          suspense_account_lines: suspense,
          sales_invoices_per_month: salesPerMonth,
          sales_invoice_gap_months: gapMonths(salesPerMonth),
          purchase_entries_per_month: purchasesPerMonth,
          purchase_entry_gap_months: gapMonths(purchasesPerMonth),
          note:
            sales.truncated || purchases.truncated
              ? "Monthly counts are based on the first 500 documents and may be incomplete."
              : undefined,
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_bank_status",
    {
      title: "Bank import status",
      description:
        "Health check of the bank feeds in one call: per bank journal the number of " +
        "booked statements, the date of the last one, days since that last import, and " +
        "continuity mismatches where a statement's opening balance does not equal the " +
        "previous statement's closing balance (a gap in the feed). Based on " +
        "financialtransaction/BankEntries.",
      inputSchema: {
        division: divisionParam,
        financial_year: z
          .number()
          .int()
          .optional()
          .describe("Restrict to one financial year."),
      },
    },
    async (args) => {
      try {
        const path = await client.divisionPath(
          "financialtransaction/BankEntries",
          args.division
        );
        interface BankEntry {
          EntryNumber?: number;
          JournalCode?: string;
          JournalDescription?: string;
          FinancialYear?: number;
          OpeningBalanceFC?: number;
          ClosingBalanceFC?: number;
          Created?: string;
        }
        const entries = await client.getAll<BankEntry>(
          path,
          {
            $filter:
              args.financial_year !== undefined
                ? `FinancialYear eq ${args.financial_year}`
                : undefined,
            $select:
              "EntryNumber,JournalCode,JournalDescription,FinancialYear,OpeningBalanceFC,ClosingBalanceFC,Created",
            $orderby: "Created desc",
            $top: 500,
          },
          500
        );
        const byJournal = new Map<string, BankEntry[]>();
        for (const entry of entries.results) {
          const code = entry.JournalCode ?? "?";
          const list = byJournal.get(code) ?? [];
          list.push(entry);
          byJournal.set(code, list);
        }
        const journals = [...byJournal.entries()].map(([code, list]) => {
          const sorted = [...list].sort((a, b) =>
            (a.Created ?? "").localeCompare(b.Created ?? "")
          );
          const last = sorted[sorted.length - 1];
          const daysSince = last?.Created
            ? Math.floor((Date.now() - Date.parse(last.Created)) / 86_400_000)
            : undefined;
          const mismatches = [];
          for (let i = 1; i < sorted.length; i++) {
            const previous = sorted[i - 1];
            const current = sorted[i];
            if (
              previous.ClosingBalanceFC !== undefined &&
              current.OpeningBalanceFC !== undefined &&
              round2(previous.ClosingBalanceFC) !== round2(current.OpeningBalanceFC)
            ) {
              mismatches.push({
                previous_entry: previous.EntryNumber,
                previous_closing: previous.ClosingBalanceFC,
                entry: current.EntryNumber,
                opening: current.OpeningBalanceFC,
                created: current.Created,
              });
            }
          }
          return {
            journal_code: code,
            journal_description: last?.JournalDescription,
            statements: list.length,
            last_import: last?.Created,
            days_since_last_import: daysSince,
            balance_mismatches: mismatches,
          };
        });
        return okJson({
          journals,
          note: entries.truncated
            ? "Based on the 500 most recent statements; older gaps may be missed."
            : undefined,
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_inbox",
    {
      title: "Inbox (digital postbox) with attachments",
      description:
        "One-call view of the digital postbox: received mail messages (e.g. incoming " +
        "Peppol/UBL invoices) each with their attachments (file name, size, download url) " +
        "joined in. Use `status` to see only unprocessed items (statuses are indicative: " +
        "20=open, 30=processed). Combines mailbox/MailMessagesReceived and " +
        "mailbox/MailMessageAttachments.",
      inputSchema: {
        division: divisionParam,
        status: z
          .number()
          .int()
          .optional()
          .describe("Message status to filter by, e.g. 20 for open/unprocessed."),
        top: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Maximum number of messages (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const messagesPath = await client.divisionPath(
          "mailbox/MailMessagesReceived",
          args.division
        );
        const attachmentsPath = await client.divisionPath(
          "mailbox/MailMessageAttachments",
          args.division
        );
        const messages = await client.getAll<{ ID?: string }>(
          messagesPath,
          {
            $filter:
              args.status !== undefined ? `Status eq ${args.status}` : undefined,
            $top: max,
          },
          max
        );
        interface Attachment {
          MailMessageID?: string;
          [key: string]: unknown;
        }
        const attachments = await client.getAll<Attachment>(
          attachmentsPath,
          { $top: 500 },
          500
        );
        const byMessage = new Map<string, Attachment[]>();
        for (const attachment of attachments.results) {
          const id = attachment.MailMessageID;
          if (!id) continue;
          const list = byMessage.get(id) ?? [];
          list.push(attachment);
          byMessage.set(id, list);
        }
        const joined = messages.results.map((message) => ({
          ...message,
          attachments: message.ID ? byMessage.get(message.ID) ?? [] : [],
        }));
        return okJson({
          count: joined.length,
          truncated: messages.truncated,
          messages: joined,
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_match_suggestions",
    {
      title: "Suggest matches for open items",
      description:
        "Heuristic matching aid: takes negative receivables/payables (payments without an " +
        "invoice) as candidates and suggests counterparts among open receivables/payables " +
        "and inbox documents, matched on (1) equal absolute amount within 1 cent and (2) " +
        "invoice number / reference appearing in the other side's description or subject. " +
        "Suggestions are hints to verify, not bookings. Replaces manually cross-checking " +
        "the lists.",
      inputSchema: {
        division: divisionParam,
      },
    },
    async (args) => {
      try {
        const receivablesPath = await client.divisionPath(
          "read/financial/ReceivablesList",
          args.division
        );
        const payablesPath = await client.divisionPath(
          "read/financial/PayablesList",
          args.division
        );
        const inboxPath = await client.divisionPath(
          "mailbox/MailMessagesReceived",
          args.division
        );
        const receivables = await client.getAll<OpenItem>(
          receivablesPath,
          { $select: OPEN_ITEM_SELECT, $top: 500 },
          500
        );
        const payables = await client.getAll<OpenItem>(
          payablesPath,
          { $select: OPEN_ITEM_SELECT, $top: 500 },
          500
        );
        const inbox = await client.getAll<{ ID?: string; Subject?: string }>(
          inboxPath,
          { $top: 200 },
          200
        );

        const openItems = [
          ...receivables.results.map((item) => ({ side: "receivable", ...item })),
          ...payables.results.map((item) => ({ side: "payable", ...item })),
        ];
        const candidates = openItems.filter((item) => (item.Amount ?? 0) < 0);
        const targets = openItems.filter((item) => (item.Amount ?? 0) > 0);

        const refOf = (item: OpenItem): string[] =>
          [String(item.InvoiceNumber ?? ""), item.YourRef ?? ""].filter(
            (ref) => ref.length >= 4
          );

        const suggestions = candidates.map((candidate) => {
          const amount = Math.abs(candidate.Amount ?? 0);
          const matches: unknown[] = [];
          for (const target of targets) {
            const sameAmount = Math.abs((target.Amount ?? 0) - amount) < 0.01;
            const refHit = refOf(candidate).some(
              (ref) =>
                String(target.InvoiceNumber ?? "").includes(ref) ||
                (target.YourRef ?? "").includes(ref)
            );
            if (sameAmount || refHit) {
              matches.push({
                type: "open_item",
                matched_on: sameAmount ? "amount" : "reference",
                ...target,
              });
            }
          }
          for (const message of inbox.results) {
            const subject = message.Subject ?? "";
            const refHit = refOf(candidate).some((ref) => subject.includes(ref));
            if (refHit) {
              matches.push({
                type: "inbox_message",
                matched_on: "reference",
                id: message.ID,
                subject,
              });
            }
          }
          return { candidate, suggestions: matches };
        });

        return okJson({
          candidates: suggestions.length,
          results: suggestions,
          note: "Heuristic suggestions — verify before booking or matching.",
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_group_report",
    {
      title: "Group P&L report (multi-division consolidation)",
      description:
        "Consolidated profit & loss across multiple administrations in one call. For each " +
        "division (code or alias) the P&L totals for the year are computed from " +
        "financial/ReportingBalance; intercompany GL accounts listed in `eliminate` are " +
        "summed separately and removed from the consolidated totals (e.g. management fee " +
        "and rent booked on both sides). Output: per-division totals, eliminations, and " +
        "consolidated revenue/costs/result.",
      inputSchema: {
        year: z.number().int().describe("Reporting year."),
        divisions: z
          .array(z.union([z.number().int().positive(), z.string()]))
          .min(1)
          .describe("Divisions to include: codes or configured aliases."),
        eliminate: z
          .array(
            z.object({
              division: z
                .union([z.number().int().positive(), z.string()])
                .describe("Division the GL codes apply to."),
              gl_account_codes: z
                .array(z.string())
                .describe("Intercompany GL account codes to eliminate."),
            })
          )
          .optional()
          .describe(
            "Intercompany elimination mapping, e.g. the holding's management-fee revenue accounts vs the subsidiary's management-fee cost accounts."
          ),
      },
    },
    async (args) => {
      try {
        const eliminationFor = async (
          division: number | string
        ): Promise<Set<string>> => {
          const resolved = await client.resolveDivision(division);
          const codes = new Set<string>();
          for (const entry of args.eliminate ?? []) {
            if ((await client.resolveDivision(entry.division)) === resolved) {
              for (const code of entry.gl_account_codes) codes.add(code);
            }
          }
          return codes;
        };

        const perDivision = [];
        const consolidated = { revenue: 0, costs: 0, result: 0 };
        const eliminatedTotal = { revenue: 0, costs: 0 };
        for (const division of args.divisions) {
          const { rows, truncated } = await fetchPlRows(
            client,
            division,
            args.year
          );
          const eliminate = await eliminationFor(division);
          const kept = rows.filter(
            (row) => !eliminate.has(row.GLAccountCode ?? "")
          );
          const eliminated = rows.filter((row) =>
            eliminate.has(row.GLAccountCode ?? "")
          );
          const totals = summarizePl(rows);
          const keptTotals = summarizePl(kept);
          const eliminatedTotals = summarizePl(eliminated);
          consolidated.revenue = round2(consolidated.revenue + keptTotals.revenue);
          consolidated.costs = round2(consolidated.costs + keptTotals.costs);
          consolidated.result = round2(consolidated.result + keptTotals.result);
          eliminatedTotal.revenue = round2(
            eliminatedTotal.revenue + eliminatedTotals.revenue
          );
          eliminatedTotal.costs = round2(
            eliminatedTotal.costs + eliminatedTotals.costs
          );
          perDivision.push({
            division: await client.resolveDivision(division),
            requested_as: division,
            totals,
            after_elimination: keptTotals,
            eliminated: eliminatedTotals,
            truncated,
          });
        }
        return okJson({
          year: args.year,
          divisions: perDivision,
          eliminations: eliminatedTotal,
          consolidated,
        });
      } catch (e) {
        return errText(e);
      }
    }
  );
}
