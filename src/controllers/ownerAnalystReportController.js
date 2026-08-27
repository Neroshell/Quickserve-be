import {
    findLatestReport,
    findReport,
    listReportHistory,
} from "../services/weeklyAnalystReportService.js"
import {
    resolveLastCompletedWeek,
    resolveCurrentWeek,
    resolvePreviousPeriod,
} from "../services/weeklyPeriodResolver.js"
import { resolveAnalyticsTimezone } from "../services/analytics/analyticsRangeService.js"
import { generateWeeklySnapshot } from "../services/analytics/weeklyAnalystSnapshotService.js"
import { generateWeeklyInsights } from "../services/analytics/weeklyInsightService.js"
import Business from "../models/Business.js"

const VALID_PERIOD_KEY = /^[0-9]{4}-W[0-9]{2}$/

function toReportDto(doc) {
    if (!doc) return null
    return {
        period: {
            key: doc.periodKey,
            start: doc.periodStart,
            end: doc.periodEnd,
            previousStart: doc.previousPeriodStart,
            previousEnd: doc.previousPeriodEnd,
            timezone: doc.timezone,
        },
        status: doc.generationStatus,
        snapshotVersion: doc.snapshotVersion,
        insightEngineVersion: doc.insightEngineVersion,
        deterministicInsights: doc.deterministicInsights,
        generatedReport: doc.generatedReport || null,
        generatedAt: doc.generatedAt,
        reportVersion: doc.reportVersion || null,
    }
}

/**
 * GET /owner/ai-business-analyst/latest
 *
 * Returns the latest FINAL report plus temporal metadata so the frontend
 * knows whether the latest expected week is available or missing.
 */
export async function getLatestReport(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        // Resolve business timezone
        const biz = await Business.findOne(
            { businessId },
            "timezone",
        ).lean()
        const tz = resolveAnalyticsTimezone(biz?.timezone, "UTC")

        const now = new Date()
        const currentWeek = resolveCurrentWeek(now, tz)
        const latestCompletedWeek = resolveLastCompletedWeek(now, tz)

        const report = await findLatestReport(businessId)

        // Determine if the latest completed week's final report exists
        const isLatestFinalMissing = !report ||
            report.periodKey !== latestCompletedWeek.key ||
            report.generationStatus !== "completed"

        return res.json({
            report: report ? toReportDto(report) : null,
            status: report ? "available" : "not_generated",
            businessTimezone: tz,
            currentWeek: {
                periodKey: currentWeek.key,
                periodStart: currentWeek.start,
                periodEnd: currentWeek.end,
                dataThrough: currentWeek.dataThrough,
                isLive: true,
            },
            latestCompletedWeek: {
                periodKey: latestCompletedWeek.key,
                periodStart: latestCompletedWeek.start,
                periodEnd: latestCompletedWeek.end,
            },
            expectedFinalPeriodKey: latestCompletedWeek.key,
            isLatestFinalMissing,
        })
    } catch (err) {
        console.error("[getLatestReport]", err)
        return res.status(500).json({ error: "Failed to retrieve latest report" })
    }
}

export async function getReportHistory(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const limit = Math.min(
            Math.max(1, parseInt(req.query.limit, 10) || 20),
            52,
        )

        const rows = await listReportHistory(businessId, { limit })

        return res.json({ reports: rows })
    } catch (err) {
        console.error("[getReportHistory]", err)
        return res.status(500).json({ error: "Failed to retrieve report history" })
    }
}

export async function getReportByPeriod(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const { periodKey } = req.params

        if (!periodKey || !VALID_PERIOD_KEY.test(periodKey)) {
            return res.status(400).json({
                error: "Invalid period key",
                expected: "YYYY-Www (e.g. 2026-W33)",
            })
        }

        const report = await findReport(businessId, periodKey)

        if (!report) {
            return res.status(404).json({
                error: "Report not found",
                periodKey,
            })
        }

        return res.json({ report: toReportDto(report) })
    } catch (err) {
        console.error("[getReportByPeriod]", err)
        return res.status(500).json({ error: "Failed to retrieve report" })
    }
}

/**
 * GET /owner/ai-business-analyst/current-week
 *
 * Returns a live, non-persisted snapshot of the current in-progress week.
 * Includes deterministic insights but NOT a generated Mayor AI narrative.
 *
 * Comparison is against the equivalent elapsed duration of the previous week
 * (e.g. Mon→Thu 20:53 vs previous Mon→Thu 20:53).
 */
export async function getCurrentWeekSnapshot(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const now = new Date()

        // Generate live snapshot for current partial week
        const snapshot = await generateWeeklySnapshot({
            businessId,
            isPartialWeek: true,
            now,
        })

        // Generate deterministic insights (rule-based, no AI)
        const insights = generateWeeklyInsights(snapshot)

        return res.json({
            isLive: true,
            dataThrough: now.toISOString(),
            period: snapshot.period,
            business: snapshot.business,
            sales: snapshot.sales,
            operations: snapshot.operations,
            menu: snapshot.menu,
            service: snapshot.service,
            servicePoints: snapshot.servicePoints,
            staff: snapshot.staff,
            customers: snapshot.customers,
            feedback: snapshot.feedback,
            reservations: snapshot.reservations,
            tipsPayments: snapshot.tipsPayments,
            deterministicInsights: insights,
        })
    } catch (err) {
        console.error("[getCurrentWeekSnapshot]", err)
        return res.status(500).json({ error: "Failed to generate current-week snapshot" })
    }
}