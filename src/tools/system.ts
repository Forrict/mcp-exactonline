import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { okJson, errText, divisionParam } from "./helpers.js";

// Re-export helpers so phase-2 modules can import them from here if preferred.
export { okJson, errText } from "./helpers.js";

/**
 * Allowed shape of the generic OData resource path: path segments of
 * letters/digits/underscores, optionally ending in a GUID key. Rules out `..`,
 * query strings and anything else that would escape the /api/v1/{division}/
 * prefix.
 */
const RESOURCE_RE =
  /^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*(?:\(guid'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'\))?$/;

/**
 * Register the core "system" tools on the MCP server.
 * These provide identity, division discovery, and a generic OData escape hatch.
 */
export function registerSystemTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_get_current_user",
    {
      title: "Get current user",
      description:
        "Return the authenticated Exact Online user (name, email, user id) and the current division. Backed by GET /current/Me.",
      inputSchema: {},
    },
    async () => {
      try {
        const me = await client.getCurrentDivision();
        return okJson(me);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_list_divisions",
    {
      title: "List divisions",
      description:
        "List the administrations/divisions accessible to the current user, with Code, Description, CustomerName, Country and Currency. Backed by GET /{division}/system/Divisions.",
      inputSchema: {},
    },
    async () => {
      try {
        const path = await client.divisionPath("system/Divisions");
        const result = await client.getAll(path, {
          $select: "Code,Description,CustomerName,Country,Currency",
        });
        return okJson(result);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_odata_query",
    {
      title: "OData query (generic)",
      description:
        "Escape hatch to query ANY Exact Online REST API v1 resource with OData parameters. " +
        "Provide `resource` as a division-relative path such as `crm/Accounts`, `crm/Contacts`, " +
        "`financial/GLAccounts`, `salesinvoice/SalesInvoices`, `logistics/Items`, or " +
        "`purchaseorder/PurchaseOrders`. The active division is prefixed automatically. " +
        "Optional OData params: `filter` ($filter), `select` ($select, comma-separated), " +
        "`orderby` ($orderby), and `top` (max 500). Results follow __next pagination up to `top`/500 rows.",
      inputSchema: {
        division: divisionParam,
        resource: z
          .string()
          .regex(
            RESOURCE_RE,
            "Must be a division-relative resource path such as 'crm/Accounts' or 'read/financial/ReceivablesList', optionally with a (guid'...') key."
          )
          .describe(
            "Division-relative resource path, e.g. 'crm/Accounts' or 'financial/GLAccounts'. Letters, digits, underscores and slashes only; an optional (guid'...') key is allowed."
          ),
        filter: z
          .string()
          .optional()
          .describe("OData $filter expression, e.g. \"Status eq 'C'\"."),
        select: z
          .string()
          .optional()
          .describe("Comma-separated list of fields for $select."),
        orderby: z
          .string()
          .optional()
          .describe("OData $orderby expression, e.g. 'Created desc'."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of rows to return (default and cap: 500)."),
      },
    },
    async (args) => {
      try {
        const { resource, filter, select, orderby, top } = args;
        const path = await client.divisionPath(resource, args.division);
        const max = top ?? 500;
        const result = await client.getAll(
          path,
          {
            $filter: filter,
            $select: select,
            $orderby: orderby,
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
