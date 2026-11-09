# Security policy

This project talks to a live accounting system and, in the Lambda deployment, runs a small OAuth 2.1 authorization server on the public internet. Security reports are welcome.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). You should get a first response within a week.

Include what you found, how to reproduce it, and the impact you see. A proof of concept against your own Exact Online test administration is fine; please do not test against administrations you do not own.

## Scope

- The MCP server (`src/`), including the OAuth server and token handling.
- The CDK stack in `infra/`.

Out of scope: the Exact Online API itself, Claude's MCP client, and issues that require a compromised AWS account or host.

## Known design limits

These are documented trade-offs of the stateless, single-user Lambda design, not unreported bugs:

- Issued tokens are HMAC-signed and stateless. They can only be revoked all at once by rotating `SIGNING_KEY` in the secret.
- An authorization code can be redeemed more than once within its 5-minute lifetime; redemption still requires the OAuth client secret and the PKCE verifier.
- There is no rate limiting on the public endpoints beyond the CloudWatch alarms. Put a WAF or API Gateway in front if you need it.
- All tool calls run under the single Exact Online user whose tokens are stored. Anyone who can call the MCP endpoint has that user's Exact rights; use `readOnly=true` where that is too much.

## Supported versions

Only the latest release on `main` receives fixes.
