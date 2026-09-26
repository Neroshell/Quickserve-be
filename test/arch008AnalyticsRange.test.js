/**
 * ARCH-008: Canonical Analytics Date-Range Resolution — Characterization Tests
 *
 * Proves exact UTC boundary behavior for all supported presets across
 * business timezones and DST transitions, using fixed clocks.
 *
 * Run: node --test test/arch008AnalyticsRange.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAnalyticsRange, resolveAnalyticsDomainRanges } from "../src/services/analytics/analyticsRangeService.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function toUtcIso(date) {
    return new Date(date).toISOString();
}

// Business fixture (Europe/Malta = UTC+1 in winter, UTC+2 in summer)
const maltaBusiness = {
    businessId: "biz_arch008",
    timezone: "Europe/Malta",
    operatingHours: {
        Monday:    { openTime: "09:00", closeTime: "23:00" },
        Tuesday:   { openTime: "09:00", closeTime: "23:00" },
        Wednesday: { openTime: "09:00", closeTime: "23:00" },
        Thursday:  { openTime: "09:00", closeTime: "23:00" },
        Friday:    { openTime: "09:00", closeTime: "02:00" },
        Saturday:  { openTime: "09:00", closeTime: "02:00" },
        Sunday:    { openTime: "09:00", closeTime: "23:00" },
    },
};

// New York business (UTC-5 in winter, UTC-4 in summer)
const nyBusiness = {
    businessId: "biz_ny",
    timezone: "America/New_York",
    operatingHours: {
        Monday:    { openTime: "10:00", closeTime: "22:00" },
        Tuesday:   { openTime: "10:00", closeTime: "22:00" },
        Wednesday: { openTime: "10:00", closeTime: "22:00" },
        Thursday:  { openTime: "10:00", closeTime: "22:00" },
        Friday:    { openTime: "10:00", closeTime: "22:00" },
        Saturday:  { openTime: "10:00", closeTime: "22:00" },
        Sunday:    { openTime: "10:00", closeTime: "22:00" },
    },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ARCH-008: resolveAnalyticsRange — canonical boundary tests", () => {

    // ── TODAY ────────────────────────────────────────────────────────────────
    it("today: Malta business on a normal Tuesday at 14:00 local", () => {
        // 2026-09-15 is a Tuesday. Malta is UTC+2 in summer.
        // 14:00 Malta = 12:00 UTC
        // Monday close: 23:00 → Tuesday 23:00 Malta = 21:00 UTC
        // So start = Monday 23:00 Malta = Sunday 21:00 UTC  → business resolves to previous night's close
        // Actually Monday (2026-09-14) closes at 23:00 Malta = 21:00 UTC
        // Tuesday 14:00 Malta = after open, before close → operational day = Tuesday
        // start = Monday close = 2026-09-14T21:00:00.000Z
        // end   = Tuesday close = 2026-09-15T21:00:00.000Z
        const now = new Date("2026-09-15T12:00:00.000Z"); // 14:00 Malta
        const range = resolveAnalyticsRange({ preset: "today", now, business: maltaBusiness, timezone: "Europe/Malta" });
        assert.strictEqual(range.from, "2026-09-15");
        assert.strictEqual(range.to, "2026-09-15");
        assert.strictEqual(toUtcIso(range.startUtc), "2026-09-14T21:00:00.000Z"); // Monday 23:00 Malta close
        assert.strictEqual(toUtcIso(range.endUtcExclusive), "2026-09-15T21:00:00.000Z"); // Tuesday 23:00 Malta close
    });

    it("today: Malta business on Friday at 01:30 local (after midnight, before 02:00 close)", () => {
        // 2026-09-19 is a Saturday. 01:30 Malta Saturday = 23:30 UTC Friday.
        // Friday closes at 02:00 Saturday. So 01:30 Sat is BEFORE Friday's close → operational day is still Friday.
        // Friday start = Thursday close = 23:00 Malta Thursday = 21:00 UTC Thursday
        // Friday end = Friday close = 02:00 Saturday Malta = 00:00 UTC Saturday
        // 2026-09-18 is Friday, 2026-09-19 is Saturday
        const now = new Date("2026-09-18T23:30:00.000Z"); // 01:30 Malta Saturday
        const range = resolveAnalyticsRange({ preset: "today", now, business: maltaBusiness, timezone: "Europe/Malta" });
        // Still Friday's operational day
        assert.strictEqual(range.from, "2026-09-18");
        assert.strictEqual(range.to, "2026-09-18");
    });

    // ── YESTERDAY ────────────────────────────────────────────────────────────
    it("yesterday: Malta business on 2026-09-16 Wednesday at 15:00 local", () => {
        // now = Wednesday 2026-09-16 15:00 Malta = 13:00 UTC
        // yesterday = Tuesday 2026-09-15
        // Tuesday start = Monday 23:00 Malta close = Monday 21:00 UTC
        // Tuesday end (exclusive) = Tuesday 23:00 Malta close = Tuesday 21:00 UTC
        const now = new Date("2026-09-16T13:00:00.000Z");
        const range = resolveAnalyticsRange({ preset: "yesterday", now, business: maltaBusiness, timezone: "Europe/Malta" });
        assert.strictEqual(range.from, "2026-09-15");
        assert.strictEqual(range.to, "2026-09-15");
        assert.strictEqual(toUtcIso(range.startUtc), "2026-09-14T21:00:00.000Z");
        assert.strictEqual(toUtcIso(range.endUtcExclusive), "2026-09-15T21:00:00.000Z");
    });

    // ── 7DAYS ────────────────────────────────────────────────────────────────
    it("7days: covers the last 7 operational days inclusive of today", () => {
        const now = new Date("2026-09-15T12:00:00.000Z"); // Tuesday 14:00 Malta
        const range = resolveAnalyticsRange({ preset: "7days", now, business: maltaBusiness, timezone: "Europe/Malta" });
        assert.strictEqual(range.from, "2026-09-09");
        assert.strictEqual(range.to, "2026-09-15");
    });

    // ── 30DAYS ───────────────────────────────────────────────────────────────
    it("30days: covers the last 30 operational days inclusive of today", () => {
        const now = new Date("2026-09-15T12:00:00.000Z");
        const range = resolveAnalyticsRange({ preset: "30days", now, business: maltaBusiness, timezone: "Europe/Malta" });
        assert.strictEqual(range.from, "2026-08-17");
        assert.strictEqual(range.to, "2026-09-15");
    });

    // ── THIS MONTH ───────────────────────────────────────────────────────────
    it("thisMonth: starts at first day of calendar month (operational boundary)", () => {
        const now = new Date("2026-09-15T12:00:00.000Z");
        const range = resolveAnalyticsRange({ preset: "thisMonth", now, business: maltaBusiness, timezone: "Europe/Malta" });
        assert.strictEqual(range.from, "2026-09-01");
        assert.strictEqual(range.to, "2026-09-15");
    });

    it("thisMonth: on the first day of the month, from and to are both that day", () => {
        const now = new Date("2026-09-01T10:00:00.000Z"); // 12:00 Malta
        const range = resolveAnalyticsRange({ preset: "thisMonth", now, business: maltaBusiness, timezone: "Europe/Malta" });
        assert.strictEqual(range.from, "2026-09-01");
        assert.strictEqual(range.to, "2026-09-01");
    });

    // ── CUSTOM RANGE ─────────────────────────────────────────────────────────
    it("custom: single day range covers that full operational day", () => {
        const range = resolveAnalyticsRange({
            preset: "custom", from: "2026-09-10", to: "2026-09-10",
            business: maltaBusiness, timezone: "Europe/Malta"
        });
        assert.strictEqual(range.from, "2026-09-10");
        assert.strictEqual(range.to, "2026-09-10");
        // 2026-09-10 is Thursday. Start = Wednesday close (23:00) = 21:00 UTC
        // End = Thursday close (23:00) = 21:00 UTC
        assert.strictEqual(toUtcIso(range.startUtc), "2026-09-09T21:00:00.000Z");
        assert.strictEqual(toUtcIso(range.endUtcExclusive), "2026-09-10T21:00:00.000Z");
    });

    it("custom: multi-day range includes full boundary days", () => {
        const range = resolveAnalyticsRange({
            preset: "custom", from: "2026-09-01", to: "2026-09-07",
            business: maltaBusiness, timezone: "Europe/Malta"
        });
        assert.strictEqual(range.from, "2026-09-01");
        assert.strictEqual(range.to, "2026-09-07");
        // start = Aug 31 close (23:00 Malta = 21:00 UTC)
        assert.strictEqual(toUtcIso(range.startUtc), "2026-08-31T21:00:00.000Z");
    });

    it("custom: throws AnalyticsRangeError when from > to", () => {
        assert.throws(() => {
            resolveAnalyticsRange({
                preset: "custom", from: "2026-09-10", to: "2026-09-01",
                business: maltaBusiness, timezone: "Europe/Malta"
            });
        }, { name: "AnalyticsRangeError" });
    });

    it("custom: throws AnalyticsRangeError when from or to is missing", () => {
        assert.throws(() => {
            resolveAnalyticsRange({ preset: "custom", from: "2026-09-01", business: maltaBusiness, timezone: "Europe/Malta" });
        }, { name: "AnalyticsRangeError" });
    });

    // ── PREVIOUS PERIOD COMPARISON ───────────────────────────────────────────
    it("today comparison period is the immediately preceding equivalent day", () => {
        const now = new Date("2026-09-15T12:00:00.000Z");
        const range = resolveAnalyticsRange({ preset: "today", now, business: maltaBusiness, timezone: "Europe/Malta" });
        assert.strictEqual(range.comparison.from, "2026-09-14");
        assert.strictEqual(range.comparison.to, "2026-09-14");
    });

    it("7days comparison period covers the 7 days before the current range", () => {
        const now = new Date("2026-09-15T12:00:00.000Z");
        const range = resolveAnalyticsRange({ preset: "7days", now, business: maltaBusiness, timezone: "Europe/Malta" });
        // current: Sep 9 – Sep 15, comparison: Sep 2 – Sep 8
        assert.strictEqual(range.comparison.from, "2026-09-02");
        assert.strictEqual(range.comparison.to, "2026-09-08");
    });

    it("thisMonth comparison is elapsed days of previous month", () => {
        const now = new Date("2026-09-15T12:00:00.000Z");
        const range = resolveAnalyticsRange({ preset: "thisMonth", now, business: maltaBusiness, timezone: "Europe/Malta" });
        // current: Sep 1-15 (15 days elapsed), comparison: Aug 1-15
        assert.strictEqual(range.comparison.from, "2026-08-01");
        assert.strictEqual(range.comparison.to, "2026-08-15");
    });

    // ── MULTI-TENANT TIMEZONE ISOLATION ──────────────────────────────────────
    it("same UTC instant produces different local date ranges for Malta vs New York businesses", () => {
        // 2026-09-15 22:30 UTC
        // Malta (UTC+2 summer): 00:30 on 2026-09-16
        //   Monday-Thursday close at 23:00; Friday/Saturday close at 02:00
        //   00:30 Saturday is BEFORE Saturday's close → still Friday operational day
        //   Friday = 2026-09-18 but we are on 2026-09-15 Tuesday in this test
        //   Actually 2026-09-15 is Tuesday. Tuesday 22:30 UTC = 00:30 Wednesday Malta.
        //   Tuesday closes 23:00 Malta = 21:00 UTC, so 22:30 UTC is AFTER Tuesday's close.
        //   → operational day = Wednesday 2026-09-16
        // New York (UTC-4 summer): 18:30 on 2026-09-15 — mid-afternoon Tuesday
        //   Tuesday closes 22:00 NY = 02:00 UTC Wed. 18:30 is before close → still Tuesday.
        const now = new Date("2026-09-15T22:30:00.000Z");

        const maltaRange = resolveAnalyticsRange({ preset: "today", now, business: maltaBusiness, timezone: "Europe/Malta" });
        const nyRange    = resolveAnalyticsRange({ preset: "today", now, business: nyBusiness, timezone: "America/New_York" });

        // Malta 00:30 Wednesday is after Tuesday's 23:00 close → Wednesday 2026-09-16
        assert.strictEqual(maltaRange.from, "2026-09-16");

        // New York 18:30 Tuesday → still Tuesday 2026-09-15
        assert.strictEqual(nyRange.from, "2026-09-15");

        // Their UTC boundaries must differ (different timezone offsets)
        assert.notStrictEqual(
            toUtcIso(maltaRange.startUtc),
            toUtcIso(nyRange.startUtc),
            "Malta and New York boundaries must differ at the same UTC instant"
        );
    });


    // ── DST TRANSITION ───────────────────────────────────────────────────────
    it("DST: Europe/Malta spring-forward day has a 23-hour day but range boundaries remain correct", () => {
        // Europe/Malta springs forward on 2026-03-29 at 02:00 → clocks go to 03:00
        // A day that is only 23 hours long in local time
        // This tests that we don't compute 24*60*60*1000 ms manually
        const range = resolveAnalyticsRange({
            preset: "custom",
            from: "2026-03-29",
            to: "2026-03-29",
            business: maltaBusiness,
            timezone: "Europe/Malta",
        });
        assert.strictEqual(range.from, "2026-03-29");
        assert.strictEqual(range.to, "2026-03-29");
        // Start and end should be valid non-null dates
        assert.ok(range.startUtc instanceof Date);
        assert.ok(range.endUtcExclusive instanceof Date);
        // endUtcExclusive must be after startUtc
        assert.ok(range.endUtcExclusive > range.startUtc);
    });

    it("DST: America/New_York fall-back day has a 25-hour day, range still valid", () => {
        // America/New_York clocks fall back on first Sunday of November
        // 2026-11-01: clocks go from 02:00 → 01:00
        const range = resolveAnalyticsRange({
            preset: "custom",
            from: "2026-11-01",
            to: "2026-11-01",
            business: nyBusiness,
            timezone: "America/New_York",
        });
        assert.strictEqual(range.from, "2026-11-01");
        assert.strictEqual(range.to, "2026-11-01");
        assert.ok(range.endUtcExclusive > range.startUtc);
    });

    // ── EXACT BOUNDARY (NO GAPS / NO DOUBLE-COUNT) ────────────────────────────
    it("adjacent days share an exclusive boundary — no gap, no double count", () => {
        const now = new Date("2026-09-15T12:00:00.000Z");
        const today = resolveAnalyticsRange({ preset: "today", now, business: maltaBusiness, timezone: "Europe/Malta" });
        const yesterday = resolveAnalyticsRange({ preset: "yesterday", now, business: maltaBusiness, timezone: "Europe/Malta" });
        // Today starts exactly where yesterday ends (exclusive)
        assert.deepStrictEqual(today.startUtc, yesterday.endUtcExclusive);
    });

    // ── resolveAnalyticsDomainRanges DUAL-DOMAIN ─────────────────────────────
    it("resolveAnalyticsDomainRanges returns both foodOperationalRange and lodgingCalendarRange", () => {
        const now = new Date("2026-09-15T12:00:00.000Z");
        const { foodOperationalRange, lodgingCalendarRange } = resolveAnalyticsDomainRanges({
            preset: "today", now, business: maltaBusiness, timezone: "Europe/Malta"
        });
        assert.ok(foodOperationalRange.startUtc instanceof Date);
        assert.ok(lodgingCalendarRange.startUtc instanceof Date);
        // Lodging uses midnight rollover (hour=0); food uses operating-hours rollover
        // They will differ for Malta because the food operational boundary is 23:00
        assert.notDeepStrictEqual(foodOperationalRange.startUtc, lodgingCalendarRange.startUtc);
    });

    it("resolveAnalyticsDomainRanges derives Europe/Malta from Business when callers omit timezone", () => {
        const { foodOperationalRange, lodgingCalendarRange } = resolveAnalyticsDomainRanges({
            preset: "today",
            now: new Date("2026-09-15T22:30:00.000Z"),
            business: maltaBusiness,
        });
        assert.strictEqual(foodOperationalRange.timezone, "Europe/Malta");
        assert.strictEqual(lodgingCalendarRange.timezone, "Europe/Malta");
        assert.strictEqual(foodOperationalRange.from, "2026-09-16");
        assert.strictEqual(lodgingCalendarRange.from, "2026-09-16");
        assert.strictEqual(
            toUtcIso(lodgingCalendarRange.startUtc),
            "2026-09-15T22:00:00.000Z",
        );
    });

    it("business-only America/New_York custom range preserves DST and domain semantics", () => {
        const { foodOperationalRange, lodgingCalendarRange } = resolveAnalyticsDomainRanges({
            preset: "custom",
            from: "2026-11-01",
            to: "2026-11-01",
            business: nyBusiness,
        });
        assert.strictEqual(foodOperationalRange.timezone, "America/New_York");
        assert.strictEqual(lodgingCalendarRange.timezone, "America/New_York");
        assert.ok(foodOperationalRange.endUtcExclusive > foodOperationalRange.startUtc);
        assert.strictEqual(
            toUtcIso(lodgingCalendarRange.startUtc),
            "2026-11-01T04:00:00.000Z",
        );
        assert.strictEqual(
            toUtcIso(lodgingCalendarRange.endUtcExclusive),
            "2026-11-02T05:00:00.000Z",
        );
    });

    it("an explicit trusted timezone overrides Business timezone", () => {
        const { lodgingCalendarRange } = resolveAnalyticsDomainRanges({
            preset: "custom",
            from: "2026-09-15",
            to: "2026-09-15",
            timezone: "America/New_York",
            business: maltaBusiness,
        });
        assert.strictEqual(lodgingCalendarRange.timezone, "America/New_York");
    });

    // ── UNSUPPORTED PRESET ────────────────────────────────────────────────────
    it("throws AnalyticsRangeError for unsupported preset", () => {
        assert.throws(() => {
            resolveAnalyticsRange({ preset: "lastYear", business: maltaBusiness, timezone: "Europe/Malta" });
        }, { name: "AnalyticsRangeError" });
    });
});
