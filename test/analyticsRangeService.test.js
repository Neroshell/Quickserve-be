import assert from "node:assert/strict"
import test from "node:test"
import {
    AnalyticsRangeError,
    DEFAULT_ANALYTICS_TIMEZONE,
    resolveAnalyticsDomainRanges,
    resolveAnalyticsRange,
    resolveAnalyticsTimezone,
    toAnalyticsDomainRangeContract,
    toAnalyticsRangeContract,
} from "../src/services/analytics/analyticsRangeService.js"

const timezone = "Europe/Berlin"
const now = new Date("2026-07-28T10:00:00.000Z")

function iso(value) {
    return value.toISOString()
}

test("analytics ranges use the tenant timezone and return ISO contract boundaries", () => {
    const range = resolveAnalyticsRange({
        preset: "today",
        now,
        timezone,
    })

    assert.equal(range.timezone, timezone)
    assert.equal(range.from, "2026-07-28")
    assert.equal(range.to, "2026-07-28")
    assert.equal(iso(range.startUtc), "2026-07-28T00:00:00.000Z")
    assert.equal(
        iso(range.endUtcExclusive),
        "2026-07-29T00:00:00.000Z"
    )
    assert.deepEqual(toAnalyticsRangeContract(range), {
        preset: "today",
        from: "2026-07-28",
        to: "2026-07-28",
        timezone,
        startUtc: "2026-07-28T00:00:00.000Z",
        endUtcExclusive: "2026-07-29T00:00:00.000Z",
        comparison: {
            from: "2026-07-27",
            to: "2026-07-27",
            startUtc: "2026-07-27T00:00:00.000Z",
            endUtcExclusive: "2026-07-28T00:00:00.000Z",
        },
    })
})

test("invalid or missing tenant timezones use the safe UTC fallback", () => {
    assert.equal(
        resolveAnalyticsTimezone("Not/A_Timezone"),
        DEFAULT_ANALYTICS_TIMEZONE
    )
    assert.equal(
        resolveAnalyticsTimezone(""),
        DEFAULT_ANALYTICS_TIMEZONE
    )

    const range = resolveAnalyticsRange({
        preset: "today",
        now,
        timezone: "Not/A_Timezone",
    })
    assert.equal(range.timezone, "UTC")
    assert.equal(iso(range.startUtc), "2026-07-28T02:00:00.000Z")
})

test("today and yesterday comparisons are the immediately preceding business day", () => {
    const today = resolveAnalyticsRange({
        preset: "today",
        now,
        timezone,
    })
    const yesterday = resolveAnalyticsRange({
        preset: "yesterday",
        now,
        timezone,
    })

    assert.deepEqual(
        [today.from, today.to, today.comparison.from, today.comparison.to],
        ["2026-07-28", "2026-07-28", "2026-07-27", "2026-07-27"]
    )
    assert.deepEqual(
        [
            yesterday.from,
            yesterday.to,
            yesterday.comparison.from,
            yesterday.comparison.to,
        ],
        ["2026-07-27", "2026-07-27", "2026-07-26", "2026-07-26"]
    )
})

test("7days returns current and immediately preceding seven local business days", () => {
    const range = resolveAnalyticsRange({
        preset: "7days",
        now,
        timezone,
    })

    assert.deepEqual(
        [range.from, range.to, range.comparison.from, range.comparison.to],
        ["2026-07-22", "2026-07-28", "2026-07-15", "2026-07-21"]
    )
})

test("thisMonth compares the equivalent elapsed portion of the previous month", () => {
    const range = resolveAnalyticsRange({
        preset: "thisMonth",
        now,
        timezone,
    })

    assert.deepEqual(
        [range.from, range.to, range.comparison.from, range.comparison.to],
        ["2026-07-01", "2026-07-28", "2026-06-01", "2026-06-28"]
    )
})

