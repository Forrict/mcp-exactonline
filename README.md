# MCP Server for Exact Online

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

Every division-scoped tool accepts an optional `division` parameter to query a specific administration; without it the configured (`EXACT_DIVISION`) or current division is used. Besides a numeric code you can pass a division *name*: names are fetched once from `system/Divisions` (cached per instance) and matched case-insensitively, including unique partial matches — so `division: "acme"` just works when one administration is called "Acme Holding B.V.". Manual overrides remain possible via `EXACT_DIVISION_ALIASES` (e.g. `acme=1234567`), which take precedence.

Responses are compacted automatically: OData `__metadata`/`__deferred` noise and null fields are stripped, and list results include `rate_limit_minutely_remaining` so clients can pace themselves. Write tools default to `dry_run: true` (returning the exact body they would post), create drafts only, and log an audit line to the server logs (CloudWatch on Lambda).

## Getting started

There are two ways to run the server. Pick one (or both, with two separate Exact apps):

| | Option A: local (stdio) | Option B: AWS Lambda (remote) |
|---|---|---|
| Works with | Claude Desktop, Claude Code, any stdio MCP client | Claude.ai (web), Claude mobile/desktop apps as a *custom connector*, Claude Code over HTTP |
| Runs on | your own machine | one Lambda function in your AWS account |
| Who can use it | whoever runs the process | the single Exact Online user you allow |
| Needs | Node.js 22+ | Node.js 22+, an AWS account and the AWS CLI |

Both options start with an Exact Online app registration.

### Prerequisites

- An **Exact Online** login with access to the administration(s) you want to query. Your Exact subscription must allow API access (most business editions do; if the App Center does not let you register an app, ask your Exact reseller).
- **Node.js 22 or newer** and npm. (Node 22 is the runtime the Lambda deployment uses; CI tests 22 and 24.)
- For option B: an **AWS account** with credentials configured for the AWS CLI (`aws sts get-caller-identity` should work) and permission to deploy CloudFormation stacks.

### Step 1: Register an app in the Exact App Center

Exact only talks to registered OAuth apps. You register your own, so no third party ever sees your data.

