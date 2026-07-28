import assert from "node:assert/strict"
import test from "node:test"
import { DateTime } from "luxon"
import {
    AnalyticsRangeError,
    resolveAnalyticsRange,
} from "../src/services/analytics/analyticsRangeService.js"

const timezone = "Europe/Malta"
const now = DateTime.fromISO("2026-07-28T12:30:00", { zone: timezone })

function iso(date) {
    return DateTime.fromJSDate(date).setZone(timezone).toISO({
        suppressMilliseconds: true,
    })
}

test("today preserves the current 02:00 business-day range", () => {
    const range = resolveAnalyticsRange({ preset: "today", now, timezone })

    assert.equal(range.preset, "today")
    assert.equal(iso(range.startDate), "2026-07-28T02:00:00+02:00")
    assert.equal(iso(range.endDate), "2026-07-29T02:00:00+02:00")
})

test("yesterday preserves the prior business-day range", () => {
    const range = resolveAnalyticsRange({
        preset: "yesterday",
        now,
        timezone,
    })

    assert.equal(iso(range.startDate), "2026-07-27T02:00:00+02:00")
    assert.equal(iso(range.endDate), "2026-07-28T02:00:00+02:00")
})

test("7days includes six prior business days plus today", () => {
    const range = resolveAnalyticsRange({ preset: "7days", now, timezone })

    assert.equal(iso(range.startDate), "2026-07-22T02:00:00+02:00")
    assert.equal(iso(range.endDate), "2026-07-29T02:00:00+02:00")
})

test("thisMonth starts at the current calendar month rollover", () => {
    const range = resolveAnalyticsRange({
        preset: "thisMonth",
        now,
        timezone,
    })

    assert.equal(iso(range.startDate), "2026-07-01T02:00:00+02:00")
    assert.equal(iso(range.endDate), "2026-07-29T02:00:00+02:00")
})

test("custom includes both requested local dates", () => {
    const range = resolveAnalyticsRange({
        preset: "custom",
        from: "2026-07-10",
        to: "2026-07-12",
        now,
        timezone,
    })

    assert.equal(iso(range.startDate), "2026-07-10T02:00:00+02:00")
    assert.equal(iso(range.endDate), "2026-07-13T02:00:00+02:00")
})

test("custom rejects missing, malformed, and reversed ranges", () => {
    assert.throws(
        () => resolveAnalyticsRange({ preset: "custom", from: "2026-07-10" }),
        (error) =>
            error instanceof AnalyticsRangeError &&
            error.message === "Missing 'from' or 'to' for custom range"
    )
    assert.throws(
        () =>
            resolveAnalyticsRange({
                preset: "custom",
                from: "not-a-date",
                to: "2026-07-10",
            }),
        /Invalid date format/
    )
    assert.throws(
        () =>
            resolveAnalyticsRange({
                preset: "custom",
                from: "2026-07-11",
                to: "2026-07-10",
            }),
        /from.*before.*to/
    )
})
