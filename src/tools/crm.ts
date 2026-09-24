import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { okJson, errText, divisionParam } from "./helpers.js";

/**
 * Escape a value for use inside an OData string literal (single quotes).
 * Exact/OData v3 escapes an embedded single quote by doubling it.
 */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build a `substringof('term', Field) eq true` clause with a safe literal. */
function substringOf(term: string, field: string): string {
  return `substringof(${odataString(term)}, ${field}) eq true`;
}

/** $select field list for account list rows. */
const ACCOUNT_LIST_SELECT = [
  "ID",
  "Code",
  "Name",
  "Status",
  "Email",
  "Phone",
  "Website",
  "AddressLine1",
  "Postcode",
  "City",
  "CountryName",
  "VATNumber",
  "IsSupplier",
  "IsSales",
  "StartDate",
].join(",");

/** $select field list for a single, detailed account. */
const ACCOUNT_DETAIL_SELECT = [
  "ID",
  "Code",
  "Name",
  "Status",
  "Email",
  "Phone",
  "Website",
  "AddressLine1",
  "Postcode",
  "City",
  "CountryName",
  "VATNumber",
  "IsSupplier",
  "IsSales",
  "StartDate",
  "Remarks",
  "ChamberOfCommerce",
  "PaymentConditionSales",
  "PaymentConditionPurchase",
  "CreditLinePurchase",
  "CreditLineSales",
  "Language",
  "Currency",
].join(",");

/** $select field list for contact rows. */
const CONTACT_SELECT = [
  "ID",
  "Account",
  "AccountName",
  "FirstName",
  "LastName",
  "FullName",
  "Email",
  "Phone",
  "Mobile",
  "JobTitleDescription",
  "IsMainContact",
].join(",");

/**
 * Register the CRM tools (accounts + contacts) on the MCP server.
 * Covers listing/reading accounts and contacts as well as creating/updating
 * them. Create/update tools WRITE to the connected Exact Online administration.
 */
