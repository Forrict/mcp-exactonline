import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { okJson, errText, divisionParam } from "./helpers.js";

/** Wide $select for a single item lookup. */
const ITEM_DETAIL_SELECT =
  "ID,Code,Description,ItemGroupCode,ItemGroupDescription,IsSalesItem," +
  "IsStockItem,IsPurchaseItem,SalesVatCode,CostPriceStandard,AverageCost," +
  "Unit,UnitDescription,Barcode,Notes,ExtraDescription,StartDate,EndDate," +
  "Created,Modified";

interface ItemRow {
  ID: string;
  [key: string]: unknown;
}

/**
 * Register the "logistics" tools on the MCP server: item (product/article)
 * catalogue, sales price lists, and warehouse stock positions.
 */
export function registerLogisticsTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_list_items",
    {
      title: "List items",
      description:
        "List items (products/articles) from the logistics catalogue. Backed by " +
        "GET /{division}/logistics/Items. Search by code/description and filter " +
        "on sales/stock flags or item group.",
      inputSchema: {
        division: divisionParam,
        search: z
          .string()
          .optional()
          .describe("Substring searched in both Code and Description."),
        is_sales_item: z
          .boolean()
          .optional()
          .describe("Filter on IsSalesItem."),
        is_stock_item: z
          .boolean()
          .optional()
          .describe("Filter on IsStockItem."),
        item_group_code: z
          .string()
          .optional()
          .describe("Filter on ItemGroupCode (exact match)."),
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
        const { search, is_sales_item, is_stock_item, item_group_code, top } =
          args;
        const filters: string[] = [];
        if (search) {
          const term = search.replace(/'/g, "''");
          filters.push(
            `(substringof('${term}',Code) eq true or ` +
              `substringof('${term}',Description) eq true)`
          );
        }
        if (is_sales_item !== undefined) {
          filters.push(`IsSalesItem eq ${is_sales_item ? "true" : "false"}`);
        }
        if (is_stock_item !== undefined) {
          filters.push(`IsStockItem eq ${is_stock_item ? "true" : "false"}`);
        }
        if (item_group_code) {
          filters.push(
            `ItemGroupCode eq '${item_group_code.replace(/'/g, "''")}'`
          );
        }
        const max = top ?? 50;
        const path = await client.divisionPath("logistics/Items", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "ID,Code,Description,ItemGroupCode,ItemGroupDescription," +
              "IsSalesItem,IsStockItem,IsPurchaseItem,SalesVatCode," +
              "CostPriceStandard,AverageCost,Unit,UnitDescription,Barcode,Notes",
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
    "exact_get_item",
    {
      title: "Get item",
      description:
        "Return a single item (product/article) with full detail. Look it up by " +
        "either `id` (GUID) or `code` (exactly one is required). Backed by GET " +
        "/{division}/logistics/Items.",
      inputSchema: {
        division: divisionParam,
        id: z
          .string()
          .optional()
          .describe("Item ID GUID."),
        code: z
          .string()
          .optional()
          .describe("Item Code (as shown in the catalogue)."),
      },
    },
    async (args) => {
      try {
        const { id, code } = args;
        if ((id && code) || (!id && !code)) {
          throw new Error(
            "Provide exactly one of `id` or `code` to look up an item."
          );
        }
        if (id) {
          const path = await client.divisionPath(`logistics/Items(guid'${id}')`, args.division);
          const item = await client.request("GET", path, {
            params: { $select: ITEM_DETAIL_SELECT },
          });
          return okJson(item);
        }
        const codeValue = code as string;
        const path = await client.divisionPath("logistics/Items", args.division);
        const result = await client.getAll<ItemRow>(
          path,
          {
            $filter: `Code eq '${codeValue.replace(/'/g, "''")}'`,
            $select: ITEM_DETAIL_SELECT,
            $top: 1,
          },
          1
        );
        const item = result.results[0];
        if (!item) {
          throw new Error(`No item found with Code '${codeValue}'.`);
        }
        return okJson(item);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_list_sales_item_prices",
    {
      title: "List sales item prices",
      description:
        "List sales price list entries per item (optionally customer-specific). " +
        "Backed by GET /{division}/logistics/SalesItemPrices. Filter by item.",
      inputSchema: {
        division: divisionParam,
        item_id: z
          .string()
          .optional()
          .describe("Item GUID to filter on (Item eq guid'...')."),
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
        const { item_id, top } = args;
        const filters: string[] = [];
        if (item_id) filters.push(`Item eq guid'${item_id}'`);
        const max = top ?? 50;
        const path = await client.divisionPath("logistics/SalesItemPrices", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "ID,Item,ItemCode,ItemDescription,Account,AccountName,Price," +
              "Currency,Unit,UnitDescription,StartDate,EndDate,Quantity",
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
    "exact_list_stock_positions",
    {
      title: "List stock positions",
      description:
        "List current stock levels per item per warehouse. Backed by GET " +
        "/{division}/inventory/ItemWarehouses. Filter by item.",
      inputSchema: {
        division: divisionParam,
        item_id: z
          .string()
          .optional()
          .describe("Item GUID to filter on (Item eq guid'...')."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of rows to return (default 100, cap 500)."),
      },
    },
    async (args) => {
      try {
        const { item_id, top } = args;
        const filters: string[] = [];
        if (item_id) filters.push(`Item eq guid'${item_id}'`);
        const max = top ?? 100;
        const path = await client.divisionPath("inventory/ItemWarehouses", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "ID,Item,ItemCode,ItemDescription,Warehouse,WarehouseCode," +
              "CurrentStock,ReservedStock,PlannedStockIn,PlannedStockOut",
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
