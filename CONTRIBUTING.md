# Contributing

Thanks for your interest. Small, focused pull requests are easiest to review.

## Development

```bash
npm install
npm run dev        # run from source over stdio (needs EXACT_* env vars, see .env.example)
npm run typecheck  # src/, infra/ and tests/
npm test           # unit tests (node:test via tsx, no Exact account needed)
npm run build
```

Node.js 22 or newer is required (CI runs 22 and 24; the Lambda runs on 22).

The project compiles with TypeScript 7, the native compiler. Its npm package ships only `tsc`, no `tsserver`, so editors cannot use the workspace TypeScript version for language features. In VS Code install Microsoft's native TypeScript extension ("TypeScript (Native Preview)") or let the editor use its own bundled TypeScript; type errors are authoritative from `npm run typecheck` and CI either way.

## Guidelines

- **Never commit credentials or real data.** No client secrets, tokens, division codes, customer names or administration names, not even in examples or tests. Use obviously fake placeholders.
- **Tool inputs are untrusted.** Validate anything that ends up in an OData path or `$filter` (use `guid` and `odataString` from `src/tools/helpers.ts`).
- **Write tools** must match `/^exact_(create|update)_/`, default to `dry_run: true`, create drafts only, and call `audit()` with identifiers, never names.
- **Logs must never contain tokens, query strings, request bodies or personal data.**
- Keep the README's tool table in sync when adding or renaming tools, and add a line to `CHANGELOG.md`.

## Licensing of contributions

The project is licensed under the [PolyForm Small Business License 1.0.0](LICENSE), and Forrict B.V. also offers it under other terms to organisations that fall outside that license. To keep that possible, every contribution is accepted on these terms:

- You confirm that you wrote the contribution yourself, or otherwise have the right to submit it under these terms.
- You license your contribution to Forrict B.V. and to all recipients under the PolyForm Small Business License 1.0.0.
- You additionally grant Forrict B.V. a perpetual, worldwide, irrevocable, royalty-free right to use, modify, distribute, sublicense and relicense your contribution under any other terms, including commercial licenses.

Opening a pull request means you agree to these terms for its contents. No separate contributor agreement is needed.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please do not open public issues for vulnerabilities.
