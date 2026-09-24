import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { okJson, errText, divisionParam } from "./helpers.js";

/**
 * Register the "HR" tools on the MCP server: employees, departments and
 * leave registrations.
 */
export function registerHrTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_list_employees",
    {
      title: "List employees",
      description:
        "List employees from the payroll administration, with all employee fields such " +
        "as Code, FullName, Email, JobTitleDescription, StartDate/EndDate and the linked " +
        "user. Backed by GET /{division}/payroll/Employees.",
      inputSchema: {
        division: divisionParam,
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of employees to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath(
          "payroll/Employees",
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
    "exact_list_departments",
    {
      title: "List departments",
      description:
        "List departments (afdelingen) from the HRM administration, with fields such as " +
        "Code, Description and the department manager. Backed by GET " +
        "/{division}/hrm/Departments.",
      inputSchema: {
        division: divisionParam,
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of departments to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath(
          "hrm/Departments",
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
    "exact_list_leave_registrations",
    {
      title: "List leave registrations",
      description:
        "List leave registrations (verlofregistraties) of employees, with the Employee, " +
        "leave type, StartDate/EndDate, hours and status. Requires the HRM/leave module " +
        "to be enabled in the administration; without it the endpoint returns an error " +
        "or no data. Filter by `employee_id` to get the leave of one employee. Backed by " +
        "GET /{division}/hrm/LeaveRegistrations.",
      inputSchema: {
        division: divisionParam,
        employee_id: z
          .string()
          .optional()
          .describe("Employee GUID to filter by (Employee eq guid'...')."),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of leave registrations to return (default 100)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 100;
        const path = await client.divisionPath(
          "hrm/LeaveRegistrations",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: args.employee_id
              ? `Employee eq guid'${args.employee_id}'`
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
