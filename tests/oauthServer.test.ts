import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { OAuthServer, isAllowedRedirectUri } from "../src/auth/oauthServer.js";
import { signToken } from "../src/auth/signedToken.js";
import type { Config } from "../src/config.js";

const ORIGIN = "https://example.lambda-url.eu-west-1.on.aws";
const CLIENT_ID = "claude-exact";
const CLIENT_SECRET = "s".repeat(64);
const SIGNING_KEY = "k".repeat(64);
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const exactConfig: Config = {
  clientId: "exact-client",
  clientSecret: "exact-secret",
  region: "nl",
  baseUrl: "https://start.exactonline.nl",
  redirectUri: "http://localhost:8123/callback",
  tokenStore: "/dev/null",
  divisionAliases: {},
  readOnly: false,
};

function server(): OAuthServer {
  return new OAuthServer({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    signingKey: SIGNING_KEY,
    allowedExactUser: async () => "user@example.com",
    exactConfig,
    saveExactTokens: async () => undefined,
  });
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

test("redirect URI allowlist: Claude hosts and loopback only", () => {
  assert.equal(isAllowedRedirectUri(REDIRECT), true);
  assert.equal(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback"), true);
  assert.equal(isAllowedRedirectUri("http://localhost:8080/callback"), true);
  assert.equal(isAllowedRedirectUri("http://127.0.0.1:1234/cb"), true);
  assert.equal(isAllowedRedirectUri("https://evil.example/callback"), false);
  assert.equal(isAllowedRedirectUri("http://localhost.evil.example/cb"), false);
  assert.equal(isAllowedRedirectUri("https://localhost/cb"), false);
  assert.equal(isAllowedRedirectUri("http://user:pw@localhost/cb"), false);
  assert.equal(isAllowedRedirectUri(null), false);
});

test("authorize refuses unknown clients and bad redirects without redirecting", () => {
  const s = server();
  const { challenge } = pkce();
  const base = { redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" };
  assert.equal(s.authorize(ORIGIN, new URLSearchParams({ ...base, client_id: "other" })).statusCode, 400);
  assert.equal(
    s.authorize(ORIGIN, new URLSearchParams({ ...base, client_id: CLIENT_ID, redirect_uri: "https://evil.example/cb" })).statusCode,
    400
  );
});

test("authorize requires PKCE S256 and reports errors to the client redirect", () => {
  const s = server();
  const res = s.authorize(
    ORIGIN,
    new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", state: "abc" })
  );
  assert.equal(res.statusCode, 302);
  const loc = new URL(res.headers!.Location);
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get("error"), "invalid_request");
  assert.equal(loc.searchParams.get("state"), "abc");
});

test("authorize sends the user to the Exact login with a signed state", () => {
  const s = server();
  const { challenge } = pkce();
  const res = s.authorize(
    ORIGIN,
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${ORIGIN}/mcp`,
    })
  );
  assert.equal(res.statusCode, 302);
  const loc = new URL(res.headers!.Location);
  assert.equal(loc.origin, exactConfig.baseUrl);
  assert.equal(loc.pathname, "/api/oauth2/auth");
  assert.equal(loc.searchParams.get("redirect_uri"), `${ORIGIN}/oauth/callback`);
  assert.ok(loc.searchParams.get("state"));
});

test("token endpoint: code exchange needs client secret, matching redirect and PKCE verifier", () => {
  const s = server();
  const { verifier, challenge } = pkce();
  const code = signToken(SIGNING_KEY, "code", { client: CLIENT_ID, redirect: REDIRECT, challenge, sub: "u1" }, 300);
  const form = (over: Record<string, string> = {}) =>
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      ...over,
    });

  assert.equal(s.token(ORIGIN, undefined, form({ client_secret: "wrong" })).statusCode, 401);
  assert.equal(s.token(ORIGIN, undefined, form({ code_verifier: "wrong" })).statusCode, 400);
  assert.equal(s.token(ORIGIN, undefined, form({ redirect_uri: "http://localhost:9/cb" })).statusCode, 400);

  const ok = s.token(ORIGIN, undefined, form());
  assert.equal(ok.statusCode, 200);
  const body = JSON.parse(ok.body!) as { access_token: string; refresh_token: string; token_type: string };
  assert.equal(body.token_type, "Bearer");
  assert.equal(s.verifyAccessToken(ORIGIN, `Bearer ${body.access_token}`), true);
  // Audience bound: the same token is not valid for another deployment.
  assert.equal(s.verifyAccessToken("https://other.example", `Bearer ${body.access_token}`), false);
  // A refresh token is not accepted as an access token.
  assert.equal(s.verifyAccessToken(ORIGIN, `Bearer ${body.refresh_token}`), false);

  // Refresh grant, with client_secret_basic.
  const basic = "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const refreshed = s.token(
    ORIGIN,
    basic,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: body.refresh_token })
  );
  assert.equal(refreshed.statusCode, 200);
});

test("MCP endpoint rejects missing or garbage bearer tokens", () => {
  const s = server();
  assert.equal(s.verifyAccessToken(ORIGIN, undefined), false);
  assert.equal(s.verifyAccessToken(ORIGIN, "Bearer nope"), false);
  const res = s.unauthorized(ORIGIN, "no token");
  assert.equal(res.statusCode, 401);
  assert.match(res.headers!["WWW-Authenticate"], /resource_metadata=/);
});
