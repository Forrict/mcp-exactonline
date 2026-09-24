import type { Config } from "./config.js";

export type TokenProvider = () => Promise<string>;

export interface ODataParams {
  $filter?: string;
  $select?: string;
  $top?: number;
  $orderby?: string;
  $skip?: number;
}

export interface RequestOptions {
  /** OData / query-string params. */
  params?: ODataParams & Record<string, string | number | undefined>;
  /** Request body (will be JSON-stringified). */
  body?: unknown;
  /** Extra headers. */
  headers?: Record<string, string>;
}

interface ExactSingleEnvelope<T> {
  d: T;
}

interface ExactListEnvelope<T> {
  d: {
    results: T[];
    __next?: string;
  };
}

interface ExactErrorEnvelope {
  error?: {
    code?: string;
    message?: { lang?: string; value?: string };
  };
}

interface MeInfo {
  CurrentDivision: number;
  UserName?: string;
  FullName?: string;
  Email?: string;
  [key: string]: unknown;
}

/** Matches Exact's /Date(1700000000000)/ or /Date(1700000000000+0100)/ format. */
const EXACT_DATE_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/**
 * Recursively convert Exact `/Date(ms)/` strings to ISO 8601 and strip OData
 * noise (`__metadata`, `__deferred` navigation stubs and null values), which
 * otherwise dominates responses without `$select`. Returns a new structure;
 * input is not mutated.
 */
