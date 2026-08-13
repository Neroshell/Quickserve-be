import { parsePhoneNumberFromString } from "libphonenumber-js/max"

export function normalizeInternationalPhoneNumber(value) {
    if (typeof value !== "string" || !value.trim()) return null

    const phoneNumber = parsePhoneNumberFromString(value.trim(), { extract: false })
    if (!phoneNumber?.isValid()) return null

    return phoneNumber.number
}
