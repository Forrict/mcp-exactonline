import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compact, HMAC-SHA256 signed tokens: `<base64url(json)>.<base64url(mac)>`.
 *
 * Used for everything the OAuth server hands out (login state, authorization
 * codes, access and refresh tokens) so no database is needed. The token type
 * is part of the MAC input, so a token of one type can never be replayed as
 * another. Rotating the signing key revokes every outstanding token.
 */

export type TokenType = "state" | "code" | "access" | "refresh";

interface Envelope {
  typ: TokenType;
  /** Expiry, epoch seconds. */
  exp: number;
}

function mac(key: string, typ: TokenType, payload: string): string {
  return createHmac("sha256", key).update(`v1.${typ}.${payload}`).digest("base64url");
}

/** Constant-time string comparison (hash first so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function signToken<T extends object>(
  key: string,
  typ: TokenType,
  claims: T,
  ttlSeconds: number
): string {
  const body: T & Envelope = {
    ...claims,
    typ,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${mac(key, typ, payload)}`;
}

/** Return the claims if the token is authentic, of type `typ` and unexpired. */
export function verifyToken<T extends object>(
  key: string,
  typ: TokenType,
  token: string | null | undefined
): T | undefined {
  if (!token) return undefined;
  const [payload, sig, ...rest] = token.split(".");
  if (!payload || !sig || rest.length > 0) return undefined;
  if (!safeEqual(sig, mac(key, typ, payload))) return undefined;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T &
      Envelope;
    if (body.typ !== typ || !(body.exp > Date.now() / 1000)) return undefined;
    return body;
  } catch {
    return undefined;
  }
}
