import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "../config.js";

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds at which access_token expires. */
  expires_at: number;
}

/**
 * Load the persisted token set.
 *
 * If the store file does not exist but EXACT_REFRESH_TOKEN is configured,
 * bootstrap a seed TokenSet from it (with an already-expired access token so
 * the first getAccessToken() call performs a refresh). Returns undefined when
 * neither a file nor a bootstrap token is available.
 */
export async function loadTokens(
  config: Config
): Promise<TokenSet | undefined> {
  try {
    const raw = await readFile(config.tokenStore, "utf8");
    const parsed = JSON.parse(raw) as Partial<TokenSet>;
    if (
      typeof parsed.access_token === "string" &&
      typeof parsed.refresh_token === "string" &&
      typeof parsed.expires_at === "number"
    ) {
      return {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_at: parsed.expires_at,
      };
    }
    throw new Error(
      `Token store at ${config.tokenStore} is malformed. Re-run \`npm run auth\`.`
    );
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // No file yet: fall back to the bootstrap refresh token if present.
      if (config.refreshToken) {
        return {
          access_token: "",
          refresh_token: config.refreshToken,
          // Force an immediate refresh on first use.
          expires_at: 0,
        };
      }
      return undefined;
    }
    throw err;
  }
}

/**
 * Persist the token set atomically-ish with restrictive (0600) permissions.
 * Creates parent directories as needed.
 */
export async function saveTokens(
  config: Config,
  tokens: TokenSet
): Promise<void> {
  await mkdir(dirname(config.tokenStore), { recursive: true, mode: 0o700 });
  await writeFile(config.tokenStore, JSON.stringify(tokens, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}
