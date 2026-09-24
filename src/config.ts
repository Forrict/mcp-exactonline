import { homedir } from "node:os";
import { resolve } from "node:path";

/** Supported Exact Online regions and their API base URLs. */
export const REGION_BASE_URLS = {
  nl: "https://start.exactonline.nl",
  be: "https://start.exactonline.be",
  uk: "https://start.exactonline.co.uk",
  de: "https://start.exactonline.de",
  fr: "https://start.exactonline.fr",
  es: "https://start.exactonline.es",
  us: "https://start.exactonline.com",
} as const;

export type Region = keyof typeof REGION_BASE_URLS;

export interface Config {
  clientId: string;
  clientSecret: string;
  region: Region;
  /** API base URL for the configured region, e.g. https://start.exactonline.nl */
  baseUrl: string;
  /** Optional pinned division. When undefined, resolved from /current/Me. */
  division?: number;
  redirectUri: string;
  /** Absolute path to the token store JSON file. */
  tokenStore: string;
  /** Optional bootstrap refresh token (single-use seed). */
  refreshToken?: string;
  /** Friendly division aliases (lowercase name -> division code). */
  divisionAliases: Record<string, number>;
  /** When true, tools that create or modify data are not registered. */
  readOnly: boolean;
}

/** Expand a leading ~ to the user's home directory and return an absolute path. */
function expandPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function isRegion(value: string): value is Region {
  return Object.prototype.hasOwnProperty.call(REGION_BASE_URLS, value);
}

/**
 * Load and validate configuration from environment variables.
 * Throws with a clear message when a required variable is missing or invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clientId = env.EXACT_CLIENT_ID?.trim();
  const clientSecret = env.EXACT_CLIENT_SECRET?.trim();

  const missing: string[] = [];
  if (!clientId) missing.push("EXACT_CLIENT_ID");
  if (!clientSecret) missing.push("EXACT_CLIENT_SECRET");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(
        ", "
      )}. Copy .env.example to .env and fill in your Exact Online app credentials.`
    );
  }

  const regionRaw = (env.EXACT_REGION?.trim() || "nl").toLowerCase();
  if (!isRegion(regionRaw)) {
    throw new Error(
      `Invalid EXACT_REGION "${regionRaw}". Must be one of: ${Object.keys(
        REGION_BASE_URLS
      ).join(", ")}.`
    );
  }
  const region: Region = regionRaw;

  let division: number | undefined;
  const divisionRaw = env.EXACT_DIVISION?.trim();
  if (divisionRaw) {
    const parsed = Number(divisionRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid EXACT_DIVISION "${divisionRaw}". Must be a positive integer division code, or leave it unset to use the current division.`
      );
    }
    division = parsed;
  }

  const redirectUri =
    env.EXACT_REDIRECT_URI?.trim() || "http://localhost:8123/callback";
  try {
    // eslint-disable-next-line no-new
    new URL(redirectUri);
  } catch {
    throw new Error(
      `Invalid EXACT_REDIRECT_URI "${redirectUri}". Must be a valid URL, e.g. http://localhost:8123/callback.`
    );
  }

  const tokenStore = expandPath(
    env.EXACT_TOKEN_STORE?.trim() || "~/.mcp-exactonline/tokens.json"
  );

  const refreshToken = env.EXACT_REFRESH_TOKEN?.trim() || undefined;

  // EXACT_DIVISION_ALIASES="biemans-it=3326819,udamva=1234567"
  const divisionAliases: Record<string, number> = {};
  for (const pair of (env.EXACT_DIVISION_ALIASES ?? "").split(",")) {
    const [name, code] = pair.split("=").map((s) => s.trim());
    if (!name || !code) continue;
    const parsed = Number(code);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid division code "${code}" for alias "${name}" in EXACT_DIVISION_ALIASES.`
      );
    }
    divisionAliases[name.toLowerCase()] = parsed;
  }

  const readOnly = ["1", "true", "yes"].includes(
    (env.EXACT_READ_ONLY?.trim() || "").toLowerCase()
  );

  return {
    // clientId/clientSecret are guaranteed defined by the missing[] check above.
    clientId: clientId!,
    clientSecret: clientSecret!,
    region,
    baseUrl: REGION_BASE_URLS[region],
    division,
    redirectUri,
    tokenStore,
    refreshToken,
    divisionAliases,
    readOnly,
  };
}
