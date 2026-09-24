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
 * Persistence backend for the token set. The default is a local JSON file;
 * the Lambda deployment uses AWS Secrets Manager (see secretsStore.ts).
 */
export interface TokenStore {
  load(): Promise<TokenSet | undefined>;
  save(tokens: TokenSet): Promise<void>;
}

/** Token store backed by the local file at config.tokenStore. */
export function createFileTokenStore(config: Config): TokenStore {
  return {
    load: () => loadTokens(config),
    save: (tokens) => saveTokens(config, tokens),
  };
}

/** True when the value has the shape of a persisted TokenSet. */
export function isTokenSet(value: unknown): value is TokenSet {
  const t = value as Partial<TokenSet> | null | undefined;
  return (
    !!t &&
    typeof t.access_token === "string" &&
    typeof t.refresh_token === "string" &&
    typeof t.expires_at === "number"
  );
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
    const parsed = JSON.parse(raw) as unknown;
    if (isTokenSet(parsed)) {
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
