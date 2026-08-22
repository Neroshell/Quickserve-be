import {
    findLatestReport,
    findReport,
    listReportHistory,
} from "../services/weeklyAnalystReportService.js"

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

export async function getLatestReport(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const report = await findLatestReport(businessId)

        if (!report) {
            return res.json({ report: null, status: "not_generated" })
        }

        return res.json({ report: toReportDto(report), status: "available" })
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