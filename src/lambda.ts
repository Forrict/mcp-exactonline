import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, type Config } from "./config.js";
import { buildAuthorizationUrl, createTokenProvider, exchangeCode } from "./auth/oauth.js";
import { SecretsManagerTokenStore } from "./auth/secretsStore.js";
import { ExactClient } from "./client.js";
import { createServer } from "./server.js";

/**
 * AWS Lambda entrypoint, served through a Lambda Function URL.
 *
 * Routes:
 *   POST /mcp/<MCP_ACCESS_KEY>   MCP Streamable HTTP (stateless, JSON responses)
 *   POST /mcp                    same, with `Authorization: Bearer <MCP_ACCESS_KEY>`
 *   GET  /auth/<MCP_ACCESS_KEY>  start the Exact Online OAuth login in a browser
 *   GET  /oauth/callback         OAuth redirect target (register it in the Exact App Center)
 *
 * Config and tokens live in one Secrets Manager secret named by EXACT_SECRET_ID
 * (see SecretDocument). Region/division/read-only come from env vars.
 */

/** Minimal subset of the Lambda Function URL (payload v2) event we use. */
interface FunctionUrlEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { domainName: string; http: { method: string } };
  /** Set by the scheduled keep-alive rule instead of an HTTP request. */
  keepalive?: boolean;
}

interface FunctionUrlResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

interface Context {
  config: Config;
  store: SecretsManagerTokenStore;
  client: ExactClient;
  getToken: () => Promise<string>;
  accessKey: string;
}

const MIN_ACCESS_KEY_LENGTH = 32;
const OAUTH_STATE_MAX_AGE_MS = 15 * 60_000;
const CALLBACK_PATH = "/oauth/callback";

let contextPromise: Promise<Context> | undefined;

async function initContext(): Promise<Context> {
  const secretId = process.env.EXACT_SECRET_ID?.trim();
  if (!secretId) throw new Error("EXACT_SECRET_ID is not set.");

  const store = new SecretsManagerTokenStore(secretId);
  const doc = await store.readDocument();
  const accessKey = doc.MCP_ACCESS_KEY?.trim() ?? "";
  if (accessKey.length < MIN_ACCESS_KEY_LENGTH) {
    throw new Error(
      `MCP_ACCESS_KEY in secret ${secretId} must be at least ${MIN_ACCESS_KEY_LENGTH} characters.`
    );
  }

  const config = loadConfig({
    ...process.env,
    EXACT_CLIENT_ID: doc.EXACT_CLIENT_ID,
    EXACT_CLIENT_SECRET: doc.EXACT_CLIENT_SECRET,
  });
  const getToken = createTokenProvider(config, store);
  const client = new ExactClient(config, getToken);
  return { config, store, client, getToken, accessKey };
}

/** Lazily initialize once per container; retry on the next call if it failed. */
function getContext(): Promise<Context> {
  if (!contextPromise) {
    contextPromise = initContext().catch((err: unknown) => {
      contextPromise = undefined;
      throw err;
    });
  }
  return contextPromise;
}

/** Constant-time string comparison (hash first so lengths always match). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function sign(accessKey: string, value: string): string {
  return createHmac("sha256", accessKey)
    .update(`exact-oauth-state:${value}`)
    .digest("base64url");
}

/** Stateless CSRF protection for the OAuth flow: `<timestamp>.<hmac>`. */
function createOAuthState(accessKey: string): string {
  const ts = String(Date.now());
  return `${ts}.${sign(accessKey, ts)}`;
}

function isValidOAuthState(accessKey: string, state: string | null): boolean {
  if (!state) return false;
  const [ts, sig] = state.split(".");
  const age = Date.now() - Number(ts);
  if (!sig || !Number.isFinite(age) || age < 0 || age > OAUTH_STATE_MAX_AGE_MS) {
    return false;
  }
  return safeEqual(sig, sign(accessKey, ts));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function html(statusCode: number, message: string): FunctionUrlResult {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">${message}</body></html>`,
  };
}

function text(statusCode: number, body: string): FunctionUrlResult {
  return { statusCode, headers: { "Content-Type": "text/plain" }, body };
}

