import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDates, toExactDate } from "../src/client.js";

test("normalizeDates converts Exact /Date()/ values and strips OData noise", () => {
  const out = normalizeDates({
    __metadata: { uri: "x" },
    Created: "/Date(1700000000000)/",
    Modified: "/Date(1700000000000+0100)/",
    Name: "Acme",
    Empty: null,
    Nav: { __deferred: { uri: "y" } },
    Lines: [{ Amount: 1, Note: null }],
  }) as Record<string, unknown>;
  assert.equal(out.Created, "2023-11-14T22:13:20.000Z");
  assert.equal(out.Modified, "2023-11-14T22:13:20.000Z");
  assert.equal(out.Name, "Acme");
  assert.equal("__metadata" in out, false);
  assert.equal("Empty" in out, false);
  assert.equal("Nav" in out, false);
  assert.deepEqual(out.Lines, [{ Amount: 1 }]);
});

test("toExactDate produces a timezone-less OData v3 literal", () => {
  assert.equal(toExactDate("2024-01-01T00:00:00Z"), "datetime'2024-01-01T00:00:00'");
  assert.throws(() => toExactDate("not a date"));
});
