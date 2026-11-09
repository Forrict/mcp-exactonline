# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security
- Every GUID parameter is validated before it is interpolated into OData paths and `$filter` expressions.
- `exact_odata_query` only accepts plain resource paths (optionally with a `(guid'...')` key), so it cannot escape the `/{division}/` prefix.
- The query string of a request is no longer logged when a list comes back empty; filters may contain customer names.
- Audit lines for `exact_create_account` no longer contain the customer name.
- Dependencies updated: `@modelcontextprotocol/sdk` 1.32, `zod` 4, AWS SDK and CDK; `npm audit --omit=dev` is clean.

### Changed
- TypeScript 7 (the native compiler). `tsconfig.json` now lists `types: ["node"]` explicitly, since TypeScript 7 no longer picks up `@types/*` packages automatically. `@types/node` stays on the 22 line to match the Lambda runtime; Dependabot ignores its major updates.
- Node.js 20 or newer is required (Node 18 is end-of-life).
- OData string escaping lives in one helper (`odataString`) instead of being copied per module.
- Examples in docs and comments use neutral placeholders instead of a real administration.

### Removed
- Internal planning document (`docs/`); it was not meant for publication.

### Added
- README rewritten as a step-by-step rollout guide (Exact App Center, local and Lambda deployment, troubleshooting).
- PolyForm Small Business License 1.0.0, security policy, contributing guide, CI workflow (typecheck, build, tests, audit) and Dependabot configuration.
- Unit tests for the signed-token helpers, the OAuth server flow, date normalization and input validation.

## [0.1.0]

Initial version: 63 tools over stdio or AWS Lambda, OAuth 2.1 front door for Claude, dry-run write tools, dynamic division resolution.
