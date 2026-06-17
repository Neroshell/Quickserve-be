import crypto from "crypto"

/**
 * Hash a single-use token (invite / password reset) for storage at rest.
 *
 * The raw token is emailed to the user; only its SHA-256 hash is stored in the
 * database. On verification we hash the incoming token and look it up by hash,
 * so a database/response leak never exposes a usable token.
 *
 * SHA-256 (not bcrypt) is appropriate here: these tokens are 256-bit random
 * values, so they are not brute-forceable and need no salt/work factor.
 */
export function hashToken(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex")
}
