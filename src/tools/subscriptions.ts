import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { okJson, errText, divisionParam, guid } from "./helpers.js";

/**
 * Register the "subscription" tools on the MCP server: recurring
 * contracts/subscriptions with their lines, plus manufacturing shop orders.
 */
export function registerSubscriptionTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_list_subscriptions",
    {
      title: "List subscriptions",
      description:
        "List recurring contracts/subscriptions (abonnementen), the basis for recurring " +
        "revenue (MRR) questions. Returns all subscription fields such as Number, " +
        "Description, the ordering/invoicing customer, StartDate/EndDate, the " +
        "subscription type and invoicing cadence. Backed by GET " +
        "/{division}/subscription/Subscriptions.",
      inputSchema: {
        division: divisionParam,
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of subscriptions to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath(
          "subscription/Subscriptions",
          args.division
        );
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

  server.registerTool(
    "exact_list_subscription_lines",
    {
      title: "List subscription lines",
      description:
        "List the lines of recurring subscriptions, with the Item, Description, " +
        "Quantity, prices/amounts and the FromDate/ToDate the line applies to. Filter by " +
        "`subscription_id` (the EntryID of a subscription from exact_list_subscriptions) " +
        "to get the lines of one subscription. Backed by GET " +
        "/{division}/subscription/SubscriptionLines.",
      inputSchema: {
        division: divisionParam,
        subscription_id: guid
          .optional()
          .describe(
            "Subscription EntryID GUID to filter by (EntryID eq guid'...')."
          ),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of subscription lines to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath(
          "subscription/SubscriptionLines",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: args.subscription_id
              ? `EntryID eq guid'${args.subscription_id}'`
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
    "exact_list_shop_orders",
    {
      title: "List shop orders (production)",
      description:
        "List production orders (shop orders) from the manufacturing module, with all " +
        "shop order fields such as ShopOrderNumber, the Item being produced, planned " +
        "quantities and dates, and the order status. Requires the manufacturing module " +
        "to be enabled in the administration. Backed by GET " +
        "/{division}/manufacturing/ShopOrders.",
      inputSchema: {
        division: divisionParam,
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of shop orders to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath(
          "manufacturing/ShopOrders",
          args.division
        );
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
