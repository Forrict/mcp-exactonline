# Exact Online MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for [Exact Online](https://www.exact.com), the cloud accounting platform. It lets MCP clients such as Claude Desktop and Claude Code read and manage CRM accounts, sales & purchase invoices, financial transactions, items, and more through the Exact Online REST API.

## Features

- **OAuth2** with automatic token refresh — correctly handles Exact's ~10-minute access tokens and **single-use refresh tokens** (each new refresh token is persisted before use, refreshes are serialized to avoid races)
- **Multi-region**: NL, BE, UK, DE, FR, ES, US
- **Pagination** via `__next` links, **rate-limit aware** (honors `Retry-After` on 429), retries on transient 5xx
- Normalizes Exact's legacy `/Date(ms)/` values to ISO 8601
- Runs locally over **stdio**, or remotely on **AWS Lambda** (Streamable HTTP) as a Claude custom connector
- Tools carry MCP annotations (read-only vs. write); an optional **read-only mode** hides all write tools
- A generic OData query tool as an escape hatch for any endpoint not covered by a dedicated tool

## Tools

| Module | Tools |
|---|---|
| System | `exact_get_current_user`, `exact_list_divisions`, `exact_odata_query` (generic escape hatch for any Exact REST resource) |
| CRM | `exact_list_accounts`, `exact_get_account`, `exact_create_account`, `exact_update_account`, `exact_list_contacts`, `exact_create_contact` |
| Financial | `exact_list_gl_accounts`, `exact_list_journals`, `exact_list_transaction_lines`, `exact_get_receivables`, `exact_get_payables`, `exact_get_aging_receivables`, `exact_get_financial_periods` |
| Reporting | `exact_get_reporting_balance` (P&L / balance sheet), `exact_list_budgets`, `exact_list_bank_entries`, `exact_list_payments`, `exact_list_vat_codes` |
| Mailbox | `exact_list_mail_messages` (digital postbox), `exact_list_mail_message_attachments` |
| Pipeline | `exact_list_quotations`, `exact_list_opportunities`, `exact_list_addresses`, `exact_list_account_bank_accounts` |
| Documents | `exact_list_documents`, `exact_list_document_attachments` |
| Cashflow+ | `exact_list_incoming_receivables`, `exact_list_direct_debit_mandates`, `exact_list_exchange_rates`, `exact_get_revenue_list`, `exact_list_assets` |
| Projects | `exact_list_projects`, `exact_list_time_transactions` |
| HR | `exact_list_employees`, `exact_list_departments`, `exact_list_leave_registrations` |
| Subscriptions | `exact_list_subscriptions`, `exact_list_subscription_lines`, `exact_list_shop_orders` |
| Insights | `exact_pl_summary`, `exact_missing_bookings`, `exact_bank_status`, `exact_inbox`, `exact_match_suggestions`, `exact_group_report` (multi-division consolidation) |
| Writes (guarded) | `exact_create_journal_entry`, `exact_create_purchase_entry`, `exact_create_match_set` — all dry-run by default, drafts only |
| Sales | `exact_list_sales_invoices`, `exact_get_sales_invoice`, `exact_create_sales_invoice`, `exact_update_sales_invoice`, `exact_update_sales_invoice_line`, `exact_list_sales_orders`, `exact_get_sales_order` |
| Purchase | `exact_list_purchase_entries`, `exact_get_purchase_entry`, `exact_list_purchase_orders` |
| Logistics | `exact_list_items`, `exact_get_item`, `exact_list_sales_item_prices`, `exact_list_stock_positions` |

Tools that create or modify data (`exact_create_*`, `exact_update_*`) say so explicitly in their descriptions so the client can ask for confirmation.

Every division-scoped tool accepts an optional `division` parameter to query a specific administration; without it the configured (`EXACT_DIVISION`) or current division is used. Use `exact_list_divisions` to discover division codes. Friendly aliases can be configured via `EXACT_DIVISION_ALIASES` (e.g. `acme=1234567,acme-holding=7654321` — as env var locally, or as a key in the Lambda secret), after which `division: "acme"` works everywhere.

Responses are compacted automatically: OData `__metadata`/`__deferred` noise and null fields are stripped, and list results include `rate_limit_minutely_remaining` so clients can pace themselves. Write tools default to `dry_run: true` (returning the exact body they would post), create drafts only, and log an audit line to the server logs (CloudWatch on Lambda).

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
| `EXACT_READ_ONLY` | | `true` hides tools that create or modify data |

### 3. Build & authenticate (one-time)

```bash
npm install
npm run build
npm run auth   # prints an authorization URL; open it, log in, and approve
```

The tokens are stored in the token store file (mode 0600) and refreshed automatically from then on.

### 4. Option A: run locally (stdio)

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

### Option B: run remotely on AWS Lambda (for Claude.ai / Claude apps)

