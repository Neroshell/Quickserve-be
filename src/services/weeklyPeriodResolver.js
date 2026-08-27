/**
 * Canonical weekly period resolver for the AI Business Analyst (Mayor).
 *
 * All week boundaries in the Mayor subsystem must be derived from these
 * functions so that periodKey, periodStart, and periodEnd are always
 * consistent.
 *
 * Week definition: ISO week — Monday 00:00 → Sunday 23:59:59 in the
 * business timezone.  The periodKey format is `YYYY-Www`.
 */
import { DateTime } from "luxon"
import { resolveAnalyticsTimezone } from "./analytics/analyticsRangeService.js"

const PERIOD_KEY_REGEX = /^\d{4}-W\d{2}$/

/**
 * Parse a `YYYY-Www` periodKey into its deterministic Monday–Sunday
 * dates in the given timezone.
 *
 * @param {string} periodKey  e.g. "2026-W33"
 * @param {string} timezone   IANA timezone string
 * @returns {{ key: string, start: string, end: string, timezone: string }}
 * @throws {Error} on invalid periodKey
 */
export function resolveWeeklyPeriodFromKey(periodKey, timezone) {
    if (!periodKey || !PERIOD_KEY_REGEX.test(periodKey)) {
        throw new Error(`Invalid periodKey: "${periodKey}" — expected YYYY-Www`)
    }

    const tz = resolveAnalyticsTimezone(timezone, "UTC")
    const [yearPart, weekPart] = periodKey.split("-W")
    const weekYear = Number(yearPart)
    const weekNumber = Number(weekPart)

    // Luxon can construct a DateTime from an ISO week calendar:
    // weekday 1 = Monday.
    const monday = DateTime.fromObject(
        { weekYear, weekNumber, weekday: 1 },
        { zone: tz },
    )

    if (!monday.isValid) {
        throw new Error(`Could not resolve periodKey "${periodKey}" — invalid ISO week`)
    }

    const sunday = monday.plus({ days: 6 })

    // Verify round-trip: the resolved dates should map back to the same periodKey.
    const resolvedKey = `${monday.weekYear}-W${String(monday.weekNumber).padStart(2, "0")}`
    if (resolvedKey !== periodKey) {
        throw new Error(
            `Period key mismatch: requested "${periodKey}" but resolved to "${resolvedKey}"`,
        )
    }

    return {
        key: periodKey,
        start: monday.toISODate(),
        end: sunday.toISODate(),
        timezone: tz,
    }
}

/**
 * Determine the most recently completed full Monday–Sunday week
 * relative to a given instant and timezone.
 *
 * @param {Date|DateTime} [now]  defaults to current time
 * @param {string} timezone      IANA timezone
 * @returns {{ key: string, start: string, end: string, timezone: string }}
 */
export function resolveLastCompletedWeek(now, timezone) {
    const tz = resolveAnalyticsTimezone(timezone, "UTC")
    const today = DateTime.isDateTime(now)
        ? now.setZone(tz).startOf("day")
        : DateTime.fromJSDate(now || new Date(), { zone: tz }).startOf("day")

    // today.weekday: 1=Mon … 7=Sun.
    // The most recently completed Sunday is exactly `today.weekday` days
    // before today (0 if today is Sunday → the previous Sunday).
    const sunday = today.minus({ days: today.weekday })
    const monday = sunday.minus({ days: 6 })

    const key = `${monday.weekYear}-W${String(monday.weekNumber).padStart(2, "0")}`

    return {
        key,
        start: monday.toISODate(),
        end: sunday.toISODate(),
        timezone: tz,
    }
}

/**
 * Determine the current in-progress week for a given instant.
 *
 * @param {Date|DateTime} [now]  defaults to current time
 * @param {string} timezone      IANA timezone
 * @returns {{ key: string, start: string, end: string, dataThrough: string, timezone: string }}
 */
export function resolveCurrentWeek(now, timezone) {
    const tz = resolveAnalyticsTimezone(timezone, "UTC")
    const zonedNow = DateTime.isDateTime(now)
        ? now.setZone(tz)
        : DateTime.fromJSDate(now || new Date(), { zone: tz })
    const today = zonedNow.startOf("day")

    // Monday of the current ISO week.
    const monday = today.minus({ days: today.weekday - 1 })
    const sunday = monday.plus({ days: 6 })

    const key = `${monday.weekYear}-W${String(monday.weekNumber).padStart(2, "0")}`

    return {
        key,
        start: monday.toISODate(),
        end: sunday.toISODate(),
        dataThrough: zonedNow.toISO(),
        timezone: tz,
    }
}

/**
 * Return periodKeys for the last N completed weeks (newest first).
 *
 * @param {Date|DateTime} [now]
 * @param {string} timezone
 * @param {number} [count=4]
 * @returns {Array<{ key: string, start: string, end: string, timezone: string }>}
 */
export function resolveCompletedWeeks(now, timezone, count = 4) {
    const tz = resolveAnalyticsTimezone(timezone, "UTC")
    const last = resolveLastCompletedWeek(now, tz)
    const monday = DateTime.fromISO(last.start, { zone: tz })

    const weeks = []
    for (let i = 0; i < count; i++) {
        const m = monday.minus({ weeks: i })
        const s = m.plus({ days: 6 })
        weeks.push({
            key: `${m.weekYear}-W${String(m.weekNumber).padStart(2, "0")}`,
            start: m.toISODate(),
            end: s.toISODate(),
            timezone: tz,
        })
    }
    return weeks
}

/**
 * Return the previous period for a given period — used for comparison.
 *
 * @param {{ start: string, end: string, timezone: string }} period
 * @returns {{ start: string, end: string }}
 */
export function resolvePreviousPeriod(period) {
    const tz = period.timezone || "UTC"
    const start = DateTime.fromISO(period.start, { zone: tz })
    const end = DateTime.fromISO(period.end, { zone: tz })
    const days = Math.round(end.diff(start, "days").days) + 1
    const prevEnd = start.minus({ days: 1 })
    const prevStart = prevEnd.minus({ days: days - 1 })
    return {
        start: prevStart.toISODate(),
        end: prevEnd.toISODate(),
    }
}

/**
 * Validate that a snapshot's period matches the expected parent period.
 * Throws if there is any mismatch.
 *
 * @param {Object} snapshotPeriod   — { key, start, end }
 * @param {Object} expectedPeriod   — { key, start, end }
 * @throws {Error} on mismatch
 */
export function assertPeriodIntegrity(snapshotPeriod, expectedPeriod) {
    const mismatches = []
    if (snapshotPeriod.key !== expectedPeriod.key) {
        mismatches.push(`key: snapshot="${snapshotPeriod.key}" expected="${expectedPeriod.key}"`)
    }
    if (snapshotPeriod.start !== expectedPeriod.start) {
        mismatches.push(`start: snapshot="${snapshotPeriod.start}" expected="${expectedPeriod.start}"`)
    }
    if (snapshotPeriod.end !== expectedPeriod.end) {
        mismatches.push(`end: snapshot="${snapshotPeriod.end}" expected="${expectedPeriod.end}"`)
    }
    if (mismatches.length > 0) {
        throw new Error(
            `Period integrity violation — snapshot/report period mismatch: ${mismatches.join(", ")}`,
        )
    }
}
