import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { toExactDate } from "../client.js";
import { okJson, errText, divisionParam, guid, odataString } from "./helpers.js";

/**
 * Register the "project" tools on the MCP server: projects and the time
 * transactions (hours) written on them.
 */
export function registerProjectTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_list_projects",
    {
      title: "List projects",
      description:
        "List projects from the project administration, with all project fields such as " +
        "Code, Description, the customer Account, Type, StartDate/EndDate and budget " +
        "information. Filter by `code` to look up one project. Backed by GET " +
        "/{division}/project/Projects.",
      inputSchema: {
        division: divisionParam,
        code: z
          .string()
          .optional()
          .describe("Project code to filter by (Code eq '...')."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of projects to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath(
          "project/Projects",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: args.code ? `Code eq ${odataString(args.code)}` : undefined,
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
    "exact_list_time_transactions",
    {
      title: "List time transactions (hours)",
      description:
        "List time transactions: hours written on projects, with the Project, employee, " +
        "Date, Quantity (hours), hour type/item and billing status. Useful for questions " +
        "about written and unbilled hours. Filter by `project_id` and a date range on " +
        "Date. Backed by GET /{division}/project/TimeTransactions.",
      inputSchema: {
        division: divisionParam,
        project_id: guid
          .optional()
          .describe("Project GUID to filter by (Project eq guid'...')."),
        date_from: z
          .string()
          .optional()
          .describe(
            "Inclusive lower bound for Date, as an ISO date string (e.g. '2026-01-01')."
          ),
        date_to: z
          .string()
          .optional()
          .describe(
            "Inclusive upper bound for Date, as an ISO date string (e.g. '2026-12-31')."
          ),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of time transactions to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const filters: string[] = [];
        if (args.project_id) {
          filters.push(`Project eq guid'${args.project_id}'`);
        }
        if (args.date_from) {
          filters.push(`Date ge ${toExactDate(args.date_from)}`);
        }
        if (args.date_to) {
          filters.push(`Date le ${toExactDate(args.date_to)}`);
        }
        const max = args.top ?? 100;
        const path = await client.divisionPath(
          "project/TimeTransactions",
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
}
