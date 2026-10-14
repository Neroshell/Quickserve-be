import { DateTime } from "luxon"

const WEEKDAY_NAMES = Object.freeze([
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
])
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const DEFAULT_BUSINESS_TIMEZONE = "Europe/Malta"

export const OPERATING_STATUS = Object.freeze({
    OPEN: "open",
    CLOSED: "closed",
    UNKNOWN: "unknown",
})

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function timeToMinutes(value) {
    if (typeof value !== "string" || !TIME_PATTERN.test(value)) return null
    const [hours, minutes] = value.split(":").map(Number)
    return (hours * 60) + minutes
}

function normalizeOperatingHours(operatingHours) {
    if (!isRecord(operatingHours) || Object.keys(operatingHours).length === 0) {
        return { valid: false, reason: "schedule_missing" }
    }

    const schedule = {}
    for (const weekday of WEEKDAY_NAMES) {
        const config = operatingHours[weekday]
        if (!isRecord(config) || typeof config.enabled !== "boolean") {
            return { valid: false, reason: "schedule_invalid" }
        }

        if (!config.enabled) {
            schedule[weekday] = { kind: "closed" }
            continue
        }

        const openMinutes = timeToMinutes(config.openTime)
        const closeMinutes = timeToMinutes(config.closeTime)
        if (openMinutes === null || closeMinutes === null) {
            return { valid: false, reason: "schedule_invalid" }
        }

        if (config.openTime === "00:00" && config.closeTime === "00:00") {
            // This is existing businessDate semantics: midnight-to-midnight is a
            // full local calendar day. Other equal times remain zero-length.
            schedule[weekday] = { kind: "all_day" }
        } else if (openMinutes === closeMinutes) {
            schedule[weekday] = { kind: "empty" }
        } else if (closeMinutes > openMinutes) {
            schedule[weekday] = { kind: "daytime", openMinutes, closeMinutes }
        } else {
            schedule[weekday] = { kind: "overnight", openMinutes, closeMinutes }
        }
    }

    return { valid: true, schedule }
}

function resolveLocalNow(nowUtc, timezone) {
    if (DateTime.isDateTime(nowUtc)) return nowUtc.setZone(timezone)
    if (nowUtc instanceof Date) return DateTime.fromJSDate(nowUtc, { zone: "utc" }).setZone(timezone)
    if (typeof nowUtc === "string") return DateTime.fromISO(nowUtc, { zone: "utc" }).setZone(timezone)
    if (nowUtc !== undefined) return DateTime.invalid("Invalid operating-hours evaluation time")
    return DateTime.now().setZone(timezone)
}

function isOpenForCurrentDay(day, currentMinutes) {
    if (day.kind === "all_day") return true
    if (day.kind === "daytime") {
        return currentMinutes >= day.openMinutes && currentMinutes < day.closeMinutes
    }
    if (day.kind === "overnight") return currentMinutes >= day.openMinutes
    return false
}

function isOpenFromPreviousDay(day, currentMinutes) {
    return day.kind === "overnight" && currentMinutes < day.closeMinutes
}

function nextOpeningTime(schedule, localNow) {
    const todayIndex = WEEKDAY_NAMES.indexOf(localNow.toFormat("EEEE"))
    if (todayIndex === -1) return null

    const currentMinutes = (localNow.hour * 60) + localNow.minute
    for (let daysAhead = 0; daysAhead < WEEKDAY_NAMES.length; daysAhead += 1) {
        const weekday = WEEKDAY_NAMES[(todayIndex + daysAhead) % WEEKDAY_NAMES.length]
        const day = schedule[weekday]
        if (!day || day.kind === "closed" || day.kind === "empty" || day.kind === "all_day") {
            continue
        }

        if (daysAhead === 0) {
            if (currentMinutes >= day.openMinutes) continue
            return `today at ${String(Math.floor(day.openMinutes / 60)).padStart(2, "0")}:${String(day.openMinutes % 60).padStart(2, "0")}`
        }

        const openTime = `${String(Math.floor(day.openMinutes / 60)).padStart(2, "0")}:${String(day.openMinutes % 60).padStart(2, "0")}`
        if (daysAhead === 1) return `tomorrow at ${openTime}`
        return `${weekday} at ${openTime}`
    }

    return null
}

