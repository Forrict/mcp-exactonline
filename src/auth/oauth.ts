import type { Config } from "../config.js";
import { loadTokens, saveTokens, type TokenSet } from "./tokenStore.js";

/** Refresh when the access token expires within this many milliseconds. */
const SAFETY_MARGIN_MS = 60_000;

/** Default Exact access token lifetime (~10 minutes) if not returned. */
const DEFAULT_EXPIRES_IN_S = 600;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in?: number | string;
}

export interface OAuthError extends Error {
  code?: string;
}

function oauthUrl(config: Config, kind: "auth" | "token"): string {
  return `${config.baseUrl}/api/oauth2/${kind}`;
}

/** Build the browser authorization URL for the interactive login flow. */
export function buildAuthorizationUrl(config: Config): string {
  const url = new URL(oauthUrl(config, "auth"));
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  // force_login=0 reuses an existing Exact session if the user is signed in.
  url.searchParams.set("force_login", "0");
  return url.toString();
}

function computeExpiresAt(expiresIn: number | string | undefined): number {
  const seconds =
    typeof expiresIn === "string"
      ? Number(expiresIn)
      : typeof expiresIn === "number"
      ? expiresIn
      : DEFAULT_EXPIRES_IN_S;
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_EXPIRES_IN_S;
  return Date.now() + safe * 1000;
}

async function postToken(
  config: Config,
  params: Record<string, string>
): Promise<TokenSet> {
  const body = new URLSearchParams(params);
  const res = await fetch(oauthUrl(config, "token"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const errObj = data as { error?: string; error_description?: string };
    const err: OAuthError = new Error(
      `Exact OAuth token request failed (${res.status}): ${
        errObj.error ?? "unknown_error"
      }${errObj.error_description ? ` - ${errObj.error_description}` : ""}`
    );
    err.code = errObj.error;
    if (errObj.error === "invalid_grant") {
      err.message +=
        "\nThe refresh/authorization grant is no longer valid. Re-run `npm run auth` to re-authorize.";
    }
    throw err;
  }

  const token = data as TokenResponse;
  if (!token.access_token || !token.refresh_token) {
    throw new Error(
      "Exact OAuth token response missing access_token or refresh_token."
    );
  }
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: computeExpiresAt(token.expires_in),
  };
}

/**
 * Exchange an authorization code for an initial token set.
 * Used by the standalone login CLI.
 */
export async function exchangeCode(
  config: Config,
  code: string
): Promise<TokenSet> {
  return postToken(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
}

/**
 * Manages access token lifecycle for API calls.
 *
 * CRITICAL: Exact Online refresh tokens are SINGLE-USE. Every successful
 * refresh returns a brand-new refresh token; the old one is immediately
 * invalidated server-side. We therefore persist the new token set to disk
 * BEFORE handing the access token to callers, and serialize refreshes with an
 * in-process promise lock so concurrent callers never fire two parallel
 * refreshes (which would burn the refresh token and lock us out).
 */
export class OAuthManager {
  private tokens?: TokenSet;
  /** Promise-based mutex: non-undefined while a refresh is in flight. */
  private refreshInFlight?: Promise<TokenSet>;
  private loaded = false;

  constructor(private readonly config: Config) {}

  private async ensureLoaded(): Promise<TokenSet> {
    if (!this.loaded) {
      this.tokens = await loadTokens(this.config);
      this.loaded = true;
    }
    if (!this.tokens) {
      throw new Error(
        "No stored Exact Online tokens found. Run `npm run auth` to authorize, or set EXACT_REFRESH_TOKEN."
      );
    }
    return this.tokens;
  }

  private isFresh(tokens: TokenSet): boolean {
    return (
      !!tokens.access_token && tokens.expires_at - Date.now() > SAFETY_MARGIN_MS
    );
  }

  private async doRefresh(current: TokenSet): Promise<TokenSet> {
    const next = await postToken(this.config, {
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    // Persist the NEW single-use refresh token before anyone uses the access
    // token, so a crash can never leave us with an unsaved rotated token.
    await saveTokens(this.config, next);
    this.tokens = next;
    return next;
  }

  /**
   * Return a valid access token, refreshing if expired or within the safety
   * margin. Concurrent calls share a single in-flight refresh.
   */
  async getAccessToken(): Promise<string> {
    const current = await this.ensureLoaded();
    if (this.isFresh(current)) return current.access_token;

    // If a refresh is already running, await it rather than starting another.
    if (this.refreshInFlight) {
      const refreshed = await this.refreshInFlight;
      return refreshed.access_token;
    }

    this.refreshInFlight = this.doRefresh(current).finally(() => {
      this.refreshInFlight = undefined;
    });

    const refreshed = await this.refreshInFlight;
    return refreshed.access_token;
  }
}

/** Convenience factory returning a bound token provider fn. */
export function createTokenProvider(config: Config): () => Promise<string> {
  const manager = new OAuthManager(config);
  return () => manager.getAccessToken();
}
