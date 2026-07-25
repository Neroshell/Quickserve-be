import crypto from "crypto";

export const CHECK_IN_CODE_PATTERN = /^\d{6}$/;

export function normalizeCheckInCode(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function hashCheckInCode(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function verifyCheckInCode(value, storedHash) {
  const code = normalizeCheckInCode(value);
  if (!CHECK_IN_CODE_PATTERN.test(code) || !/^[a-f0-9]{64}$/i.test(storedHash || "")) {
    return false;
  }

  const candidateHash = Buffer.from(hashCheckInCode(code), "hex");
  const expectedHash = Buffer.from(storedHash, "hex");

  // Safeguard: Ensure byte lengths match before timing-safe check to prevent crashes
  if (candidateHash.length !== expectedHash.length) {
    return false;
  }
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}