function evaluationResult({ status, timezone = null, evaluatedAt = null, reason = null, nextOpeningTime: nextOpening = null }) {
    return { status, timezone, evaluatedAt, reason, nextOpeningTime: nextOpening }
}

/**
 * Evaluates a Business weekly operating schedule at an instant.
 *
 * Intervals are half-open: [opening, closing). An enabled 00:00?00:00
 * configuration retains the existing businessDate meaning of a 24-hour local
 * day; every other equal opening/closing pair is an empty, closed interval.
 */
export function evaluateBusinessOperatingStatus(business, nowUtc = undefined) {
    if (!business) {
        return evaluationResult({ status: OPERATING_STATUS.UNKNOWN, reason: "business_missing" })
    }

    const normalized = normalizeOperatingHours(business.operatingHours)
    if (!normalized.valid) {
        return evaluationResult({ status: OPERATING_STATUS.UNKNOWN, reason: normalized.reason })
    }

    const timezone = typeof business.timezone === "string" && business.timezone.trim()
        ? business.timezone.trim()
        : DEFAULT_BUSINESS_TIMEZONE
    const localNow = resolveLocalNow(nowUtc, timezone)
    if (!localNow.isValid) {
        return evaluationResult({
            status: OPERATING_STATUS.UNKNOWN,
            timezone,
            reason: "timezone_or_time_invalid",
        })
    }

    const todayIndex = WEEKDAY_NAMES.indexOf(localNow.toFormat("EEEE"))
    if (todayIndex === -1) {
        return evaluationResult({
            status: OPERATING_STATUS.UNKNOWN,
            timezone,
            evaluatedAt: localNow.toUTC().toISO(),
            reason: "weekday_unavailable",
        })
    }

    const currentMinutes = (localNow.hour * 60) + localNow.minute
    const today = normalized.schedule[WEEKDAY_NAMES[todayIndex]]
    const previous = normalized.schedule[WEEKDAY_NAMES[(todayIndex + WEEKDAY_NAMES.length - 1) % WEEKDAY_NAMES.length]]
    const evaluatedAt = localNow.toUTC().toISO()

    if (isOpenFromPreviousDay(previous, currentMinutes) || isOpenForCurrentDay(today, currentMinutes)) {
        return evaluationResult({ status: OPERATING_STATUS.OPEN, timezone, evaluatedAt })
    }

    return evaluationResult({
        status: OPERATING_STATUS.CLOSED,
        timezone,
        evaluatedAt,
        nextOpeningTime: nextOpeningTime(normalized.schedule, localNow),
    })
}

/**
 * Backward-compatible label helper. Invalid or incomplete schedules do not
 * speculate about a next opening time.
 */
export function getNextOpeningTime(operatingHours, timezone = DEFAULT_BUSINESS_TIMEZONE, nowDateTime = undefined) {
    const normalized = normalizeOperatingHours(operatingHours)
    if (!normalized.valid) return "later"

    const localNow = resolveLocalNow(nowDateTime, timezone)
    if (!localNow.isValid) return "later"

    return nextOpeningTime(normalized.schedule, localNow) || "later this week"
}

/**
 * Legacy boolean contract used by ordering and service-request flows.
 *
 * The old helper treated an absent Business or schedule as open. Preserve that
 * narrow fallback for those existing consumers while exposing `status: unknown`
 * so new consumers (including Discovery) never present it as Open. Invalid
 * present schedules remain unavailable, matching the prior effective behavior.
 */
export function isBusinessOpen(business, nowUtc = undefined) {
    const evaluation = evaluateBusinessOperatingStatus(business, nowUtc)
    if (evaluation.status === OPERATING_STATUS.OPEN) {
        return { isOpen: true, status: evaluation.status }
    }

    if (evaluation.status === OPERATING_STATUS.UNKNOWN) {
        const legacyOpenFallback = evaluation.reason === "business_missing" || evaluation.reason === "schedule_missing"
        return {
            isOpen: legacyOpenFallback,
            status: evaluation.status,
            nextOpeningTime: legacyOpenFallback ? undefined : "later",
        }
    }

    return {
        isOpen: false,
        status: evaluation.status,
        nextOpeningTime: evaluation.nextOpeningTime || "later this week",
    }
}
