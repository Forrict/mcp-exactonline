# Exact Online MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for [Exact Online](https://www.exact.com), the cloud accounting platform. It lets MCP clients such as Claude Desktop and Claude Code read and manage CRM accounts, sales & purchase invoices, financial transactions, items, and more through the Exact Online REST API.

## Features

- **OAuth2** with automatic token refresh — correctly handles Exact's ~10-minute access tokens and **single-use refresh tokens** (each new refresh token is persisted before use, refreshes are serialized to avoid races)
- **Multi-region**: NL, BE, UK, DE, FR, ES, US
- **Pagination** via `__next` links, **rate-limit aware** (honors `Retry-After` on 429), retries on transient 5xx
- Normalizes Exact's legacy `/Date(ms)/` values to ISO 8601
- A generic OData query tool as an escape hatch for any endpoint not covered by a dedicated tool

## Tools

| Module | Tools |
|---|---|
| System | `exact_get_current_user`, `exact_list_divisions`, `exact_odata_query` (generic escape hatch for any Exact REST resource) |
| CRM | `exact_list_accounts`, `exact_get_account`, `exact_create_account`, `exact_update_account`, `exact_list_contacts`, `exact_create_contact` |
| Financial | `exact_list_gl_accounts`, `exact_list_journals`, `exact_list_transaction_lines`, `exact_get_receivables`, `exact_get_payables`, `exact_get_aging_receivables`, `exact_get_financial_periods` |
| Sales | `exact_list_sales_invoices`, `exact_get_sales_invoice`, `exact_create_sales_invoice`, `exact_list_sales_orders`, `exact_get_sales_order` |
| Purchase | `exact_list_purchase_entries`, `exact_get_purchase_entry`, `exact_list_purchase_orders` |
| Logistics | `exact_list_items`, `exact_get_item`, `exact_list_sales_item_prices`, `exact_list_stock_positions` |

Tools that create or modify data (`exact_create_*`, `exact_update_*`) say so explicitly in their descriptions so the client can ask for confirmation.

## Setup

### 1. Register an Exact Online app

1. Go to the [Exact App Center](https://apps.exactonline.com) → *Manage my apps* → *Register API keys* and create an app for your account.
2. Set the **redirect URI** to `http://localhost:8123/callback` (or your own — must match `EXACT_REDIRECT_URI`).
3. Note the **Client ID** and **Client Secret**.

### 2. Configure

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `EXACT_CLIENT_ID` | ✅ | OAuth client ID from the App Center |
| `EXACT_CLIENT_SECRET` | ✅ | OAuth client secret |
| `EXACT_REGION` | | `nl` (default), `be`, `uk`, `de`, `fr`, `es`, `us` |
| `EXACT_DIVISION` | | Division (administration) code; defaults to your current division |
| `EXACT_REDIRECT_URI` | | Default `http://localhost:8123/callback` |
| `EXACT_TOKEN_STORE` | | Token file path, default `~/.mcp-exactonline/tokens.json` |
| `EXACT_REFRESH_TOKEN` | | Optional bootstrap refresh token (instead of running the login flow) |

### 3. Build & authenticate (one-time)

```bash
npm install
npm run build
npm run auth   # prints an authorization URL; open it, log in, and approve
```

The tokens are stored in the token store file (mode 0600) and refreshed automatically from then on.

### 4. Add to your MCP client

Claude Desktop (`claude_desktop_config.json`) or any MCP client:

```json
{
  "mcpServers": {
    "exact-online": {
      "command": "node",
      "args": ["/path/to/mcp-exactonline/dist/index.js"],
      "env": {
        "EXACT_CLIENT_ID": "...",
        "EXACT_CLIENT_SECRET": "...",
        "EXACT_REGION": "nl"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add exact-online -e EXACT_CLIENT_ID=... -e EXACT_CLIENT_SECRET=... -- node /path/to/mcp-exactonline/dist/index.js
```

## Usage examples

Once connected, ask your MCP client things like:

- *"Which customers still owe us money, and how overdue are they?"* → `exact_get_receivables` / `exact_get_aging_receivables`
- *"List sales invoices from last month over €1000"* → `exact_list_sales_invoices`
- *"Create a customer account for Acme BV with email billing@acme.nl"* → `exact_create_account`
- *"What's the current stock of item X?"* → `exact_list_stock_positions`
- *"Query the ledger for account 8000 in Q1"* → `exact_list_transaction_lines`
- Anything else via `exact_odata_query` (e.g. resource `project/Projects`)

## Notes & limitations

- Exact Online rate-limits per app per company (minutely + daily). The server retries once on 429 honoring `Retry-After`; heavy bulk extraction is out of scope.
- List tools cap results (default 50–100, max 500 per call) and report when results are truncated.
- Write support is intentionally limited to common cases (accounts, contacts, draft sales invoices). Use the Exact Online UI for anything involving posting/finalizing entries.
- The OData dialect is v3-style: `$filter=substringof('x',Name) eq true`, `guid'...'` and `datetime'...'` literals.

## Development

```bash
npm run dev    # run from source with tsx
npm run build  # compile to dist/
```

Project layout:

```
src/
├── index.ts          # entrypoint (stdio transport)
├── server.ts         # MCP server + tool registration
├── config.ts         # env config, region base URLs
├── client.ts         # ExactClient: auth'd requests, pagination, OData, dates
├── auth/             # OAuth2 refresh, token store, CLI login flow
└── tools/            # tool modules (system, crm, financial, sales, purchase, logistics)
```
