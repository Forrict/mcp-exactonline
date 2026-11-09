import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEqual, signToken, verifyToken } from "../src/auth/signedToken.js";

const KEY = "k".repeat(32);

test("signToken/verifyToken round-trip", () => {
  const token = signToken(KEY, "access", { sub: "u1" }, 60);
  const claims = verifyToken<{ sub: string }>(KEY, "access", token);
  assert.equal(claims?.sub, "u1");
});

test("token type is bound: an access token is not a refresh token", () => {
  const token = signToken(KEY, "access", { sub: "u1" }, 60);
  assert.equal(verifyToken(KEY, "refresh", token), undefined);
});

test("tampered payload or wrong key is rejected", () => {
  const token = signToken(KEY, "access", { sub: "u1" }, 60);
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: "admin" })).toString("base64url");
  assert.equal(verifyToken(KEY, "access", `${forged}.${sig}`), undefined);
  assert.equal(verifyToken("x".repeat(32), "access", token), undefined);
  assert.equal(verifyToken(KEY, "access", `${token}.extra`), undefined);
  assert.equal(verifyToken(KEY, "access", ""), undefined);
});

test("expired token is rejected", () => {
  const token = signToken(KEY, "code", { sub: "u1" }, -1);
  assert.equal(verifyToken(KEY, "code", token), undefined);
});

test("safeEqual compares strings of different lengths without throwing", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", "a"), false);
});
