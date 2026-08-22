import WeeklyAnalystReport, {
    WEEKLY_SNAPSHOT_VERSION,
    WEEKLY_INSIGHT_ENGINE_VERSION,
    GENERATION_STATUSES,
} from "../models/WeeklyAnalystReport.js"

/**
 * findLatestReport(businessId)
 * Returns the most recent report for the given business, sorted by
 * periodStart DESC.  Returns null when no report exists.
 */
export async function findLatestReport(businessId, { model = WeeklyAnalystReport } = {}) {
    const query = model.findOne({ businessId }).sort({ periodStart: -1 }).lean()
    return typeof query?.lean === "function" ? query.lean() : query
}

/**
 * findReport(businessId, periodKey)
 * Returns the canonical report for (businessId, periodKey) or null.
 */
export async function findReport(businessId, periodKey, { model = WeeklyAnalystReport } = {}) {
    const query = model.findOne({ businessId, periodKey }).lean()
    return typeof query?.lean === "function" ? query.lean() : query
}

/**
 * listReportHistory(businessId, { limit = 20 })
 * Returns summary rows ordered newest period first.
 * Does NOT return analyticsSnapshot or generatedReport payloads.
 */
export async function listReportHistory(businessId, { limit = 20, model = WeeklyAnalystReport } = {}) {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 52)
    const rows = await model
        .find(
            { businessId },
            "periodKey periodStart periodEnd generationStatus generatedAt emailStatus",
        )
        .sort({ periodStart: -1 })
        .limit(safeLimit)
        .lean()
    return rows.map((row) => ({
        periodKey: row.periodKey,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        generationStatus: row.generationStatus,
        generatedAt: row.generatedAt,
        hasReport: row.generationStatus === "completed",
    }))
}

/**
 * upsertSnapshotAndInsights({
 *   businessId, period, snapshot, insights
 * })
 *
 * Idempotent upsert keyed on (businessId, periodKey).  Safe to call
 * repeatedly — does not create duplicates.
 *
 * Stores:
 *   generationStatus = "snapshot_ready"
 *   analyticsSnapshot  = snapshot
 *   deterministicInsights = insights
 *
 * Returns the upserted document (lean).
 */
export async function upsertSnapshotAndInsights({
    businessId,
    period,
    snapshot,
    insights,
    model = WeeklyAnalystReport,
}) {
    const result = await model.findOneAndUpdate(
        { businessId, periodKey: period.key },
        {
            $set: {
                businessId,
                periodKey: period.key,
                periodStart: period.start,
                periodEnd: period.end,
                previousPeriodStart: period.previousStart,
                previousPeriodEnd: period.previousEnd,
                timezone: period.timezone,
                snapshotVersion: WEEKLY_SNAPSHOT_VERSION,
                analyticsSnapshot: snapshot,
                insightEngineVersion: WEEKLY_INSIGHT_ENGINE_VERSION,
                deterministicInsights: insights,
                generationStatus: "snapshot_ready",
                generatedAt: null,
                failureCode: null,
                failureMessage: null,
                failedAt: null,
            },
            $setOnInsert: {
                modelProvider: null,
                modelVersion: null,
                promptVersion: null,
                generatedReport: null,
                emailStatus: "not_sent",
            },
        },
        {
            new: true,
            upsert: true,
            setDefaultsOnInsert: true,
            runValidators: true,
        },
    )
    return result?.toObject ? result.toObject() : result
}

/**
 * markGenerating(businessId, periodKey)
 * Transition: snapshot_ready → generating.
 */
export async function markGenerating(businessId, periodKey, { model = WeeklyAnalystReport } = {}) {
    return model.findOneAndUpdate(
        { businessId, periodKey, generationStatus: "snapshot_ready" },
        { $set: { generationStatus: "generating" } },
        { new: true },
    ).lean()
}

/**
 * markCompleted(businessId, periodKey, { generatedReport, modelProvider, modelVersion, promptVersion })
 * Transition: generating → completed.
 */
export async function markCompleted(businessId, periodKey, {
    generatedReport,
    modelProvider = null,
    modelVersion = null,
    promptVersion = null,
    model = WeeklyAnalystReport,
} = {}) {
    return model.findOneAndUpdate(
        { businessId, periodKey, generationStatus: "generating" },
        {
            $set: {
                generationStatus: "completed",
                generatedAt: new Date(),
                generatedReport,
                modelProvider,
                modelVersion,
                promptVersion,
                failureCode: null,
                failureMessage: null,
                failedAt: null,
            },
        },
        { new: true },
    ).lean()
}

/**
 * markFailed(businessId, periodKey, { code, message })
 * Transition: generating → failed.  Stores failure metadata only.
 */
export async function markFailed(businessId, periodKey, {
    code = "generation_failed",
    message = null,
    model = WeeklyAnalystReport,
} = {}) {
    return model.findOneAndUpdate(
        { businessId, periodKey, generationStatus: "generating" },
        {
            $set: {
                generationStatus: "failed",
                failedAt: new Date(),
                failureCode: String(code).slice(0, 100),
                failureMessage: String(message || "").slice(0, 500),
            },
        },
        { new: true },
    ).lean()
}

export default {
    findLatestReport,
    findReport,
    listReportHistory,
    upsertSnapshotAndInsights,
    markGenerating,
    markCompleted,
    markFailed,
}