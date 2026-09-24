import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, type Config } from "./config.js";
import { createTokenProvider } from "./auth/oauth.js";
import {
  AUTH_SERVER_METADATA_PATH,
  EXACT_CALLBACK_PATH,
  MCP_PATH,
  OAuthServer,
  RESOURCE_METADATA_PATH,
  type HttpResult,
} from "./auth/oauthServer.js";
import { SecretsManagerTokenStore } from "./auth/secretsStore.js";
import { ExactClient } from "./client.js";
import { createServer } from "./server.js";

/**
 * AWS Lambda entrypoint, served through a Lambda Function URL.
 *
 * Routes:
 *   POST /mcp                                     MCP Streamable HTTP (stateless, JSON), Bearer token required
 *   GET  /.well-known/oauth-protected-resource    RFC 9728 resource metadata (also with /mcp suffix)
 *   GET  /.well-known/oauth-authorization-server  RFC 8414 server metadata
 *   GET  /authorize                               OAuth authorization endpoint (sends you to the Exact login)
 *   GET  /oauth/callback                          Exact Online redirect target (register it in the Exact App Center)
 *   POST /token                                   OAuth token endpoint
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

interface Context {
  config: Config;
  client: ExactClient;
  getToken: () => Promise<string>;
  oauth: OAuthServer;
}

const MIN_SECRET_LENGTH = 32;

let contextPromise: Promise<Context> | undefined;

async function initContext(): Promise<Context> {
  const secretId = process.env.EXACT_SECRET_ID?.trim();
  if (!secretId) throw new Error("EXACT_SECRET_ID is not set.");

  const store = new SecretsManagerTokenStore(secretId);
  const doc = await store.readDocument();
  const required = (name: "OAUTH_CLIENT_ID" | "OAUTH_CLIENT_SECRET" | "SIGNING_KEY", minLength: number): string => {
    const value = doc[name]?.trim() ?? "";
    if (value.length < minLength) {
      throw new Error(`${name} in secret ${secretId} must be at least ${minLength} characters.`);
    }
    return value;
  };

  const config = loadConfig({
    ...process.env,
    EXACT_CLIENT_ID: doc.EXACT_CLIENT_ID,
    EXACT_CLIENT_SECRET: doc.EXACT_CLIENT_SECRET,
  });
  const getToken = createTokenProvider(config, store);
  const oauth = new OAuthServer({
    clientId: required("OAUTH_CLIENT_ID", 1),
    clientSecret: required("OAUTH_CLIENT_SECRET", MIN_SECRET_LENGTH),
    signingKey: required("SIGNING_KEY", MIN_SECRET_LENGTH),
    allowedExactUser: doc.ALLOWED_EXACT_USER,
    exactConfig: config,
    saveExactTokens: (tokens) => store.save(tokens),
  });
  return { config, client: new ExactClient(config, getToken), getToken, oauth };
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

function text(statusCode: number, body: string): HttpResult {
  return { statusCode, headers: { "Content-Type": "text/plain" }, body };
}

function decodeBody(event: FunctionUrlEvent): string | undefined {
  if (event.body === undefined) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

async function handleMcp(ctx: Context, event: FunctionUrlEvent, url: string): Promise<HttpResult> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }

  const server = createServer(ctx.client, { readOnly: ctx.config.readOnly });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(
      new Request(url, { method: "POST", headers, body: decodeBody(event) })
    );
    const out: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      out[key] = value;
    });
    return { statusCode: res.status, headers: out, body: await res.text() };
  } finally {
    await server.close();
  }
}

export async function handler(event: FunctionUrlEvent): Promise<HttpResult | void> {
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
  const origin = `https://${event.requestContext?.domainName ?? "localhost"}`;
  const path = (event.rawPath ?? "/").replace(/\/+$/, "") || "/";
  const query = new URLSearchParams(event.rawQueryString ?? "");
  // Function URLs lower-case header names.
  const authorization = event.headers?.authorization;

  try {
    if (path === MCP_PATH) {
      // Stateless mode on a buffered Lambda response: there is no long-lived
      // SSE stream to offer, so only POST is supported (the spec allows 405).
      if (method !== "POST") return { statusCode: 405, headers: { Allow: "POST" } };
      if (!ctx.oauth.verifyAccessToken(origin, authorization)) {
        return ctx.oauth.unauthorized(origin, authorization ? "invalid token" : "no token");
      }
      return await handleMcp(ctx, event, `${origin}${MCP_PATH}`);
    }

    if (method === "GET") {
      if (path === RESOURCE_METADATA_PATH || path === `${RESOURCE_METADATA_PATH}${MCP_PATH}`) {
        return ctx.oauth.protectedResourceMetadata(origin);
      }
      if (path === AUTH_SERVER_METADATA_PATH) return ctx.oauth.authorizationServerMetadata(origin);
      if (path === "/authorize") return ctx.oauth.authorize(origin, query);
      if (path === EXACT_CALLBACK_PATH) return await ctx.oauth.exactCallback(origin, query);
    }

    if (method === "POST" && path === "/token") {
      return ctx.oauth.token(origin, authorization, new URLSearchParams(decodeBody(event) ?? ""));
    }

    return text(404, "Not found");
  } catch (err) {
    // Never log query strings or bodies: they may contain codes or tokens.
    console.error(`Request failed (${method} ${path}):`, err);
    return text(500, "Internal error. See the function logs.");
  }
}
