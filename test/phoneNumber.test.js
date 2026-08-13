import assert from "node:assert/strict"
import test from "node:test"

import { normalizeInternationalPhoneNumber } from "../src/utils/phoneNumber.js"

test("normalizes a valid international phone number to E.164", () => {
    assert.equal(normalizeInternationalPhoneNumber("+356 9912 3456"), "+35699123456")
    assert.equal(normalizeInternationalPhoneNumber("+1 (213) 373-4253"), "+12133734253")
})

test("rejects incomplete, invalid, and national-only phone numbers", () => {
    assert.equal(normalizeInternationalPhoneNumber("+356 99"), null)
    assert.equal(normalizeInternationalPhoneNumber("9912 3456"), null)
    assert.equal(normalizeInternationalPhoneNumber("Call +356 9912 3456"), null)
})
