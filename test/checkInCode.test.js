import test from "node:test";
import assert from "node:assert/strict";
import { hashCheckInCode, normalizeCheckInCode, verifyCheckInCode } from "../src/utils/checkInCode.js";

test("normalizes surrounding whitespace from a check-in code", () => {
  assert.equal(normalizeCheckInCode(" 123456 "), "123456");
});

test("verifies the matching six-digit check-in code", () => {
  const storedHash = hashCheckInCode("123456");

  assert.equal(verifyCheckInCode("123456", storedHash), true);
  assert.equal(verifyCheckInCode("654321", storedHash), false);
});

test("rejects malformed codes and hashes", () => {
  const storedHash = hashCheckInCode("123456");

  assert.equal(verifyCheckInCode("12345", storedHash), false);
  assert.equal(verifyCheckInCode("12345a", storedHash), false);
  assert.equal(verifyCheckInCode("123456", "not-a-hash"), false);
});