The server can also run as a single AWS Lambda behind a public **Function URL**, so Claude connects to it over the internet as a *custom connector* — nothing runs on your own machine. The stack (AWS CDK, `infra/app.ts`) contains:

- one Node.js 22 Lambda (`src/lambda.ts`), MCP Streamable HTTP in stateless JSON mode;
- a small built-in **OAuth 2.1 authorization server** (`src/auth/oauthServer.ts`) protecting the MCP endpoint — you log in with your **Exact Online account**, and only the Exact user you configure is accepted;
- one Secrets Manager secret holding the credentials, a signing key and the Exact tokens (created by the stack; the keys are generated for you);
- a weekly EventBridge rule that refreshes the Exact token so it never expires during quiet periods;
- CloudWatch alarms for repeated auth failures, logins by a non-allowed Exact user, and function errors (optionally e-mailed to you).

Cost for a single occasional user is effectively the Secrets Manager secret (~$0.40/month); Lambda, CloudWatch alarms/metrics and SNS e-mail stay within the free tier.

#### How access is secured

1. Claude calls `/mcp` without a token, gets `401` and discovers the OAuth endpoints (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`).
2. Claude sends you to `/authorize`, which forwards you to the **Exact Online login** (including your Exact 2FA).
3. After login the function checks the Exact user against `ALLOWED_EXACT_USER`. Anyone else gets `403` and nothing is stored. For you, the Exact tokens are saved (this also (re)connects the server to Exact) and Claude receives an authorization code.
4. Claude exchanges the code (client secret + PKCE S256) for a 1-hour access token and a 30-day refresh token.

Hardening details: only one pre-registered client; only Claude's redirect URIs (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`) and loopback URIs (Claude Code) are accepted; tokens are bound to type, client and audience (the `/mcp` URL). Tokens are stateless HMAC-signed values — **change `SIGNING_KEY` in the secret to revoke every issued token** (effective on the next cold start; redeploy to force it). This does not change the OAuth client credentials. Known limit of the stateless design: an authorization code can be redeemed more than once within its 5-minute lifetime, which still requires the client secret and the PKCE verifier.

#### Deploy

You never have to make up keys yourself: CloudFormation generates `SIGNING_KEY`, and right after the deploy the function fills in `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` (derived from the signing key, stored once). You only add the Exact values.

**1. Deploy** (pick your region, e.g. `eu-west-1`):

```bash
npm install
npx cdk bootstrap        # once per account/region
npx cdk deploy -c alarmEmail=you@example.com   # other options: -c exactRegion=nl -c exactDivision=123456 -c readOnly=true
```

Confirm the SNS subscription e-mail to receive alarms. Outputs:
- `FunctionUrl`, e.g. `https://abc123.lambda-url.eu-west-1.on.aws/`
- `SecretConsoleUrl`, a link to the secret in the AWS console

**2. Register an app in the Exact App Center** with redirect URI `<FunctionUrl>oauth/callback`. (Local `npm run auth` uses the localhost redirect URI; use a separate Exact app if you need both.)

**3. Fill in the secret** via `SecretConsoleUrl` → *Retrieve secret value* → *Edit*:

| Key | Value |
|---|---|
| `EXACT_CLIENT_ID`, `EXACT_CLIENT_SECRET` | from the Exact App Center |
| `ALLOWED_EXACT_USER` | your Exact login name (UserName) or UserID; if unsure, leave empty — the first login is rejected and shows the value to use |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | already filled in: copy them for step 4 |
| `SIGNING_KEY`, `tokens` | leave as is (managed automatically) |

**4. Add the connector in Claude** (Customize → Connectors → *Add custom connector*): URL `<FunctionUrl>mcp`, and under *Advanced settings* the OAuth Client ID and Client Secret from the secret. Click *Connect* and log in with Exact Online.

For Claude Code:

```bash
claude mcp add --transport http --client-id <OAUTH_CLIENT_ID> --client-secret --callback-port 8080 \
  exact-online <FunctionUrl>mcp
```

Use `-c readOnly=true` if Claude should never create or change data. The function never logs query strings, bodies or tokens.

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
npm run typecheck  # typecheck src/ and infra/
```

Project layout:

```
src/
├── index.ts          # entrypoint (stdio transport)
├── lambda.ts         # entrypoint (AWS Lambda Function URL, Streamable HTTP)
├── server.ts         # MCP server + tool registration
├── config.ts         # env config, region base URLs
├── client.ts         # ExactClient: auth'd requests, pagination, OData, dates
├── auth/             # Exact OAuth2 refresh, token stores, CLI login, OAuth server for Claude
└── tools/            # tool modules (system, crm, financial, reporting, mailbox, sales, purchase, logistics)
infra/app.ts          # AWS CDK stack for the Lambda deployment
```
