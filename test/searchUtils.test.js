import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSafeSearchRegex,
  MAX_SEARCH_LENGTH,
} from "../src/utils/searchUtils.js";

test("bounded literal search trims, escapes, and caps untrusted input", () => {
  assert.equal(buildSafeSearchRegex("   "), null);
  assert.equal(
    buildSafeSearchRegex(" Suite (1).* ").source,
    "Suite \\(1\\)\\.\\*",
  );

  const regex = buildSafeSearchRegex("a".repeat(MAX_SEARCH_LENGTH + 50));
  assert.equal(regex.source, "a".repeat(MAX_SEARCH_LENGTH));
  assert.equal(regex.flags, "i");
});

test("bounded literal search supports a smaller caller-specific ceiling", () => {
  const regex = buildSafeSearchRegex("abcdef", { maxLength: 4 });
  assert.equal(regex.source, "abcd");
});