export function registerCrmTools(server: McpServer, client: ExactClient): void {
  server.registerTool(
    "exact_list_accounts",
    {
      title: "List accounts",
      description:
        "Search and list CRM accounts (customers, suppliers, prospects and suspects) from Exact Online. " +
        "Backed by GET /{division}/crm/Accounts. All inputs are optional and are combined with AND. " +
        "Use `search` for a case-insensitive substring match on the account Name. " +
        "Use `code` for an EXACT match on the account Code — note Code is a STRING and is usually " +
        "space-padded to 18 characters in Exact, so an exact match may require the padded value; " +
        "prefer `search` when unsure. Use `status` to filter by relationship type " +
        "(C=customer, P=prospect, S=suspect, A=none/all — passed through to Status eq 'X'). " +
        "Use `is_supplier` to filter to suppliers (true) or non-suppliers (false). " +
        "Returns key fields (ID, Code, Name, Status, contact + address + VAT details), ordered by Name.",
      inputSchema: {
        division: divisionParam,
        search: z
          .string()
          .optional()
          .describe("Case-insensitive substring to match against the account Name."),
        code: z
          .string()
          .optional()
          .describe(
            "Exact account Code to match. Code is a string, often space-padded to 18 chars in Exact."
          ),
        status: z
          .enum(["C", "P", "S", "A"])
          .optional()
          .describe(
            "Relationship status filter: C=customer, P=prospect, S=suspect, A=none. Passed to Status eq 'X'."
          ),
        is_supplier: z
          .boolean()
          .optional()
          .describe("Filter to accounts that are (true) or are not (false) suppliers."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of rows to return (default 50, max 500)."),
      },
    },
    async (args) => {
      try {
        const { search, code, status, is_supplier, top } = args;
        const filters: string[] = [];
        if (search) filters.push(substringOf(search, "Name"));
        if (code) filters.push(`Code eq ${odataString(code)}`);
        if (status) filters.push(`Status eq ${odataString(status)}`);
        if (is_supplier !== undefined) {
          filters.push(`IsSupplier eq ${is_supplier ? "true" : "false"}`);
        }
        const max = top ?? 50;
        const path = await client.divisionPath("crm/Accounts", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select: ACCOUNT_LIST_SELECT,
            $orderby: "Name",
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
    "exact_get_account",
    {
      title: "Get account",
      description:
        "Fetch a single CRM account by its GUID id, with a wide set of fields including remarks, " +
        "chamber of commerce number, payment conditions, credit lines, language and currency. " +
        "Backed by GET /{division}/crm/Accounts(guid'{id}'). Use exact_list_accounts first to find the id.",
      inputSchema: {
        division: divisionParam,
        id: z
          .string()
          .describe("The account GUID (ID field from exact_list_accounts)."),
      },
    },
    async (args) => {
      try {
        const { id } = args;
        const path = await client.divisionPath(`crm/Accounts(guid'${id}')`, args.division);
        const result = await client.request("GET", path, {
          params: { $select: ACCOUNT_DETAIL_SELECT },
        });
        return okJson(result);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_create_account",
    {
      title: "Create account",
      description:
        "CREATE a new CRM account (customer/supplier/prospect) in the connected Exact Online administration. " +
        "This WRITES data to the accounting system and is not reversible from here. " +
        "Backed by POST /{division}/crm/Accounts. Only `name` is required; `status` defaults to 'C' (customer). " +
        "`country` must be a 2-letter ISO country code (e.g. 'NL', 'DE'). " +
        "Returns the newly created account record.",
      inputSchema: {
        division: divisionParam,
        name: z.string().describe("Account name (required)."),
        status: z
          .enum(["C", "P", "S", "A"])
          .optional()
          .describe("Relationship status: C=customer (default), P=prospect, S=suspect, A=none."),
        email: z.string().optional().describe("Primary email address."),
        phone: z.string().optional().describe("Phone number."),
        website: z.string().optional().describe("Website URL."),
        address_line1: z.string().optional().describe("Street address line 1."),
        postcode: z.string().optional().describe("Postal / ZIP code."),
        city: z.string().optional().describe("City."),
        country: z
          .string()
          .optional()
          .describe("2-letter ISO country code, e.g. 'NL' or 'DE'."),
        vat_number: z.string().optional().describe("VAT registration number."),
        is_supplier: z
          .boolean()
          .optional()
          .describe("Whether this account is a supplier."),
        chamber_of_commerce: z
          .string()
          .optional()
          .describe("Chamber of Commerce registration number."),
        remarks: z.string().optional().describe("Free-text remarks / notes."),
      },
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = { Name: args.name };
        body.Status = args.status ?? "C";
        if (args.email !== undefined) body.Email = args.email;
        if (args.phone !== undefined) body.Phone = args.phone;
        if (args.website !== undefined) body.Website = args.website;
        if (args.address_line1 !== undefined) body.AddressLine1 = args.address_line1;
        if (args.postcode !== undefined) body.Postcode = args.postcode;
        if (args.city !== undefined) body.City = args.city;
        if (args.country !== undefined) body.Country = args.country;
        if (args.vat_number !== undefined) body.VATNumber = args.vat_number;
        if (args.is_supplier !== undefined) body.IsSupplier = args.is_supplier;
        if (args.chamber_of_commerce !== undefined) {
          body.ChamberOfCommerce = args.chamber_of_commerce;
        }
        if (args.remarks !== undefined) body.Remarks = args.remarks;

        const path = await client.divisionPath("crm/Accounts", args.division);
        const result = await client.request("POST", path, { body });
        return okJson(result);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_update_account",
    {
      title: "Update account",
      description:
        "UPDATE an existing CRM account in the connected Exact Online administration. " +
        "This WRITES data to the accounting system. Backed by PUT /{division}/crm/Accounts(guid'{id}'). " +
        "`id` is required; only the fields you provide are changed (others are left untouched). " +
        "`country` must be a 2-letter ISO country code. Exact returns no content on success, " +
        "so this reports a success message rather than the updated record — re-read with exact_get_account to confirm.",
      inputSchema: {
        division: divisionParam,
        id: z.string().describe("The account GUID to update (required)."),
        name: z.string().optional().describe("Account name."),
        status: z
          .enum(["C", "P", "S", "A"])
          .optional()
          .describe("Relationship status: C=customer, P=prospect, S=suspect, A=none."),
        email: z.string().optional().describe("Primary email address."),
        phone: z.string().optional().describe("Phone number."),
        website: z.string().optional().describe("Website URL."),
        address_line1: z.string().optional().describe("Street address line 1."),
        postcode: z.string().optional().describe("Postal / ZIP code."),
        city: z.string().optional().describe("City."),
        country: z
          .string()
          .optional()
          .describe("2-letter ISO country code, e.g. 'NL' or 'DE'."),
        vat_number: z.string().optional().describe("VAT registration number."),
        is_supplier: z
          .boolean()
          .optional()
          .describe("Whether this account is a supplier."),
        chamber_of_commerce: z
          .string()
          .optional()
          .describe("Chamber of Commerce registration number."),
        remarks: z.string().optional().describe("Free-text remarks / notes."),
      },
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.Name = args.name;
        if (args.status !== undefined) body.Status = args.status;
        if (args.email !== undefined) body.Email = args.email;
        if (args.phone !== undefined) body.Phone = args.phone;
        if (args.website !== undefined) body.Website = args.website;
        if (args.address_line1 !== undefined) body.AddressLine1 = args.address_line1;
        if (args.postcode !== undefined) body.Postcode = args.postcode;
        if (args.city !== undefined) body.City = args.city;
        if (args.country !== undefined) body.Country = args.country;
        if (args.vat_number !== undefined) body.VATNumber = args.vat_number;
        if (args.is_supplier !== undefined) body.IsSupplier = args.is_supplier;
        if (args.chamber_of_commerce !== undefined) {
          body.ChamberOfCommerce = args.chamber_of_commerce;
        }
        if (args.remarks !== undefined) body.Remarks = args.remarks;

        const path = await client.divisionPath(`crm/Accounts(guid'${args.id}')`, args.division);
        const result = await client.request<unknown>("PUT", path, { body });
        if (result === undefined) {
          return okJson({
            success: true,
            id: args.id,
            message: "Account updated (Exact returned no content).",
          });
        }
        return okJson(result);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_list_contacts",
    {
      title: "List contacts",
      description:
        "Search and list CRM contact persons from Exact Online. Backed by GET /{division}/crm/Contacts. " +
        "All inputs are optional and combined with AND. Use `account_id` (a GUID) to list only contacts " +
        "belonging to a specific account. Use `search` for a case-insensitive substring match against " +
        "the contact's first OR last name. Returns id, linked account, name, email, phone/mobile, " +
        "job title and whether the contact is the account's main contact.",
      inputSchema: {
        division: divisionParam,
        account_id: z
          .string()
          .optional()
          .describe("Account GUID to list contacts for (matches the Account field)."),
        search: z
          .string()
          .optional()
          .describe("Case-insensitive substring matched against FirstName or LastName."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of rows to return (default 50, max 500)."),
      },
    },
    async (args) => {
      try {
        const { account_id, search, top } = args;
        const filters: string[] = [];
        if (account_id) filters.push(`Account eq guid'${account_id}'`);
        if (search) {
          filters.push(
            `(${substringOf(search, "FirstName")} or ${substringOf(search, "LastName")})`
          );
        }
        const max = top ?? 50;
        const path = await client.divisionPath("crm/Contacts", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select: CONTACT_SELECT,
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
    "exact_create_contact",
    {
      title: "Create contact",
      description:
        "CREATE a new CRM contact person linked to an account in the connected Exact Online administration. " +
        "This WRITES data to the accounting system. Backed by POST /{division}/crm/Contacts. " +
        "`account_id` (GUID), `first_name` and `last_name` are required; the rest are optional. " +
        "Returns the newly created contact record.",
      inputSchema: {
        division: divisionParam,
        account_id: z
          .string()
          .describe("GUID of the account this contact belongs to (required)."),
        first_name: z.string().describe("Contact first name (required)."),
        last_name: z.string().describe("Contact last name (required)."),
        email: z.string().optional().describe("Email address."),
        phone: z.string().optional().describe("Phone number."),
        mobile: z.string().optional().describe("Mobile phone number."),
        job_title: z
          .string()
          .optional()
          .describe("Job title / function (maps to JobTitleDescription)."),
      },
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          Account: args.account_id,
          FirstName: args.first_name,
          LastName: args.last_name,
        };
        if (args.email !== undefined) body.Email = args.email;
        if (args.phone !== undefined) body.Phone = args.phone;
        if (args.mobile !== undefined) body.Mobile = args.mobile;
        if (args.job_title !== undefined) body.JobTitleDescription = args.job_title;

        const path = await client.divisionPath("crm/Contacts", args.division);
        const result = await client.request("POST", path, { body });
        return okJson(result);
      } catch (e) {
        return errText(e);
      }
    }
  );
}
