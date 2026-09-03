function normalizeCurrency(currency) {
    const normalized = String(currency || "").trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(normalized)) {
        throw new TypeError("A valid three-letter currency code is required")
    }
    return normalized
}

export function getCurrencyMinorUnitExponent(currency, locale = "en-US") {
    const normalized = normalizeCurrency(currency)
    const options = new Intl.NumberFormat(locale, {
        style: "currency",
        currency: normalized,
    }).resolvedOptions()
    return options.maximumFractionDigits
}

export function minorUnitsToMajor(amountMinor, currency, locale = "en-US") {
    const amount = Number(amountMinor)
    if (!Number.isFinite(amount)) throw new TypeError("Minor-unit amount must be finite")
    const exponent = getCurrencyMinorUnitExponent(currency, locale)
    return amount / (10 ** exponent)
}

export function formatMoneyFromMinorUnits(
    amountMinor,
    currency,
    locale = "en-US",
) {
    const normalized = normalizeCurrency(currency)
    const exponent = getCurrencyMinorUnitExponent(normalized, locale)
    return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: normalized,
        minimumFractionDigits: exponent,
        maximumFractionDigits: exponent,
    }).format(minorUnitsToMajor(amountMinor, normalized, locale))
}

export { normalizeCurrency }
