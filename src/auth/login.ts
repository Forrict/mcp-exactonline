#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { loadConfig, type Config } from "../config.js";
import { buildAuthorizationUrl, exchangeCode } from "./oauth.js";
import { saveTokens } from "./tokenStore.js";

function htmlResponse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">${message}</body></html>`
  );
}

/** Parse the callback port and path from the configured redirect URI. */
function parseRedirect(config: Config): { port: number; pathname: string } {
  const url = new URL(config.redirectUri);
  const port = url.port ? Number(url.port) : 8123;
  return { port, pathname: url.pathname || "/callback" };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { port, pathname } = parseRedirect(config);
  const authUrl = buildAuthorizationUrl(config);

  const code = await new Promise<string>((resolvePromise, rejectPromise) => {
    const server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        if (!req.url) {
          htmlResponse(res, 400, "Bad request.");
          return;
        }
        const reqUrl = new URL(req.url, `http://localhost:${port}`);
        if (reqUrl.pathname !== pathname) {
          htmlResponse(res, 404, "Not found.");
          return;
        }

        const error = reqUrl.searchParams.get("error");
        if (error) {
          const desc = reqUrl.searchParams.get("error_description") ?? "";
          htmlResponse(
            res,
            400,
            `<h2>Authorization failed</h2><p>${error} ${desc}</p>`
          );
          server.close();
          rejectPromise(new Error(`Authorization failed: ${error} ${desc}`));
          return;
        }

        const receivedCode = reqUrl.searchParams.get("code");
        if (!receivedCode) {
          htmlResponse(res, 400, "Missing authorization code.");
          return;
        }

        htmlResponse(
          res,
          200,
          "<h2>Authorization complete</h2><p>You can close this tab and return to the terminal.</p>"
        );
        server.close();
        resolvePromise(receivedCode);
      }
    );

    server.on("error", rejectPromise);
    server.listen(port, () => {
      process.stderr.write(
        "\nExact Online authorization\n" +
          "==========================\n" +
          `Listening for the OAuth callback on ${config.redirectUri}\n\n` +
          "Open this URL in your browser to authorize:\n\n" +
          `${authUrl}\n\n`
      );
    });
  });

  process.stderr.write("Authorization code received. Exchanging for tokens...\n");
  const tokens = await exchangeCode(config, code);
  await saveTokens(config, tokens);
  process.stderr.write(
    `Success. Tokens saved to ${config.tokenStore}\nYou can now run the MCP server.\n`
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nError: ${message}\n`);
  process.exit(1);
});
