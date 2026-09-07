import Feedback from "../../models/Feedback.js"

export const FEEDBACK_ANALYST_LIMITS = Object.freeze({
    minimumBreakdownSample: 3,
    maximumOrderTypes: 5,
})

const SUPPORTED_ORDER_TYPES = new Set(["dine-in", "takeout", "delivery"])

function integer(value) {
    const number = Number(value || 0)
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0
}

function round(value, digits = 1) {
    const number = Number(value)
    if (!Number.isFinite(number)) return null
    const multiplier = 10 ** digits
    return Math.round(number * multiplier) / multiplier
}

function rate(count, total) {
    return total > 0 ? round((count / total) * 100, 1) : null
}

function normalizePeriodSummary(row = {}) {
    const reviewCount = integer(row.reviewCount)
    const lowRatingCount = integer(row.lowRatingCount)
    const highRatingCount = integer(row.highRatingCount)

    return {
        reviewCount,
        averageRating: reviewCount > 0 ? round(row.averageRating, 1) : null,
        ratingDistribution: {
            1: integer(row.rating1),
            2: integer(row.rating2),
            3: integer(row.rating3),
            4: integer(row.rating4),
            5: integer(row.rating5),
        },
        lowRatingCount,
        highRatingCount,
        writtenCommentCount: integer(row.writtenCommentCount),
        lowRatingRatePercent: rate(lowRatingCount, reviewCount),
        highRatingRatePercent: rate(highRatingCount, reviewCount),
        csatPercent: rate(highRatingCount, reviewCount),
    }
}

async function aggregatePeriod(feedbackModel, businessId, start, end) {
    const rows = await feedbackModel.aggregate([
        {
            $match: {
                businessId,
                createdAt: { $gte: start, $lt: end },
            },
        },
        {
            $group: {
                _id: null,
                reviewCount: { $sum: 1 },
                averageRating: { $avg: "$overallRating" },
                rating1: { $sum: { $cond: [{ $eq: ["$overallRating", 1] }, 1, 0] } },
                rating2: { $sum: { $cond: [{ $eq: ["$overallRating", 2] }, 1, 0] } },
                rating3: { $sum: { $cond: [{ $eq: ["$overallRating", 3] }, 1, 0] } },
                rating4: { $sum: { $cond: [{ $eq: ["$overallRating", 4] }, 1, 0] } },
                rating5: { $sum: { $cond: [{ $eq: ["$overallRating", 5] }, 1, 0] } },
                lowRatingCount: { $sum: { $cond: [{ $lte: ["$overallRating", 2] }, 1, 0] } },
                highRatingCount: { $sum: { $cond: [{ $gte: ["$overallRating", 4] }, 1, 0] } },
                writtenCommentCount: {
                    $sum: {
                        $cond: [
                            { $gt: [{ $strLenCP: { $ifNull: ["$comment", ""] } }, 0] },
                            1,
                            0,
                        ],
                    },
                },
            },
        },
    ])

    return normalizePeriodSummary(rows?.[0])
}

async function aggregateOrderTypes(feedbackModel, businessId, start, end) {
    const rows = await feedbackModel.aggregate([
        {
            $match: {
                businessId,
                createdAt: { $gte: start, $lt: end },
                orderType: { $in: [...SUPPORTED_ORDER_TYPES] },
            },
        },
        {
            $group: {
                _id: "$orderType",
                reviewCount: { $sum: 1 },
                averageRating: { $avg: "$overallRating" },
            },
        },
        {
            $match: {
                reviewCount: { $gte: FEEDBACK_ANALYST_LIMITS.minimumBreakdownSample },
            },
        },
        { $sort: { reviewCount: -1, _id: 1 } },
        { $limit: FEEDBACK_ANALYST_LIMITS.maximumOrderTypes },
    ])

    return (rows || [])
        .filter((row) =>
            SUPPORTED_ORDER_TYPES.has(row?._id) &&
            integer(row.reviewCount) >= FEEDBACK_ANALYST_LIMITS.minimumBreakdownSample
        )
        .slice(0, FEEDBACK_ANALYST_LIMITS.maximumOrderTypes)
        .map((row) => ({
            orderType: row._id,
            reviewCount: integer(row.reviewCount),
            averageRating: round(row.averageRating, 1),
        }))
}

/**
 * Build compact, period-aligned Feedback evidence without exposing comments,
 * guest identifiers, order identifiers, or other raw review records.
 */
export async function buildFeedbackAnalystSummary({
    businessId,
    analyticsRange,
    feedbackModel = Feedback,
}) {
    if (!businessId) throw new TypeError("businessId is required")
    if (!analyticsRange?.startUtc || !analyticsRange?.endUtcExclusive) {
        throw new TypeError("analyticsRange is required")
    }

    const comparison = analyticsRange.comparison || {}
    const [current, previous, orderTypeBreakdown] = await Promise.all([
        aggregatePeriod(
            feedbackModel,
            businessId,
            analyticsRange.startUtc,
            analyticsRange.endUtcExclusive,
        ),
        aggregatePeriod(
            feedbackModel,
            businessId,
            comparison.startUtc,
            comparison.endUtcExclusive,
        ),
        aggregateOrderTypes(
            feedbackModel,
            businessId,
            analyticsRange.startUtc,
            analyticsRange.endUtcExclusive,
        ),
    ])

    current.orderTypeBreakdown = orderTypeBreakdown

    return {
        current,
        previous: {
            reviewCount: previous.reviewCount,
            averageRating: previous.averageRating,
            lowRatingCount: previous.lowRatingCount,
            highRatingCount: previous.highRatingCount,
            lowRatingRatePercent: previous.lowRatingRatePercent,
            highRatingRatePercent: previous.highRatingRatePercent,
            csatPercent: previous.csatPercent,
        },
        comparison: {
            ratingDelta:
                current.averageRating !== null && previous.averageRating !== null
                    ? round(current.averageRating - previous.averageRating, 1)
                    : null,
            reviewCountDelta: current.reviewCount - previous.reviewCount,
            lowRatingRateDeltaPoints:
                current.lowRatingRatePercent !== null &&
                previous.lowRatingRatePercent !== null
                    ? round(
                        current.lowRatingRatePercent - previous.lowRatingRatePercent,
                        1,
                    )
                    : null,
            highRatingRateDeltaPoints:
                current.highRatingRatePercent !== null &&
                previous.highRatingRatePercent !== null
                    ? round(
                        current.highRatingRatePercent - previous.highRatingRatePercent,
                        1,
                    )
                    : null,
            csatDeltaPoints:
                current.csatPercent !== null && previous.csatPercent !== null
                    ? round(current.csatPercent - previous.csatPercent, 1)
                    : null,
        },
    }
}

export default buildFeedbackAnalystSummary
