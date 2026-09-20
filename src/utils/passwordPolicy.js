export const PASSWORD_MIN_CHARACTERS = 12
export const PASSWORD_MAX_UTF8_BYTES = 72

export const PASSWORD_POLICY_MESSAGE =
    `Password must be at least ${PASSWORD_MIN_CHARACTERS} characters and no more than ${PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes.`

/**
 * Validate newly-created credentials without changing the bytes that bcrypt
 * receives. Existing passwords are intentionally checked only at login and are
 * therefore not retroactively subject to this policy.
 */
export function validateNewPassword(password) {
    if (typeof password !== "string") {
        return { valid: false, code: "PASSWORD_REQUIRED", message: PASSWORD_POLICY_MESSAGE }
    }

    if (Array.from(password).length < PASSWORD_MIN_CHARACTERS) {
        return { valid: false, code: "PASSWORD_TOO_SHORT", message: PASSWORD_POLICY_MESSAGE }
    }

    if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_UTF8_BYTES) {
        return { valid: false, code: "PASSWORD_TOO_LONG", message: PASSWORD_POLICY_MESSAGE }
    }

    return { valid: true, code: null, message: null }
}