export function normalizeDates<T>(obj: T): T {
  if (typeof obj === "string") {
    const m = EXACT_DATE_RE.exec(obj);
    if (m) {
      return new Date(Number(m[1])).toISOString() as unknown as T;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => normalizeDates(item)) as unknown as T;
  }
  if (obj && typeof obj === "object") {
    const entries = Object.entries(obj);
    // A deferred navigation property ({ __deferred: {...} }) carries no data.
    if (entries.length === 1 && entries[0][0] === "__deferred") {
      return undefined as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      if (key === "__metadata" || key === "__deferred" || value === null) {
        continue;
      }
      const normalized = normalizeDates(value);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out as T;
  }
  return obj;
}

/**
 * Build an Exact `$filter` datetime literal from an ISO string.
 * e.g. toExactDate("2024-01-01T00:00:00Z") -> "datetime'2024-01-01T00:00:00'"
 */
export function toExactDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date passed to toExactDate: ${iso}`);
  }
  // Exact OData wants no timezone suffix and no milliseconds.
  const literal = d.toISOString().replace(/\.\d{3}Z$/, "");
  return `datetime'${literal}'`;
}

export interface GetAllResult<T> {
  results: T[];
  truncated: boolean;
  count: number;
  /** Remaining Exact API calls this minute, when reported by Exact. */
  rate_limit_minutely_remaining?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export class ExactClient {
  private readonly apiBase: string;
  private cachedMe?: MeInfo;
  private lastRateRemaining?: number;
  /** name -> division code, built once from system/Divisions. */
  private divisionNameCache?: Map<string, number>;

  constructor(
    private readonly config: Config,
    private readonly getToken: TokenProvider
  ) {
    this.apiBase = `${config.baseUrl}/api/v1`;
  }

  /** Serialize OData/query params into a URLSearchParams-encoded string. */
  private buildQuery(
    params?: ODataParams & Record<string, string | number | undefined>
  ): string {
    if (!params) return "";
    const usp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      usp.set(key, String(value));
    }
    const s = usp.toString();
    return s ? `?${s}` : "";
  }

  /** Resolve a path (relative to /api/v1) or absolute URL to a full URL. */
  private resolveUrl(path: string, query = ""): string {
    if (/^https?:\/\//i.test(path)) return path;
    const rel = path.startsWith("/") ? path : `/${path}`;
    return `${this.apiBase}${rel}${query}`;
  }

  private async parseError(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as ExactErrorEnvelope;
      if (parsed.error?.message?.value) {
        message = parsed.error.message.value;
      }
    } catch {
      /* keep raw text */
    }
    let hint = "";
    if (res.status === 401 || res.status === 403) {
      hint =
        " (authorization refused by Exact — this endpoint may need a scope/right the app registration does not have)";
    } else if (res.status === 429) {
      hint = " (Exact rate limit reached — wait and try again)";
    } else if (res.status === 400 && /property|could not be found|invalid/i.test(message)) {
      hint = " (likely an invalid field name in $select/$filter for this resource)";
    }
    throw new Error(
      `Exact API error ${res.status} ${res.statusText}${
        message ? `: ${message}` : ""
      }${hint}`
    );
  }

  /**
   * Perform a single HTTP request against the Exact API and return the raw
   * (already date-normalized, envelope-unwrapped) payload.
   *
   * Retries once on 429 (honoring Retry-After) and once on 5xx (2s backoff).
   */
  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {}
  ): Promise<T> {
    const query = this.buildQuery(opts.params);
    const url = this.resolveUrl(path, query);

    let attempt = 0;
    // Up to 2 tries: original + one retry for a retriable condition.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = await this.getToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...opts.headers,
      };
      const hasBody = opts.body !== undefined && method !== "GET";
      if (hasBody) headers["Content-Type"] = "application/json";

      const res = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(opts.body) : undefined,
      });

      // Surface rate-limit headroom for debugging (stderr only).
      const remaining = res.headers.get("X-RateLimit-Minutely-Remaining");
      if (remaining !== null) {
        this.lastRateRemaining = Number(remaining);
        process.stderr.write(
          `[exact] X-RateLimit-Minutely-Remaining=${remaining}\n`
        );
      }

      if (res.status === 429 && attempt < 1) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000;
        process.stderr.write(
          `[exact] 429 rate limited, retrying after ${waitMs}ms\n`
        );
        await sleep(waitMs);
        attempt++;
        continue;
      }

      if (res.status >= 500 && res.status < 600 && attempt < 1) {
        process.stderr.write(
          `[exact] ${res.status} server error, retrying after 2000ms\n`
        );
        await sleep(2000);
        attempt++;
        continue;
      }

      if (!res.ok) {
        await this.parseError(res);
      }

      // 204 No Content (e.g. PUT/DELETE) -> empty payload.
      if (res.status === 204) {
        return undefined as unknown as T;
      }

      const text = await res.text();
      if (!text) return undefined as unknown as T;
      const json = JSON.parse(text) as unknown;
      return normalizeDates(this.unwrap<T>(json));
    }
  }

  /** Unwrap the Exact { d: ... } / { d: { results } } envelope. */
  private unwrap<T>(json: unknown): T {
    if (json && typeof json === "object" && "d" in json) {
      const d = (json as ExactSingleEnvelope<unknown>).d;
      if (d && typeof d === "object" && "results" in d) {
        return (d as { results: unknown }).results as T;
      }
      return d as T;
    }
    return json as T;
  }

  /**
   * Fetch a list resource, following `__next` pagination links until exhausted
   * or maxResults is reached. Returns results plus a truncation flag.
   */
  async getAll<T>(
    path: string,
    params?: ODataParams & Record<string, string | number | undefined>,
    maxResults = 500
  ): Promise<GetAllResult<T>> {
    const results: T[] = [];
    let truncated = false;

    // First page uses params; subsequent pages use the absolute __next URL.
    let nextUrl: string | undefined;
    let firstQuery = this.buildQuery(params);
    let currentPath: string = this.resolveUrl(path, firstQuery);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = await this.getToken();
      const res = await this.fetchRaw(currentPath, token);
      const page = res.d?.results ?? [];
      for (const item of page) {
        if (results.length >= maxResults) {
          truncated = true;
          break;
        }
        results.push(normalizeDates(item) as T);
      }
      if (truncated) break;

      nextUrl = res.d?.__next;
      if (!nextUrl) break;
      if (results.length >= maxResults) {
        truncated = true;
        break;
      }
      currentPath = nextUrl;
    }

    return {
      results,
      truncated,
      count: results.length,
      rate_limit_minutely_remaining: this.lastRateRemaining,
    };
  }

  /** Raw list fetch (with retry) returning the untouched list envelope. */
  private async fetchRaw<T>(
    url: string,
    token: string
  ): Promise<ExactListEnvelope<T>> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      const remaining = res.headers.get("X-RateLimit-Minutely-Remaining");
      if (remaining !== null) {
        this.lastRateRemaining = Number(remaining);
        process.stderr.write(
          `[exact] X-RateLimit-Minutely-Remaining=${remaining}\n`
        );
      }

      if (res.status === 429 && attempt < 1) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000;
        await sleep(waitMs);
        attempt++;
        continue;
      }
      if (res.status >= 500 && res.status < 600 && attempt < 1) {
        await sleep(2000);
        attempt++;
        continue;
      }
      if (!res.ok) {
        await this.parseError(res);
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : { d: { results: [] } }) as ExactListEnvelope<T>;
    }
  }

  /**
   * Return current user + division info from /current/Me, cached for the
   * lifetime of this client instance.
   */
  async getCurrentDivision(): Promise<MeInfo> {
    if (this.cachedMe) return this.cachedMe;
    const me = await this.request<MeInfo>(
      "GET",
      "/current/Me",
      {
        params: {
          $select: "CurrentDivision,UserName,FullName,Email",
        },
      }
    );
    // /current/Me returns a single-element results array in practice; the
    // unwrap() collapses { d: { results: [me] } } to the array — handle both.
    const info = Array.isArray(me) ? (me[0] as MeInfo) : me;
    this.cachedMe = info;
    return info;
  }

  /** Normalize a division name for matching: lowercase, non-alphanumerics -> space. */
  private static normalizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /**
   * Build (once per client) a lookup of division names -> codes from
   * system/Divisions, using Description and CustomerName.
   */
  private async divisionNames(): Promise<Map<string, number>> {
    if (this.divisionNameCache) return this.divisionNameCache;
    interface DivisionInfo {
      Code?: number;
      Description?: string;
      CustomerName?: string;
    }
    const me = await this.getCurrentDivision();
    const current = this.config.division ?? me?.CurrentDivision;
    const list = await this.getAll<DivisionInfo>(
      `/${current}/system/Divisions`,
      { $select: "Code,Description,CustomerName" },
      500
    );
    const map = new Map<string, number>();
    for (const division of list.results) {
      if (!division.Code) continue;
      for (const name of [division.Description, division.CustomerName]) {
        if (name) map.set(ExactClient.normalizeName(name), division.Code);
      }
    }
    this.divisionNameCache = map;
    return map;
  }

  /**
   * Resolve the active division: an explicit per-call override (a division
   * code, an alias from EXACT_DIVISION_ALIASES, or a division name matched
   * dynamically against system/Divisions) if given, else EXACT_DIVISION,
   * else the user's CurrentDivision.
   */
  async resolveDivision(override?: number | string): Promise<number> {
    if (typeof override === "string" && override.trim()) {
      const key = override.trim().toLowerCase();
      const aliased = this.config.divisionAliases[key];
      if (aliased) return aliased;
      const parsed = Number(key);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;

      // Dynamic lookup by division name (fetched once, cached).
      const names = await this.divisionNames();
      const normalized = ExactClient.normalizeName(override);
      const exact = names.get(normalized);
      if (exact) return exact;
      // Fall back to a unique substring match ("biemans" -> "Biemans IT B.V.").
      const partial = [...names.entries()].filter(([name]) =>
        name.includes(normalized)
      );
      const codes = new Set(partial.map(([, code]) => code));
      if (codes.size === 1) return partial[0][1];
      throw new Error(
        `Unknown division "${override}"${
          codes.size > 1 ? " (ambiguous name)" : ""
        }. Known divisions: ${[...new Set(names.keys())].join(", ") || "none"}.`
      );
    }
    if (typeof override === "number" && override) return override;
    if (this.config.division) return this.config.division;
    const me = await this.getCurrentDivision();
    if (!me?.CurrentDivision) {
      throw new Error(
        "Could not resolve division: /current/Me returned no CurrentDivision. Set EXACT_DIVISION explicitly."
      );
    }
    return me.CurrentDivision;
  }

  /** Build a division-scoped resource path: /{division}/{resource}. */
  async divisionPath(
    resource: string,
    division?: number | string
  ): Promise<string> {
    const resolved = await this.resolveDivision(division);
    const clean = resource.replace(/^\/+/, "");
    return `/${resolved}/${clean}`;
  }
}
