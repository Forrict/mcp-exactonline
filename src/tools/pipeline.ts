import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { okJson, errText, divisionParam, guid } from "./helpers.js";

/**
 * Register the "pipeline" tools on the MCP server: CRM sales pipeline data
 * (quotations, opportunities) and account-related reference data (addresses,
 * bank accounts).
 */
export function registerPipelineTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_list_quotations",
    {
      title: "List quotations",
      description:
        "List sales quotations (offertes) from the CRM pipeline, with all quotation " +
        "fields such as QuotationNumber, Description, the customer account, amounts and " +
        "Status. Use `status` to filter on the numeric quotation status. Backed by GET " +
        "/{division}/crm/Quotations.",
      inputSchema: {
        division: divisionParam,
        status: z
          .number()
          .int()
          .optional()
          .describe("Quotation status to filter by (Status eq N)."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of quotations to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath("crm/Quotations", args.division);
        const result = await client.getAll(
          path,
          {
            $filter:
              args.status !== undefined ? `Status eq ${args.status}` : undefined,
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
    "exact_list_opportunities",
    {
      title: "List opportunities",
      description:
        "List CRM sales opportunities (verkoopkansen) with all opportunity fields such " +
        "as Name, the linked Account, AmountDC, Probability, sales stage and expected " +
        "close date. Filter by `account_id` to see the pipeline for one customer. Backed " +
        "by GET /{division}/crm/Opportunities.",
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
          .describe("Maximum number of opportunities to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath(
          "crm/Opportunities",
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
    "exact_list_addresses",
    {
      title: "List addresses",
      description:
        "List addresses registered on CRM accounts (visit, postal, delivery and invoice " +
        "addresses) with all address fields such as AddressLine1, City, Postcode, Country " +
        "and Type. Filter by `account_id` to get the addresses of one account. Backed by " +
        "GET /{division}/crm/Addresses.",
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
          .describe("Maximum number of addresses to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath("crm/Addresses", args.division);
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
    "exact_list_account_bank_accounts",
    {
      title: "List account bank accounts",
      description:
        "List bank accounts registered on CRM accounts (customers/suppliers), with fields " +
        "such as BankAccount (IBAN), BankName, BICCode and whether it is the main account. " +
        "Filter by `account_id` to get the bank accounts of one account. Backed by GET " +
        "/{division}/crm/BankAccounts.",
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
          .describe("Maximum number of bank accounts to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath(
          "crm/BankAccounts",
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
}
