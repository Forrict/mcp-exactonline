import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { okJson, errText, divisionParam, guid } from "./helpers.js";

/**
 * Register the "mailbox" tools on the MCP server: the digital postbox
 * (digitale postbus) with received mail messages such as incoming Peppol/UBL
 * invoices, and their attachments.
 */
export function registerMailboxTools(
  server: McpServer,
  client: ExactClient
): void {
  server.registerTool(
    "exact_list_mail_messages",
    {
      title: "List received mail messages (digital postbox)",
      description:
        "List messages received in the digital postbox (digitale postbus → inkomend), such " +
        "as incoming Peppol/UBL invoices and bank statements. Returns all message fields, " +
        "including Subject, Status + StatusDescription, Type + TypeDescription and the linked " +
        "Document. Use `status` to filter, e.g. only unprocessed messages (common statuses: " +
        "10=draft, 20=open/unprocessed, 25=processing, 30=processed, 5=rejected). Backed by " +
        "GET /{division}/mailbox/MailMessagesReceived.",
      inputSchema: {
        division: divisionParam,
        status: z
          .number()
          .int()
          .optional()
          .describe(
            "Message status to filter by (Status eq N), e.g. 20 for open/unprocessed."
          ),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of messages to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath(
          "mailbox/MailMessagesReceived",
          args.division
        );
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
    "exact_list_mail_message_attachments",
    {
      title: "List mail message attachments",
      description:
        "List the attachments of digital postbox mail messages (e.g. the UBL/PDF files of an " +
        "incoming invoice), with FileName, FileSize, the parent MailMessageID and a download " +
        "Url where present. Filter by `mail_message_id` to get the attachments of one message " +
        "from exact_list_mail_messages. Backed by GET /{division}/mailbox/MailMessageAttachments.",
      inputSchema: {
        division: divisionParam,
        mail_message_id: guid
          .optional()
          .describe(
            "Mail message GUID to filter by (MailMessageID eq guid'...')."
          ),
        top: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Maximum number of attachments to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const max = args.top ?? 50;
        const path = await client.divisionPath(
          "mailbox/MailMessageAttachments",
          args.division
        );
        const result = await client.getAll(
          path,
          {
            $filter: args.mail_message_id
              ? `MailMessageID eq guid'${args.mail_message_id}'`
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
