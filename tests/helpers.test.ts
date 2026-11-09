import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guid, odataString } from "../src/tools/helpers.js";

test("odataString doubles embedded quotes so filters cannot be broken out of", () => {
  assert.equal(odataString("O'Brien"), "'O''Brien'");
  assert.equal(odataString("x') or (1 eq 1"), "'x'') or (1 eq 1'");
});

test("guid accepts GUIDs and rejects anything else", () => {
  assert.equal(guid.safeParse("3fa85f64-5717-4562-b3fc-2c963f66afa6").success, true);
  assert.equal(guid.safeParse("3FA85F64-5717-4562-B3FC-2C963F66AFA6").success, true);
  assert.equal(guid.safeParse("x') or 1 eq 1 or ('").success, false);
  assert.equal(guid.safeParse("3fa85f64-5717-4562-b3fc-2c963f66afa6'").success, false);
  assert.equal(guid.safeParse("").success, false);
});

test("server version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const m = /const SERVER_VERSION = "([^"]+)"/.exec(src);
  assert.equal(m?.[1], pkg.version, "bump SERVER_VERSION in src/server.ts together with package.json");
});
