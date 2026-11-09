import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExactClient } from "../client.js";
import { toExactDate } from "../client.js";
import { okJson, errText, divisionParam, dryRunParam, audit, guid } from "./helpers.js";

/**
 * Register the "sales" tools on the MCP server. These cover sales invoices
 * (list / get / create) and sales orders (list / get) in Exact Online.
 */
export function registerSalesTools(
  server: McpServer,
  client: ExactClient
): void {
  // --- Sales invoices -----------------------------------------------------

  server.registerTool(
    "exact_list_sales_invoices",
    {
      title: "List sales invoices",
      description:
        "List sales invoices from Exact Online, most recent first. Backed by GET " +
        "/{division}/salesinvoice/SalesInvoices. All filters are optional and combined with AND: " +
        "`date_from`/`date_to` bound InvoiceDate (inclusive, ISO 8601), `customer_id` filters on the " +
        "invoice recipient account (InvoiceTo, a GUID), `invoice_number` matches a specific numeric " +
        "InvoiceNumber, and `status` filters on the Exact invoice status code (common values: 10=draft, " +
        "20=open, 50=processed). Use `top` to cap the number of rows (default 50, max 500). Returns key " +
        "fields per invoice including totals (AmountDC, VATAmountDC), currency, and status description.",
      inputSchema: {
        division: divisionParam,
        date_from: z
          .string()
          .optional()
          .describe(
            "Only invoices with InvoiceDate on or after this ISO 8601 date/time (inclusive)."
          ),
        date_to: z
          .string()
          .optional()
          .describe(
            "Only invoices with InvoiceDate on or before this ISO 8601 date/time (inclusive)."
          ),
        customer_id: guid
          .optional()
          .describe(
            "Filter on the invoice recipient account GUID (InvoiceTo), e.g. the customer's account id."
          ),
        status: z
          .number()
          .int()
          .optional()
          .describe(
            "Exact invoice status code to filter on (Status). Common values: 10=draft, 20=open, 50=processed."
          ),
        invoice_number: z
          .number()
          .int()
          .optional()
          .describe("Match a specific numeric InvoiceNumber."),
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
        const { date_from, date_to, customer_id, status, invoice_number, top } =
          args;
        const filters: string[] = [];
        if (date_from) filters.push(`InvoiceDate ge ${toExactDate(date_from)}`);
        if (date_to) filters.push(`InvoiceDate le ${toExactDate(date_to)}`);
        if (customer_id) filters.push(`InvoiceTo eq guid'${customer_id}'`);
        if (status !== undefined) filters.push(`Status eq ${status}`);
        if (invoice_number !== undefined) {
          filters.push(`InvoiceNumber eq ${invoice_number}`);
        }

        const max = top ?? 50;
        const path = await client.divisionPath("salesinvoice/SalesInvoices", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "InvoiceID,InvoiceNumber,InvoiceDate,DueDate,InvoiceTo,InvoiceToName,OrderedBy,OrderedByName,Description,AmountDC,VATAmountDC,Currency,Status,StatusDescription,PaymentConditionDescription,YourRef",
            $orderby: "InvoiceDate desc",
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
    "exact_get_sales_invoice",
    {
      title: "Get sales invoice",
      description:
        "Fetch a single sales invoice with its header and all invoice lines. Backed by GET " +
        "/{division}/salesinvoice/SalesInvoices(guid'{id}') for the header and GET " +
        "/{division}/salesinvoice/SalesInvoiceLines filtered on InvoiceID for the lines. " +
        "Returns an object { invoice, lines } where `invoice` is the header and `lines` is the array " +
        "of line items (item, description, quantity, unit price, amounts, VAT, GL account).",
      inputSchema: {
        division: divisionParam,
        invoice_id: guid
          .describe("The sales invoice GUID (InvoiceID) to retrieve."),
      },
    },
    async (args) => {
      try {
        const { invoice_id } = args;
        const invoicePath = await client.divisionPath(`salesinvoice/SalesInvoices(guid'${invoice_id}')`, args.division);
        const invoice = await client.request("GET", invoicePath, {
          params: {
            $select:
              "InvoiceID,InvoiceNumber,InvoiceDate,DueDate,InvoiceTo,InvoiceToName,OrderedBy,OrderedByName,DeliverTo,DeliverToName,Description,AmountDC,AmountFC,VATAmountDC,VATAmountFC,Currency,Status,StatusDescription,PaymentCondition,PaymentConditionDescription,PaymentReference,YourRef,Journal,JournalDescription,Created,Modified",
          },
        });

        const linesPath = await client.divisionPath("salesinvoice/SalesInvoiceLines", args.division);
        const lines = await client.getAll(linesPath, {
          $filter: `InvoiceID eq guid'${invoice_id}'`,
          $select:
            "ID,LineNumber,Item,ItemCode,ItemDescription,Description,Quantity,UnitCode,UnitPrice,AmountDC,VATAmountDC,VATCode,VATPercentage,GLAccount,Discount",
          $orderby: "LineNumber",
        });

        return okJson({ invoice, lines });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_create_sales_invoice",
    {
      title: "Create sales invoice",
      description:
        "CREATE a new draft sales invoice in the Exact Online accounting system. This writes real data: " +
        "it POSTs to /{division}/salesinvoice/SalesInvoices and creates a draft invoice for the given " +
        "customer. `ordered_by` is the customer account GUID; the invoice recipient (InvoiceTo) defaults " +
        "to the same account unless `invoice_to` is supplied. Provide one or more `lines`; each line may " +
        "reference an `item_id` (GUID), a free-text `description`, a `quantity` (default 1), an optional " +
        "`unit_price`, `gl_account_id` (GUID), `vat_code`, `notes` (printed below the line) and `discount` " +
        "(fraction, 0.2 = 20%). The header takes optional `remarks`. Only the fields you " +
        "provide are sent. DRY RUN BY DEFAULT: returns a preview; set dry_run=false to post. Returns the created invoice as returned by Exact.",
      inputSchema: {
        division: divisionParam,
        ordered_by: z
          .string()
          .describe(
            "Customer account GUID that ordered/is billed (OrderedBy). Also used as InvoiceTo unless invoice_to is given."
          ),
        invoice_to: z
          .string()
          .optional()
          .describe(
            "Optional invoice recipient account GUID (InvoiceTo). Defaults to ordered_by when omitted."
          ),
        description: z
          .string()
          .optional()
          .describe("Optional invoice header description."),
        your_ref: z
          .string()
          .optional()
          .describe("Optional customer reference (YourRef)."),
        remarks: z
          .string()
          .optional()
          .describe("Optional header remarks (Remarks), printed on the invoice."),
        invoice_date: z
          .string()
          .optional()
          .describe(
            "Optional invoice date as an ISO 8601 string (InvoiceDate). Sent to Exact as-is."
          ),
        lines: z
          .array(
            z.object({
              item_id: guid
                .optional()
                .describe("Item GUID for this line (Item)."),
              description: z
                .string()
                .optional()
                .describe("Free-text line description (Description)."),
              quantity: z
                .number()
                .optional()
                .describe("Quantity for this line (Quantity). Defaults to 1."),
              unit_price: z
                .number()
                .optional()
                .describe("Unit price for this line (UnitPrice)."),
              gl_account_id: guid
                .optional()
                .describe("General ledger account GUID for this line (GLAccount)."),
              vat_code: z
                .string()
                .optional()
                .describe("VAT code for this line (VATCode)."),
              notes: z
                .string()
                .optional()
                .describe("Line notes (Notes), printed below the line."),
              discount: z
                .number()
                .optional()
                .describe(
                  "Line discount as a fraction (Discount), e.g. 0.2 for 20%."
                ),
            })
          )
          .describe("One or more invoice lines to create."),
        dry_run: dryRunParam,
      },
    },
    async (args) => {
      try {
        const {
          ordered_by,
          invoice_to,
          description,
          your_ref,
          invoice_date,
          lines,
        } = args;

        const salesInvoiceLines = lines.map((line) => {
          const out: Record<string, unknown> = {
            Quantity: line.quantity ?? 1,
          };
          if (line.item_id !== undefined) out.Item = line.item_id;
          if (line.description !== undefined) out.Description = line.description;
          if (line.unit_price !== undefined) out.UnitPrice = line.unit_price;
          if (line.gl_account_id !== undefined) out.GLAccount = line.gl_account_id;
          if (line.vat_code !== undefined) out.VATCode = line.vat_code;
          if (line.notes !== undefined) out.Notes = line.notes;
          if (line.discount !== undefined) out.Discount = line.discount;
          return out;
        });

        const body: Record<string, unknown> = {
          OrderedBy: ordered_by,
          InvoiceTo: invoice_to ?? ordered_by,
          SalesInvoiceLines: salesInvoiceLines,
        };
        if (description !== undefined) body.Description = description;
        if (your_ref !== undefined) body.YourRef = your_ref;
        if (args.remarks !== undefined) body.Remarks = args.remarks;
        if (invoice_date !== undefined) body.InvoiceDate = invoice_date;

        if (args.dry_run !== false) {
          return okJson({
            dry_run: true,
            would_post_to: "salesinvoice/SalesInvoices",
            body,
            note: "Set dry_run=false to create this draft invoice.",
          });
        }
        audit(
          "exact_create_sales_invoice",
          args.division,
          `invoice for ${ordered_by}, ${lines.length} lines`
        );
        const path = await client.divisionPath("salesinvoice/SalesInvoices", args.division);
        const created = await client.request("POST", path, { body });
        return okJson(created);
      } catch (e) {
        return errText(e);
      }
    }
  );

  // --- Sales orders -------------------------------------------------------

  server.registerTool(
    "exact_list_sales_orders",
    {
      title: "List sales orders",
      description:
        "List sales orders from Exact Online, most recent first. Backed by GET " +
        "/{division}/salesorder/SalesOrders. All filters are optional and combined with AND: " +
        "`date_from`/`date_to` bound OrderDate (inclusive, ISO 8601), `customer_id` filters on the " +
        "ordering account (OrderedBy, a GUID), and `status` filters on the Exact order status code " +
        "(common values: 12=open, 20=partial, 21=complete, 45=cancelled). Use `top` to cap the number " +
        "of rows (default 50, max 500). Returns key fields per order including totals and status.",
      inputSchema: {
        division: divisionParam,
        date_from: z
          .string()
          .optional()
          .describe(
            "Only orders with OrderDate on or after this ISO 8601 date/time (inclusive)."
          ),
        date_to: z
          .string()
          .optional()
          .describe(
            "Only orders with OrderDate on or before this ISO 8601 date/time (inclusive)."
          ),
        customer_id: guid
          .optional()
          .describe("Filter on the ordering account GUID (OrderedBy)."),
        status: z
          .number()
          .int()
          .optional()
          .describe(
            "Exact order status code to filter on (Status). Common values: 12=open, 20=partial, 21=complete, 45=cancelled."
          ),
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
        const { date_from, date_to, customer_id, status, top } = args;
        const filters: string[] = [];
        if (date_from) filters.push(`OrderDate ge ${toExactDate(date_from)}`);
        if (date_to) filters.push(`OrderDate le ${toExactDate(date_to)}`);
        if (customer_id) filters.push(`OrderedBy eq guid'${customer_id}'`);
        if (status !== undefined) filters.push(`Status eq ${status}`);

        const max = top ?? 50;
        const path = await client.divisionPath("salesorder/SalesOrders", args.division);
        const result = await client.getAll(
          path,
          {
            $filter: filters.length ? filters.join(" and ") : undefined,
            $select:
              "OrderID,OrderNumber,OrderDate,OrderedBy,OrderedByName,DeliverTo,DeliverToName,Description,AmountDC,Currency,Status,StatusDescription,YourRef",
            $orderby: "OrderDate desc",
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
    "exact_get_sales_order",
    {
      title: "Get sales order",
      description:
        "Fetch a single sales order with its header and all order lines. Backed by GET " +
        "/{division}/salesorder/SalesOrders(guid'{id}') for the header and GET " +
        "/{division}/salesorder/SalesOrderLines filtered on OrderID for the lines. " +
        "Returns an object { order, lines } where `order` is the header and `lines` is the array of " +
        "line items (item, description, quantity, unit price, amounts, discount).",
      inputSchema: {
        division: divisionParam,
        order_id: guid
          .describe("The sales order GUID (OrderID) to retrieve."),
      },
    },
    async (args) => {
      try {
        const { order_id } = args;
        const orderPath = await client.divisionPath(`salesorder/SalesOrders(guid'${order_id}')`, args.division);
        const order = await client.request("GET", orderPath, {
          params: {
            $select:
              "OrderID,OrderNumber,OrderDate,OrderedBy,OrderedByName,DeliverTo,DeliverToName,InvoiceTo,InvoiceToName,Description,AmountDC,AmountFC,Currency,Status,StatusDescription,DeliveryStatus,DeliveryStatusDescription,YourRef,Created,Modified",
          },
        });

        const linesPath = await client.divisionPath("salesorder/SalesOrderLines", args.division);
        const lines = await client.getAll(linesPath, {
          $filter: `OrderID eq guid'${order_id}'`,
          $select:
            "ID,LineNumber,Item,ItemCode,ItemDescription,Description,Quantity,UnitCode,UnitPrice,AmountDC,VATAmount,Discount",
          $orderby: "LineNumber",
        });

        return okJson({ order, lines });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_update_sales_invoice",
    {
      title: "Update sales invoice (draft)",
      description:
        "UPDATE the header of an existing DRAFT (unprocessed) sales invoice via PUT " +
        "/{division}/salesinvoice/SalesInvoices(guid'{id}'). Only the fields you provide " +
        "are changed. Processed invoices cannot be changed — Exact will refuse. DRY RUN " +
        "BY DEFAULT: returns a preview; set dry_run=false to apply. Exact returns no " +
        "content on success; re-read with exact_get_sales_invoice to confirm.",
      inputSchema: {
        division: divisionParam,
        id: guid.describe("GUID of the draft invoice (InvoiceID)."),
        description: z
          .string()
          .optional()
          .describe("New header description (e.g. the month)."),
        your_ref: z.string().optional().describe("New customer reference (YourRef)."),
        remarks: z.string().optional().describe("New header remarks (Remarks)."),
        invoice_date: z
          .string()
          .optional()
          .describe("New invoice date as ISO date (InvoiceDate)."),
        due_date: z
          .string()
          .optional()
          .describe("New due date as ISO date (DueDate)."),
        dry_run: dryRunParam,
      },
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {};
        if (args.description !== undefined) body.Description = args.description;
        if (args.your_ref !== undefined) body.YourRef = args.your_ref;
        if (args.remarks !== undefined) body.Remarks = args.remarks;
        if (args.invoice_date !== undefined) body.InvoiceDate = args.invoice_date;
        if (args.due_date !== undefined) body.DueDate = args.due_date;
        if (Object.keys(body).length === 0) {
          throw new Error("Nothing to update: provide at least one field.");
        }
        if (args.dry_run !== false) {
          return okJson({
            dry_run: true,
            would_put_to: `salesinvoice/SalesInvoices(guid'${args.id}')`,
            body,
            note: "Set dry_run=false to apply this update (draft invoices only).",
          });
        }
        audit("exact_update_sales_invoice", args.division, `invoice ${args.id}`);
        const path = await client.divisionPath(
          `salesinvoice/SalesInvoices(guid'${args.id}')`,
          args.division
        );
        const result = await client.request<unknown>("PUT", path, { body });
        if (result === undefined) {
          return okJson({
            success: true,
            id: args.id,
            message: "Invoice updated (Exact returned no content).",
          });
        }
        return okJson(result);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.registerTool(
    "exact_update_sales_invoice_line",
    {
      title: "Update sales invoice line (draft)",
      description:
        "UPDATE one line of a DRAFT (unprocessed) sales invoice via PUT " +
        "/{division}/salesinvoice/SalesInvoiceLines(guid'{id}'). `id` is the LINE GUID " +
        "(the ID on each line from exact_get_sales_invoice, not the invoice ID). Only the " +
        "fields you provide are changed. DRY RUN BY DEFAULT: returns a preview; set " +
        "dry_run=false to apply. Re-read the invoice afterwards to confirm.",
      inputSchema: {
        division: divisionParam,
        id: guid.describe("GUID of the invoice LINE to update."),
        description: z.string().optional().describe("New line description."),
        quantity: z.number().optional().describe("New quantity (Quantity)."),
        unit_price: z.number().optional().describe("New unit price (UnitPrice)."),
        discount: z
          .number()
          .optional()
          .describe("New discount as a fraction (Discount), e.g. 0.2 for 20%."),
        notes: z.string().optional().describe("New line notes (Notes)."),
        vat_code: z.string().optional().describe("New VAT code (VATCode)."),
        dry_run: dryRunParam,
      },
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {};
        if (args.description !== undefined) body.Description = args.description;
        if (args.quantity !== undefined) body.Quantity = args.quantity;
        if (args.unit_price !== undefined) body.UnitPrice = args.unit_price;
        if (args.discount !== undefined) body.Discount = args.discount;
        if (args.notes !== undefined) body.Notes = args.notes;
        if (args.vat_code !== undefined) body.VATCode = args.vat_code;
        if (Object.keys(body).length === 0) {
          throw new Error("Nothing to update: provide at least one field.");
        }
        if (args.dry_run !== false) {
          return okJson({
            dry_run: true,
            would_put_to: `salesinvoice/SalesInvoiceLines(guid'${args.id}')`,
            body,
            note: "Set dry_run=false to apply this update (draft invoices only).",
          });
        }
        audit(
          "exact_update_sales_invoice_line",
          args.division,
          `invoice line ${args.id}`
        );
        const path = await client.divisionPath(
          `salesinvoice/SalesInvoiceLines(guid'${args.id}')`,
          args.division
        );
        const result = await client.request<unknown>("PUT", path, { body });
        if (result === undefined) {
          return okJson({
            success: true,
            id: args.id,
            message: "Invoice line updated (Exact returned no content).",
          });
        }
        return okJson(result);
      } catch (e) {
        return errText(e);
      }
    }
  );
}