test("valid custom range includes both local dates and an equal-length comparison", () => {
    const range = resolveAnalyticsRange({
        preset: "custom",
        from: "2026-07-10",
        to: "2026-07-12",
        now,
        timezone,
    })

    assert.deepEqual(
        [range.from, range.to, range.comparison.from, range.comparison.to],
        ["2026-07-10", "2026-07-12", "2026-07-07", "2026-07-09"]
    )
})

test("custom rejects missing, malformed, reversed, and excessive ranges", () => {
    assert.throws(
        () =>
            resolveAnalyticsRange({
                preset: "custom",
                from: "2026-07-10",
                timezone,
            }),
        AnalyticsRangeError
    )
    assert.throws(
        () =>
            resolveAnalyticsRange({
                preset: "custom",
                from: "2026-02-30",
                to: "2026-03-01",
                timezone,
            }),
        /valid local ISO date/
    )
    assert.throws(
        () =>
            resolveAnalyticsRange({
                preset: "custom",
                from: "2026-07-12",
                to: "2026-07-10",
                timezone,
            }),
        /on or before/
    )
    assert.throws(
        () =>
            resolveAnalyticsRange({
                preset: "custom",
                from: "2025-01-01",
                to: "2026-01-02",
                timezone,
            }),
        /cannot exceed 366 days/
    )
})

test("spring-forward boundaries preserve local business dates without assuming 24 hours", () => {
    const range = resolveAnalyticsRange({
        preset: "custom",
        from: "2026-03-29",
        to: "2026-03-29",
        timezone,
    })

    assert.equal(range.from, "2026-03-29")
    assert.equal(range.to, "2026-03-29")
    assert.equal(iso(range.startUtc), "2026-03-29T01:00:00.000Z")
    assert.equal(
        iso(range.endUtcExclusive),
        "2026-03-30T00:00:00.000Z"
    )
})

test("fall-back boundaries preserve the tenant-local 02:00 rollover", () => {
    const range = resolveAnalyticsRange({
        preset: "custom",
        from: "2026-10-25",
        to: "2026-10-25",
        timezone,
    })

    assert.equal(range.from, "2026-10-25")
    assert.equal(range.to, "2026-10-25")
    // The first valid 02:00 occurrence is used on the repeated clock hour,
    // yielding the full 25-hour local business day.
    assert.equal(iso(range.startUtc), "2026-10-25T00:00:00.000Z")
    assert.equal(
        iso(range.endUtcExclusive),
        "2026-10-26T01:00:00.000Z"
    )
})

test("domain ranges keep lodging on calendar midnight instead of the food rollover", () => {
    const domainRanges = resolveAnalyticsDomainRanges({
        preset: "today",
        now: new Date("2026-07-28T23:30:00.000Z"),
        timezone,
    })

    assert.equal(
        domainRanges.foodOperationalRange.from,
        "2026-07-28"
    )
    assert.equal(
        domainRanges.lodgingCalendarRange.from,
        "2026-07-29"
    )
    assert.equal(
        iso(domainRanges.foodOperationalRange.startUtc),
        "2026-07-28T00:00:00.000Z"
    )
    assert.equal(
        iso(domainRanges.lodgingCalendarRange.startUtc),
        "2026-07-28T22:00:00.000Z"
    )

    const contract =
        toAnalyticsDomainRangeContract(domainRanges)
    assert.equal(
        contract.foodOperationalRange.startUtc,
        "2026-07-28T00:00:00.000Z"
    )
    assert.equal(
        contract.lodgingCalendarRange.startUtc,
        "2026-07-28T22:00:00.000Z"
    )
})

test("lodging calendar boundaries remain local midnights across DST", () => {
    const { lodgingCalendarRange } =
        resolveAnalyticsDomainRanges({
            preset: "custom",
            from: "2026-03-29",
            to: "2026-03-29",
            timezone,
        })

    assert.equal(
        iso(lodgingCalendarRange.startUtc),
        "2026-03-28T23:00:00.000Z"
    )
    assert.equal(
        iso(lodgingCalendarRange.endUtcExclusive),
        "2026-03-29T22:00:00.000Z"
    )
    assert.equal(
        lodgingCalendarRange.comparison.from,
        "2026-03-28"
    )
})