1. Go to the [Exact App Center](https://apps.exactonline.com) and log in with your Exact Online account.
2. Open **Manage my apps** and choose **Register API keys** (sometimes shown as "Register a new app" or "Test app"). A test app is enough: it can be used by users of your own Exact account.
3. Fill in:
   - **App name**: anything, e.g. `Claude MCP`.
   - **Redirect URI**: depends on the option you choose:
     - Option A (local): `http://localhost:8123/callback`
     - Option B (Lambda): `<FunctionUrl>oauth/callback`, which you only know **after** the first deploy (see Step B.1). Register the app afterwards or come back and edit it.
   - If the form asks which **scopes** or modules the app needs, select at least Financial, CRM and Sales; add Logistics, Projects, HR, Documents and Subscriptions if you want those tools to work.
4. Save and note the **Client ID** and **Client Secret**. The secret is only shown once.

Tips:
- The redirect URI must match **exactly** (scheme, host, port, path, no trailing slash). After saving, re-open the app and check that the stored URI is complete; the field has been observed to cut off long URIs, which makes the login end in a "redirect URI mismatch" error.
- One app has one redirect URI. If you want to run both options, register two apps.
- Exact enforces API rate limits per app per administration (60 calls per minute, 5,000 per day by default). The server reports the remaining minutely budget in every list response.

### Option A: run locally (stdio)

**A.1 Install and configure**

```bash
git clone https://github.com/Forrict/mcp-exactonline.git
cd mcp-exactonline
npm install
npm run build
cp .env.example .env     # then fill in the values below
```

| Variable | Required | Description |
|---|---|---|
| `EXACT_CLIENT_ID` | ✅ | OAuth client ID from the App Center |
| `EXACT_CLIENT_SECRET` | ✅ | OAuth client secret |
| `EXACT_REGION` | | `nl` (default), `be`, `uk`, `de`, `fr`, `es`, `us`. Must match the Exact site you log in to. |
| `EXACT_DIVISION` | | Division (administration) code; defaults to your current division in Exact |
| `EXACT_REDIRECT_URI` | | Default `http://localhost:8123/callback`; must equal the URI registered in Step 1 |
| `EXACT_TOKEN_STORE` | | Token file path, default `~/.mcp-exactonline/tokens.json` |
| `EXACT_REFRESH_TOKEN` | | Optional bootstrap refresh token (instead of running the login flow) |
| `EXACT_DIVISION_ALIASES` | | Optional `name=code,...` aliases, e.g. `acme=1234567` |
| `EXACT_READ_ONLY` | | `true` hides tools that create or modify data |

**A.2 Log in to Exact once**

```bash
set -a; source .env; set +a   # or export the variables another way
npm run auth
```

This prints an authorization URL and starts a small local web server on the redirect port. Open the URL, log in to Exact Online (including 2FA), approve the app, and the browser is sent back to `localhost:8123`. The tokens are stored in the token store file (mode 0600) and refreshed automatically from then on.

Exact refresh tokens expire after 30 days without use. If you have not used the server for a month, run `npm run auth` again.

**A.3 Add the server to your MCP client**

Claude Desktop (`claude_desktop_config.json`: *Settings → Developer → Edit Config*):

```json
{
  "mcpServers": {
    "exact-online": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-exactonline/dist/index.js"],
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
claude mcp add exact-online -e EXACT_CLIENT_ID=... -e EXACT_CLIENT_SECRET=... -e EXACT_REGION=nl -- node /absolute/path/to/mcp-exactonline/dist/index.js
```

The client must run under the same OS user that ran `npm run auth` (or set `EXACT_TOKEN_STORE` to the same file), because that is where the tokens live. Add `EXACT_READ_ONLY=true` if the client should never be able to create or change data.

**A.4 Verify**

Restart the client and ask *"Which Exact Online user am I, and which administrations can I see?"*. The client should call `exact_get_current_user` and `exact_list_divisions`.

### Option B: run on AWS Lambda (for Claude.ai and the Claude apps)

The server runs as a single AWS Lambda behind a public **Function URL**, so Claude connects to it over the internet as a *custom connector*. Nothing runs on your own machine. The CDK stack (`infra/app.ts`) creates:

- one Node.js 22 Lambda (`src/lambda.ts`), MCP Streamable HTTP in stateless JSON mode;
- a small built-in **OAuth 2.1 authorization server** (`src/auth/oauthServer.ts`) protecting the MCP endpoint. You log in with your **Exact Online account**, and only the Exact user you configure is accepted;
- one Secrets Manager secret holding the credentials, a signing key and the Exact tokens (created by the stack; the keys are generated for you);
- a weekly EventBridge rule that refreshes the Exact token so it never expires during quiet periods;
- CloudWatch alarms for repeated auth failures, logins by a non-allowed Exact user, and function errors (optionally e-mailed to you).

Cost for a single occasional user is effectively the Secrets Manager secret (about $0.40/month); Lambda, CloudWatch and SNS stay within the free tier.

#### How access is secured

1. Claude calls `/mcp` without a token, gets `401` and discovers the OAuth endpoints (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`).
2. Claude sends you to `/authorize`, which forwards you to the **Exact Online login** (including your Exact 2FA).
3. After login the function checks the Exact user against `ALLOWED_EXACT_USER`. Anyone else gets `403` and nothing is stored. For you, the Exact tokens are saved (this also (re)connects the server to Exact) and Claude receives an authorization code.
4. Claude exchanges the code (client secret + PKCE S256) for a 1-hour access token and a 30-day refresh token.

Hardening details: only one pre-registered client; only Claude's redirect URIs (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`) and loopback URIs (Claude Code) are accepted; tokens are bound to type, client and audience (the `/mcp` URL). Tokens are stateless HMAC-signed values: **change `SIGNING_KEY` in the secret to revoke every issued token** (effective on the next cold start; redeploy to force it). This does not change the OAuth client credentials. Known limit of the stateless design: an authorization code can be redeemed more than once within its 5-minute lifetime, which still requires the client secret and the PKCE verifier. See [SECURITY.md](SECURITY.md).

#### B.1 Deploy the stack

You never have to make up keys yourself: CloudFormation generates `SIGNING_KEY`, and right after the deploy the function fills in `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`. You only add the Exact values.

```bash
git clone https://github.com/Forrict/mcp-exactonline.git
cd mcp-exactonline
npm install
export AWS_REGION=eu-west-1        # any region; EU regions keep the data in the EU
npx cdk bootstrap                  # once per AWS account + region
npx cdk deploy -c alarmEmail=you@example.com
```

Optional context flags: `-c exactRegion=nl` (default `nl`), `-c exactDivision=1234567` (pin one administration), `-c readOnly=true` (never register write tools).

Confirm the SNS subscription e-mail to receive alarms. The deploy prints two outputs:
- `FunctionUrl`, e.g. `https://abc123.lambda-url.eu-west-1.on.aws/`
- `SecretConsoleUrl`, a link to the secret in the AWS console

#### B.2 Register (or update) the Exact app

In the Exact App Center (Step 1), set the redirect URI of your app to `<FunctionUrl>oauth/callback`, for example `https://abc123.lambda-url.eu-west-1.on.aws/oauth/callback`. Check that the saved value is complete. If you also run option A, use a separate app for Lambda.

#### B.3 Fill in the secret

Open `SecretConsoleUrl` → *Retrieve secret value* → *Edit*:

| Key | Value |
|---|---|
| `EXACT_CLIENT_ID`, `EXACT_CLIENT_SECRET` | from the Exact App Center |
| `ALLOWED_EXACT_USER` | your Exact login name (UserName) or UserID. If unsure, leave empty: the first login is rejected and the page shows the value to use |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | already filled in: copy them for step B.4 |
| `EXACT_DIVISION_ALIASES` | optional, e.g. `acme=1234567,acme-holding=7654321` |
| `SIGNING_KEY`, `tokens` | leave as is (managed automatically) |

Changes to the secret are picked up without a redeploy (`ALLOWED_EXACT_USER` immediately, the rest on the next cold start).

#### B.4 Connect Claude

Claude.ai / Claude apps: *Settings → Connectors → Add custom connector*. URL: `<FunctionUrl>mcp`. Under *Advanced settings* enter the OAuth Client ID and Client Secret from the secret. Click *Connect*, log in with Exact Online and approve. If the login page says your Exact user is not allowed, copy the shown UserName into `ALLOWED_EXACT_USER` and connect again.

Claude Code:

```bash
claude mcp add --transport http --client-id <OAUTH_CLIENT_ID> --client-secret --callback-port 8080 \
  exact-online <FunctionUrl>mcp
```

#### B.5 Verify, update, remove

- **Verify**: ask Claude *"Which Exact Online user am I?"*. In the AWS console the function's CloudWatch log group shows a line per Exact API call (remaining rate-limit budget) and an audit line per write; it never contains query strings, bodies or tokens.
- **Update** to a newer version: `git pull && npm install && npx cdk deploy`. The secret and its tokens are kept.
- **Revoke access**: change `SIGNING_KEY` in the secret to invalidate every issued Claude token, or clear `tokens` to disconnect from Exact. Reconnecting in Claude restores both.
- **Remove everything**: `npx cdk destroy`. Afterwards delete the app in the Exact App Center as well.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Exact login ends in a *redirect URI mismatch* | The URI in the App Center differs from `EXACT_REDIRECT_URI` (option A) or `<FunctionUrl>oauth/callback` (option B). Compare character by character; check for truncation. |
| `invalid_grant` when refreshing | The refresh token was used twice (two server instances sharing one token file), expired after 30 days, or revoked. Run `npm run auth` again, or reconnect the connector in Claude. |
| `Rate limit exceeded: access_token not expired` | Harmless: Exact refuses to refresh while the token is still valid. The server handles it and keeps using the current token. |
| `Exact API error 401/403` on one endpoint | Your Exact user or the app lacks rights for that module. Check the user's role in Exact and the app's scopes. |
| `0 rows returned` warning | The filter matched nothing, the user cannot see that data, or the endpoint is not in your subscription. Try `exact_odata_query` without a filter. |
| `This Exact Online user is not allowed` (option B) | Set `ALLOWED_EXACT_USER` in the secret to the UserName or UserID shown on that page. |
| `Server misconfigured` (option B) | A required key in the secret is missing or too short. See the function logs in CloudWatch. |

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
npm run dev        # run from source with tsx
npm run build      # compile to dist/
npm run typecheck  # typecheck src/, infra/ and tests/
npm test           # unit tests (node:test); no Exact account needed
```

CI runs typecheck, tests, build and `npm audit --omit=dev` on every pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules (no real credentials or administration data in the repo, validate every tool input that reaches OData, never log personal data).

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

## Security

Vulnerabilities can be reported privately via GitHub's "Report a vulnerability" on this repository; see [SECURITY.md](SECURITY.md) for scope and the known limits of the stateless token design.

## License

This project is licensed under the [PolyForm Small Business License 1.0.0](LICENSE) (SPDX: `PolyForm-Small-Business-1.0.0`). The source is public, and you may use, change and distribute it for the benefit of your company if that company has fewer than 100 people working for it (employees and contractors) and less than 1,000,000 USD (2019, inflation-adjusted) revenue in the prior tax year. Personal, non-commercial, educational and evaluation use is covered as well.

Anyone who passes the software on must include the license (or its URL) and this line:

```
Required Notice: Copyright Forrict B.V. (https://forrict.nl)
```

Organisations above the small-business threshold, and anyone who needs different terms, can contact [info@forrict.nl](mailto:info@forrict.nl) for a commercial license.

This is a source-available license, not an open-source license as defined by the OSI.
