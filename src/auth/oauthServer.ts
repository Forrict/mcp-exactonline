import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { buildAuthorizationUrl, exchangeCode } from "./oauth.js";
import { safeEqual, signToken, verifyToken } from "./signedToken.js";
import type { TokenSet } from "./tokenStore.js";

/**
 * Minimal OAuth 2.1 authorization server protecting the remote MCP endpoint
 * (MCP authorization spec: RFC 9728 resource metadata, RFC 8414 server
 * metadata, PKCE S256, RFC 8707 resource indicators).
 *
 * - One pre-registered confidential client (the ID/secret entered in Claude);
 *   no dynamic client registration.
 * - Users authenticate by logging in to Exact Online; only the configured
 *   Exact user is accepted. That same login also (re)connects the server's own
 *   Exact tokens, so one flow sets everything up.
 * - Everything issued is a stateless signed token (see signedToken.ts).
 */

export interface HttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface OAuthServerSettings {
  clientId: string;
  clientSecret: string;
  signingKey: string;
  /** Exact UserID (GUID) or UserName that may log in. */
  allowedExactUser?: string;
  exactConfig: Config;
  /** Persist the Exact tokens obtained during a successful login. */
  saveExactTokens: (tokens: TokenSet) => Promise<void>;
}

/** Redirect URIs of Claude's hosted apps; loopback URIs are allowed separately. */
const CLAUDE_REDIRECT_URIS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

const STATE_TTL_S = 15 * 60;
const CODE_TTL_S = 5 * 60;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;

export const EXACT_CALLBACK_PATH = "/oauth/callback";
export const MCP_PATH = "/mcp";
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const AUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

interface PendingAuthorization {
  client: string;
  redirect: string;
  clientState?: string;
  challenge: string;
}

interface CodeClaims {
  client: string;
  redirect: string;
  challenge: string;
  sub: string;
}

interface GrantClaims {
  client: string;
  sub: string;
  aud: string;
}

/** Loopback redirect for native clients such as Claude Code (RFC 8252 §7.3). */
function isLoopbackRedirect(uri: URL): boolean {
  return (
    uri.protocol === "http:" &&
    (uri.hostname === "localhost" || uri.hostname === "127.0.0.1") &&
    !uri.username &&
    !uri.password
  );
}

export function isAllowedRedirectUri(value: string | null): value is string {
  if (!value) return false;
  if (CLAUDE_REDIRECT_URIS.has(value)) return true;
  try {
    return isLoopbackRedirect(new URL(value));
  } catch {
    return false;
  }
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function html(statusCode: number, message: string): HttpResult {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">${message}</body></html>`,
  };
}

function json(statusCode: number, data: unknown, headers: Record<string, string> = {}): HttpResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
    body: JSON.stringify(data),
  };
}

function redirect(location: string): HttpResult {
  return { statusCode: 302, headers: { Location: location, "Cache-Control": "no-store" } };
}

function redirectWith(base: string, params: Record<string, string | undefined>): HttpResult {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return redirect(url.toString());
}

/** Log line that the CloudWatch metric filters count. Never include secrets. */
function logSecurityEvent(marker: "AUTH_FAILURE" | "LOGIN_REJECTED", detail: string): void {
  console.warn(`${marker} ${detail}`);
}

/** Canonical resource identifier of the MCP endpoint (token audience). */
function resourceFor(origin: string): string {
  return `${origin}${MCP_PATH}`;
}

