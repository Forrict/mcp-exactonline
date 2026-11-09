import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const base = { EXACT_CLIENT_ID: "id", EXACT_CLIENT_SECRET: "secret" };

test("loadConfig requires the Exact client credentials", () => {
  assert.throws(() => loadConfig({}), /EXACT_CLIENT_ID, EXACT_CLIENT_SECRET/);
});

test("loadConfig parses region, division, aliases and read-only flag", () => {
  const c = loadConfig({
    ...base,
    EXACT_REGION: "BE",
    EXACT_DIVISION: "1234567",
    EXACT_DIVISION_ALIASES: "Acme=1234567, acme-holding = 7654321",
    EXACT_READ_ONLY: "true",
  });
  assert.equal(c.baseUrl, "https://start.exactonline.be");
  assert.equal(c.division, 1234567);
  assert.deepEqual(c.divisionAliases, { acme: 1234567, "acme-holding": 7654321 });
  assert.equal(c.readOnly, true);
});

test("loadConfig rejects invalid region, division and alias codes", () => {
  assert.throws(() => loadConfig({ ...base, EXACT_REGION: "xx" }), /Invalid EXACT_REGION/);
  assert.throws(() => loadConfig({ ...base, EXACT_DIVISION: "abc" }), /Invalid EXACT_DIVISION/);
  assert.throws(() => loadConfig({ ...base, EXACT_DIVISION_ALIASES: "acme=notanumber" }), /Invalid division code/);
});
