import { createRequire } from "module"
import countryToCurrency from "country-to-currency"
import { getCountry, getTimezonesForCountry } from "countries-and-timezones"

const require = createRequire(import.meta.url)
const countries = require("i18n-iso-countries")
const enLocale = require("i18n-iso-countries/langs/en.json")

countries.registerLocale(enLocale)

export class CountryResolutionError extends Error {
    constructor(message) {
        super(message)
        this.name = "CountryResolutionError"
    }
}

function normalizeCountryInput(country) {
    if (typeof country !== "string" || !country.trim()) {
        throw new CountryResolutionError("Country is required")
    }

    return country.trim().replace(/\s+/g, " ")
}

function resolveAlpha2Code(country) {
    const normalized = normalizeCountryInput(country)
    const upper = normalized.toUpperCase()

    if (/^[A-Z]{2}$/.test(upper) && countries.isValid(upper)) {
        return upper
    }

    if (/^[A-Z]{3}$/.test(upper)) {
        const alpha2 = countries.alpha3ToAlpha2(upper)
        if (alpha2 && countries.isValid(alpha2)) {
            return alpha2
        }
    }

    const alpha2 = countries.getAlpha2Code(normalized, "en")
    if (alpha2 && countries.isValid(alpha2)) {
        return alpha2
    }

    throw new CountryResolutionError(`Unsupported country "${normalized}"`)
}

export function resolveCountryMetadata(country) {
    const alpha2 = resolveAlpha2Code(country)
    const countryData = getCountry(alpha2)
    const currency = countryToCurrency[alpha2]
    const timezones = getTimezonesForCountry(alpha2) || []
    const timezone = timezones[0]?.name

    if (!countryData?.name) {
        throw new CountryResolutionError(`Unsupported country code "${alpha2}"`)
    }
    if (!currency) {
        throw new CountryResolutionError(`No default currency found for "${countryData.name}"`)
    }
    if (!timezone) {
        throw new CountryResolutionError(`No default timezone found for "${countryData.name}"`)
    }

    return {
        country: countryData.name,
        countryCode: alpha2.toLowerCase(),
        currency,
        timezone,
        timezones: timezones.map((tz) => tz.name)
    }
}

export function deriveCountryCode(country) {
    return resolveCountryMetadata(country).countryCode
}

export function validateCountryMetadataPayload(country, payload = {}) {
    const metadata = resolveCountryMetadata(country)
    const submittedCountryCode = typeof payload.countryCode === "string" ? payload.countryCode.trim().toLowerCase() : ""
    const submittedCurrency = typeof payload.currency === "string" ? payload.currency.trim().toUpperCase() : ""
    const submittedTimezone = typeof payload.timezone === "string" ? payload.timezone.trim() : ""

    if (submittedCountryCode && submittedCountryCode !== metadata.countryCode) {
        throw new CountryResolutionError(`Country code "${submittedCountryCode}" does not match "${metadata.country}"`)
    }

    if (submittedCurrency && submittedCurrency !== metadata.currency) {
        throw new CountryResolutionError(`Currency "${submittedCurrency}" does not match "${metadata.country}"`)
    }

    if (submittedTimezone && !metadata.timezones.includes(submittedTimezone)) {
        throw new CountryResolutionError(`Timezone "${submittedTimezone}" is not valid for "${metadata.country}"`)
    }

    return {
        ...metadata,
        timezone: submittedTimezone || metadata.timezone
    }
}

export function isCountryResolutionError(err) {
    return err instanceof CountryResolutionError
}