function headerValue(event: FunctionUrlEvent, name: string): string | undefined {
  // Function URLs lower-case header names.
  return event.headers?.[name.toLowerCase()];
}

function toRequest(event: FunctionUrlEvent, url: string, method: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }
  let body: string | undefined;
  if (event.body !== undefined && method !== "GET" && method !== "HEAD") {
    body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
  }
  return new Request(url, { method, headers, body });
}

async function handleMcp(
  ctx: Context,
  event: FunctionUrlEvent,
  url: string,
  method: string
): Promise<FunctionUrlResult> {
  // Stateless mode on a buffered Lambda response: there is no long-lived SSE
  // stream to offer, so only POST is supported (the spec allows 405 here).
  if (method !== "POST") {
    return { statusCode: 405, headers: { Allow: "POST" }, body: "" };
  }

  const server = createServer(ctx.client, { readOnly: ctx.config.readOnly });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(toRequest(event, url, method));
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { statusCode: res.status, headers, body: await res.text() };
  } finally {
    await server.close();
  }
}

async function handleAuthStart(ctx: Context, origin: string): Promise<FunctionUrlResult> {
  const config = { ...ctx.config, redirectUri: `${origin}${CALLBACK_PATH}` };
  return {
    statusCode: 302,
    headers: {
      Location: buildAuthorizationUrl(config, createOAuthState(ctx.accessKey)),
      "Cache-Control": "no-store",
    },
  };
}

async function handleAuthCallback(
  ctx: Context,
  origin: string,
  query: URLSearchParams
): Promise<FunctionUrlResult> {
  if (!isValidOAuthState(ctx.accessKey, query.get("state"))) {
    return html(400, "<h2>Invalid or expired state</h2><p>Start again from /auth/&lt;key&gt;.</p>");
  }
  const error = query.get("error");
  if (error) {
    const desc = query.get("error_description") ?? "";
    return html(400, `<h2>Authorization failed</h2><p>${escapeHtml(`${error} ${desc}`)}</p>`);
  }
  const code = query.get("code");
  if (!code) return html(400, "<h2>Missing authorization code</h2>");

  const config = { ...ctx.config, redirectUri: `${origin}${CALLBACK_PATH}` };
  const tokens = await exchangeCode(config, code);
  await ctx.store.save(tokens);
  return html(
    200,
    "<h2>Exact Online connected</h2><p>Tokens are stored in Secrets Manager. You can close this tab.</p>"
  );
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult | void> {
  let ctx: Context;
  try {
    ctx = await getContext();
  } catch (err) {
    console.error("Initialization failed:", err);
    return text(500, "Server misconfigured. See the function logs.");
  }

  // Scheduled keep-alive: rotate the refresh token so it never expires
  // during long periods without use.
  if (event.keepalive) {
    await ctx.getToken();
    console.log("Keep-alive: Exact Online token is valid.");
    return;
  }

  const method = event.requestContext?.http.method ?? "GET";
  const domain = event.requestContext?.domainName ?? "localhost";
  const origin = `https://${domain}`;
  const path = event.rawPath ?? "/";
  const qs = event.rawQueryString ?? "";
  const url = `${origin}${path}${qs ? `?${qs}` : ""}`;

  try {
    const [, route, key, ...rest] = path.split("/");
    if (rest.length > 0) return text(404, "Not found");

    if (route === "mcp") {
      const bearer = headerValue(event, "authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      const provided = key || bearer;
      if (!provided || !safeEqual(provided, ctx.accessKey)) {
        return text(401, "Unauthorized");
      }
      return await handleMcp(ctx, event, url, method);
    }

    if (route === "auth" && method === "GET" && key && safeEqual(key, ctx.accessKey)) {
      return await handleAuthStart(ctx, origin);
    }

    if (`/${route}/${key}` === CALLBACK_PATH && method === "GET") {
      return await handleAuthCallback(ctx, origin, new URLSearchParams(qs));
    }

    return text(404, "Not found");
  } catch (err) {
    // Never log the request path: it may contain the access key.
    console.error(`Request failed (${method}):`, err);
    return text(500, "Internal error. See the function logs.");
  }
}