function sameResource(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

export class OAuthServer {
  constructor(private readonly s: OAuthServerSettings) {}

  // ---- Discovery -----------------------------------------------------------

  protectedResourceMetadata(origin: string): HttpResult {
    return json(200, {
      resource: resourceFor(origin),
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
    });
  }

  authorizationServerMetadata(origin: string): HttpResult {
    return json(200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    });
  }

  /** 401 for the MCP endpoint, pointing the client at the resource metadata. */
  unauthorized(origin: string, reason: string): HttpResult {
    logSecurityEvent("AUTH_FAILURE", `mcp ${reason}`);
    return json(
      401,
      { error: "invalid_token", error_description: "Missing or invalid access token." },
      {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}${MCP_PATH}"`,
      }
    );
  }

  /** Validate a bearer access token for the MCP endpoint. */
  verifyAccessToken(origin: string, authorization: string | undefined): boolean {
    const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const claims = verifyToken<GrantClaims>(this.s.signingKey, "access", token);
    return (
      !!claims &&
      claims.client === this.s.clientId &&
      sameResource(claims.aud, resourceFor(origin))
    );
  }

  // ---- Authorization endpoint ------------------------------------------------

  authorize(origin: string, q: URLSearchParams): HttpResult {
    const clientId = q.get("client_id");
    const redirectUri = q.get("redirect_uri");
    // Without a trusted client + redirect URI we must not redirect anywhere.
    if (!clientId || !safeEqual(clientId, this.s.clientId)) {
      logSecurityEvent("AUTH_FAILURE", "authorize unknown client_id");
      return html(400, "<h2>Unknown client</h2>");
    }
    if (!isAllowedRedirectUri(redirectUri)) {
      logSecurityEvent("AUTH_FAILURE", "authorize redirect_uri not allowed");
      return html(400, "<h2>Redirect URI not allowed</h2>");
    }

    const clientState = q.get("state") ?? undefined;
    const fail = (error: string, description: string): HttpResult =>
      redirectWith(redirectUri, { error, error_description: description, state: clientState });

    if (q.get("response_type") !== "code") {
      return fail("unsupported_response_type", "Only response_type=code is supported.");
    }
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    const resource = q.get("resource");
    if (resource && !sameResource(resource, resourceFor(origin))) {
      return fail("invalid_target", "Unknown resource.");
    }

    const pending: PendingAuthorization = {
      client: clientId,
      redirect: redirectUri,
      clientState,
      challenge,
    };
    const state = signToken(this.s.signingKey, "state", pending, STATE_TTL_S);
    return redirect(buildAuthorizationUrl(this.exactConfigFor(origin), state));
  }

  // ---- Exact Online login callback -----------------------------------------------

  async exactCallback(origin: string, q: URLSearchParams): Promise<HttpResult> {
    const pending = verifyToken<PendingAuthorization>(this.s.signingKey, "state", q.get("state"));
    if (!pending) {
      logSecurityEvent("AUTH_FAILURE", "callback invalid state");
      return html(400, "<h2>Invalid or expired login</h2><p>Start again from Claude.</p>");
    }
    if (q.get("error")) {
      return redirectWith(pending.redirect, {
        error: "access_denied",
        error_description: "Exact Online login was cancelled or failed.",
        state: pending.clientState,
      });
    }
    const exactCode = q.get("code");
    if (!exactCode) return html(400, "<h2>Missing authorization code</h2>");

    const exactConfig = this.exactConfigFor(origin);
    const tokens = await exchangeCode(exactConfig, exactCode);
    const me = await fetchExactIdentity(exactConfig, tokens.access_token);

    const allowed = this.s.allowedExactUser?.trim().toLowerCase();
    const matches =
      !!allowed &&
      [me.UserID, me.UserName].some((v) => v?.toLowerCase() === allowed);
    if (!matches) {
      // Do NOT store tokens of a user that is not allowed.
      logSecurityEvent("LOGIN_REJECTED", "exact user not allowed");
      return html(
        403,
        "<h2>This Exact Online user is not allowed</h2>" +
          `<p>Logged in as <b>${escapeHtml(me.UserName ?? "?")}</b> (UserID <code>${escapeHtml(
            me.UserID ?? "?"
          )}</code>).</p>` +
          "<p>If this is you, set <code>ALLOWED_EXACT_USER</code> in the secret to this UserName or UserID and try again.</p>"
      );
    }

    await this.s.saveExactTokens(tokens);
    const code = signToken<CodeClaims>(
      this.s.signingKey,
      "code",
      {
        client: pending.client,
        redirect: pending.redirect,
        challenge: pending.challenge,
        sub: me.UserID ?? me.UserName ?? "exact-user",
      },
      CODE_TTL_S
    );
    return redirectWith(pending.redirect, { code, state: pending.clientState });
  }

  // ---- Token endpoint --------------------------------------------------------

  token(origin: string, authorization: string | undefined, form: URLSearchParams): HttpResult {
    const client = this.authenticateClient(authorization, form);
    if (!client) {
      logSecurityEvent("AUTH_FAILURE", "token invalid client");
      return json(401, { error: "invalid_client" }, { "WWW-Authenticate": 'Basic realm="token"' });
    }

    const grantType = form.get("grant_type");
    const resource = form.get("resource");
    if (resource && !sameResource(resource, resourceFor(origin))) {
      return json(400, { error: "invalid_target" });
    }

    let sub: string;
    if (grantType === "authorization_code") {
      const code = verifyToken<CodeClaims>(this.s.signingKey, "code", form.get("code"));
      const verifier = form.get("code_verifier");
      if (
        !code ||
        code.client !== client ||
        code.redirect !== form.get("redirect_uri") ||
        !verifier ||
        !safeEqual(pkceChallenge(verifier), code.challenge)
      ) {
        logSecurityEvent("AUTH_FAILURE", "token invalid authorization code");
        return json(400, { error: "invalid_grant" });
      }
      sub = code.sub;
    } else if (grantType === "refresh_token") {
      const refresh = verifyToken<GrantClaims>(
        this.s.signingKey,
        "refresh",
        form.get("refresh_token")
      );
      if (!refresh || refresh.client !== client || !sameResource(refresh.aud, resourceFor(origin))) {
        logSecurityEvent("AUTH_FAILURE", "token invalid refresh token");
        return json(400, { error: "invalid_grant" });
      }
      sub = refresh.sub;
    } else {
      return json(400, { error: "unsupported_grant_type" });
    }

    const grant: GrantClaims = { client, sub, aud: resourceFor(origin) };
    return json(200, {
      access_token: signToken(this.s.signingKey, "access", grant, ACCESS_TTL_S),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: signToken(this.s.signingKey, "refresh", grant, REFRESH_TTL_S),
    });
  }

  /** client_secret_basic or client_secret_post; returns the client ID if valid. */
  private authenticateClient(
    authorization: string | undefined,
    form: URLSearchParams
  ): string | undefined {
    let id = form.get("client_id") ?? undefined;
    let secret = form.get("client_secret") ?? undefined;
    const basic = authorization?.match(/^Basic\s+(\S+)$/i)?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep < 0) return undefined;
      try {
        id = decodeURIComponent(decoded.slice(0, sep));
        secret = decodeURIComponent(decoded.slice(sep + 1));
      } catch {
        return undefined;
      }
    }
    if (!id || !secret) return undefined;
    const ok = safeEqual(id, this.s.clientId) && safeEqual(secret, this.s.clientSecret);
    return ok ? this.s.clientId : undefined;
  }

  private exactConfigFor(origin: string): Config {
    return { ...this.s.exactConfig, redirectUri: `${origin}${EXACT_CALLBACK_PATH}` };
  }
}

interface ExactIdentity {
  UserID?: string;
  UserName?: string;
}

/** Identify the Exact user behind a freshly issued access token. */
async function fetchExactIdentity(config: Config, accessToken: string): Promise<ExactIdentity> {
  const res = await fetch(`${config.baseUrl}/api/v1/current/Me?$select=UserID,UserName`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Exact /current/Me failed (${res.status}).`);
  const data = (await res.json()) as { d?: { results?: ExactIdentity[] } | ExactIdentity };
  const d = data.d;
  const me = d && "results" in d && Array.isArray(d.results) ? d.results[0] : (d as ExactIdentity);
  if (!me?.UserID && !me?.UserName) throw new Error("Exact /current/Me returned no user.");
  return me;
}
