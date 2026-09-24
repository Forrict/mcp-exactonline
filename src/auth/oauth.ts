import type { Config } from "../config.js";
import {
  createFileTokenStore,
  type TokenSet,
  type TokenStore,
} from "./tokenStore.js";

/**
 * Refresh when the access token expires within this many milliseconds.
 * Exact only allows a refresh within ~30 seconds before expiry; asking
 * earlier fails with "Rate limit exceeded: access_token not expired", so
 * this margin must stay well below 30s.
 */
const SAFETY_MARGIN_MS = 15_000;

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
  description?: string;
}

/** Exact refuses to refresh while the current access token is still valid. */
function isNotExpiredRefusal(err: unknown): boolean {
  const description = (err as OAuthError).description ?? "";
  return /not expired/i.test(description);
}

function oauthUrl(config: Config, kind: "auth" | "token"): string {
  return `${config.baseUrl}/api/oauth2/${kind}`;
}

/** Build the browser authorization URL for the interactive login flow. */
export function buildAuthorizationUrl(config: Config, state?: string): string {
  const url = new URL(oauthUrl(config, "auth"));
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  // force_login=0 reuses an existing Exact session if the user is signed in.
  url.searchParams.set("force_login", "0");
  if (state) url.searchParams.set("state", state);
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
    err.description = errObj.error_description;
    if (errObj.error === "invalid_grant") {
      err.message +=
        "\nThe refresh/authorization grant is no longer valid. Re-authorize (`npm run auth` locally, or reconnect the connector in Claude when running on Lambda).";
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
 * invalidated server-side. We therefore persist the new token set BEFORE
 * handing the access token to callers, and serialize refreshes with an
 * in-process promise lock so concurrent callers never fire two parallel
 * refreshes (which would burn the refresh token and lock us out).
 *
 * Several processes may share one store (e.g. concurrent Lambda instances), so
 * the store is re-read right before refreshing: if another process already
 * rotated the tokens we adopt its result instead of using a stale refresh
 * token.
 */
export class OAuthManager {
  private tokens?: TokenSet;
  /** Promise-based mutex: non-undefined while a refresh is in flight. */
  private refreshInFlight?: Promise<TokenSet>;

  constructor(
    private readonly config: Config,
    private readonly store: TokenStore = createFileTokenStore(config)
  ) {}

  private isFresh(tokens: TokenSet): boolean {
    return (
      !!tokens.access_token && tokens.expires_at - Date.now() > SAFETY_MARGIN_MS
    );
  }

  private async loadFromStore(): Promise<TokenSet> {
    const tokens = await this.store.load();
    if (!tokens) {
      throw new Error(
        "No stored Exact Online tokens found. Authorize first (`npm run auth` locally, or reconnect the connector in Claude when running on Lambda), or set EXACT_REFRESH_TOKEN."
      );
    }
    return tokens;
  }

  private refreshWith(current: TokenSet): Promise<TokenSet> {
    return postToken(this.config, {
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
  }

  private async doRefresh(): Promise<TokenSet> {
    // Another process may have rotated the tokens since we last looked.
    let current = await this.loadFromStore();
    if (this.isFresh(current)) return current;

    let next: TokenSet;
    try {
      next = await this.refreshWith(current);
    } catch (err) {
      // Exact says the current access token is still valid (its clock runs
      // slightly behind ours): keep using it instead of failing the call.
      if (isNotExpiredRefusal(err) && current.access_token) return current;
      // Lost a race with another process: it consumed our refresh token and
      // stored a new one in the meantime. Adopt (or refresh with) that one.
      if ((err as OAuthError).code !== "invalid_grant") throw err;
      const latest = await this.loadFromStore();
      if (latest.refresh_token === current.refresh_token) throw err;
      if (this.isFresh(latest)) return latest;
      current = latest;
      next = await this.refreshWith(current);
    }
    // Persist the NEW single-use refresh token before anyone uses the access
    // token, so a crash can never leave us with an unsaved rotated token.
    await this.store.save(next);
    return next;
  }

  /**
   * Return a valid access token, refreshing if expired or within the safety
   * margin. Concurrent calls share a single in-flight refresh.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) this.tokens = await this.loadFromStore();
    if (this.isFresh(this.tokens)) return this.tokens.access_token;

    // If a refresh is already running, await it rather than starting another.
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    this.tokens = await this.refreshInFlight;
    return this.tokens.access_token;
  }
}

/** Convenience factory returning a bound token provider fn. */
export function createTokenProvider(
  config: Config,
  store?: TokenStore
): () => Promise<string> {
  const manager = new OAuthManager(config, store);
  return () => manager.getAccessToken();
}
