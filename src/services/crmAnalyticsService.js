import { DateTime } from "luxon"
import Business from "../models/Business.js"
import CrmOrderProjectionLedger from "../models/CrmOrderProjectionLedger.js"
import GuestProfile from "../models/GuestProfile.js"
import GuestVisit from "../models/GuestVisit.js"
import CustomerJourney from "../models/CustomerJourney.js"
import {
    CRM_ANALYTICS_CUSTOMER_LIMIT,
    CRM_DORMANT_DAYS,
    CRM_REENGAGEMENT_DAYS,
} from "../constants/crm.js"
import {
    enumerateAnalyticsLocalDates,
    resolveAnalyticsRange,
    toAnalyticsRangeContract,
} from "./analytics/analyticsRangeService.js"

export class CrmAnalyticsServiceError extends Error {
    constructor(message, statusCode = 500) {
        super(message)
        this.name = "CrmAnalyticsServiceError"
        this.statusCode = statusCode
    }
}

function integer(value) {
    const number = Number(value || 0)
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0
}

function safeRatio(numerator, denominator, precision = 2) {
    if (denominator <= 0) return 0
    const factor = 10 ** precision
    return Math.round((numerator / denominator) * factor) / factor
}

function percentage(numerator, denominator) {
    return safeRatio(numerator * 100, denominator, 1)
}

function getCurrency(business) {
    const currency = String(business?.currency || "").trim().toUpperCase()
    if (!currency) {
        throw new CrmAnalyticsServiceError(
            "Business currency is not configured",
        )
    }
    return currency
}

async function loadBusiness(businessModel, businessId) {
    const query = businessModel.findOne(
        { businessId },
        "businessId timezone currency operatingHours",
    )
    return typeof query?.lean === "function" ? query.lean() : query
}

/**
 * CRM metric semantics:
 *
 * - A canonical visit is one GuestVisit document with at least one paid order.
 *   GuestVisit's unique businessId + email + visitDate key ensures multiple
 *   paid orders by the same customer on one operational day still count once.
 * - A new customer has their first-ever canonical CRM visit in the selected
 *   period.
 * - A returning customer has at least one selected-period visit after their
 *   first-ever canonical CRM visit. A customer can therefore be both new and
 *   returning when they are acquired and revisit on a later operational day
 *   inside the same range.
 * - Total customers, consent, recency, lifetime ranking, and re-engagement are
 *   current/lifetime GuestProfile facts. Visits, active customers, new and
 *   returning customers, and CRM revenue are selected-period facts.
 */
export function buildCrmVisitActivityPipeline({
    businessId,
    from,
    to,
    collectionName = "guestvisits",
}) {
    return [
        {
            $match: {
                businessId,
                visitDate: { $gte: from, $lte: to },
                "paidOrderIds.0": { $exists: true },
            },
        },
        {
            $lookup: {
                from: collectionName,
                let: { guestEmail: "$email" },
                pipeline: [
                    {
                        $match: {
                            businessId,
                            "paidOrderIds.0": { $exists: true },
                            $expr: {
                                $eq: ["$email", "$$guestEmail"],
                            },
                        },
                    },
                    { $sort: { visitDate: 1, _id: 1 } },
                    { $limit: 1 },
                    { $project: { _id: 0, visitDate: 1 } },
                ],
                as: "firstCanonicalVisit",
            },
        },
        { $unwind: "$firstCanonicalVisit" },
        {
            $set: {
                isNewVisit: {
                    $eq: ["$visitDate", "$firstCanonicalVisit.visitDate"],
                },
            },
        },
        {
            $group: {
                _id: "$email",
                visitCount: { $sum: 1 },
                hasNewVisit: {
                    $max: { $cond: ["$isNewVisit", 1, 0] },
                },
                hasReturningVisit: {
                    $max: { $cond: ["$isNewVisit", 0, 1] },
                },
                activity: {
                    $push: {
                        date: "$visitDate",
                        isNew: "$isNewVisit",
                    },
                },
            },
        },
        {
            $facet: {
                summary: [
                    {
                        $group: {
                            _id: null,
                            activeCustomers: { $sum: 1 },
                            newCustomers: { $sum: "$hasNewVisit" },
                            returningCustomers: {
                                $sum: "$hasReturningVisit",
                            },
                            totalVisits: { $sum: "$visitCount" },
                        },
                    },
                ],
                daily: [
                    { $unwind: "$activity" },
                    {
                        $group: {
                            _id: "$activity.date",
                            newCustomers: {
                                $sum: {
                                    $cond: ["$activity.isNew", 1, 0],
                                },
                            },
                            returningCustomers: {
                                $sum: {
                                    $cond: ["$activity.isNew", 0, 1],
                                },
                            },
                            visits: { $sum: 1 },
                        },
                    },
                    { $sort: { _id: 1 } },
                ],
            },
        },
    ]
}

export function buildCrmRevenuePipeline({ businessId, from, to }) {
    return [
        {
            $match: {
                businessId,
                status: "completed",
                localVisitDate: { $gte: from, $lte: to },
            },
        },
        {
            $group: {
                _id: null,
                customerRevenueCents: { $sum: "$spendCents" },
                paidOrderCount: { $sum: 1 },
                customerEmails: { $addToSet: "$email" },
            },
        },
        {
            $project: {
                _id: 0,
                customerRevenueCents: 1,
                paidOrderCount: 1,
                revenueCustomerCount: { $size: "$customerEmails" },
            },
        },
    ]
}

export function buildCrmCustomerJourneyPipeline({ businessId, from, to }) {
    return [
        {
            $match: {
                businessId,
                localBusinessDate: { $gte: from, $lte: to },
            },
        },
        {
            $facet: {
                summary: [
                    {
                        $group: {
                            _id: null,
                            totalOrderingVisitors: { $sum: 1 },
                            visitorsWhoOrdered: {
                                $sum: { $cond: [{ $gt: ["$orderCount", 0] }, 1, 0] },
                            },
                            visitorsWithoutOrder: {
                                $sum: { $cond: [{ $eq: ["$orderCount", 0] }, 1, 0] },
                            },
                            identifiedVisitors: {
                                $sum: { $cond: [{ $ne: ["$guestProfileId", null] }, 1, 0] },
                            },
                            anonymousOrderingVisitors: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $gt: ["$orderCount", 0] },
                                                { $eq: ["$guestProfileId", null] },
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            identifiedOrderingVisitors: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $gt: ["$orderCount", 0] },
                                                { $ne: ["$guestProfileId", null] },
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            customerJourneyRevenueCents: { $sum: "$totalSpendCents" },
                        },
                    },
                ],
                daily: [
                    {
                        $group: {
                            _id: "$localBusinessDate",
                            orderingVisitors: { $sum: 1 },
                            visitorsWhoOrdered: {
                                $sum: { $cond: [{ $gt: ["$orderCount", 0] }, 1, 0] },
                            },
                            identifiedVisitors: {
                                $sum: { $cond: [{ $ne: ["$guestProfileId", null] }, 1, 0] },
                            },
                            anonymousOrderingVisitors: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $gt: ["$orderCount", 0] },
                                                { $eq: ["$guestProfileId", null] },
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            journeyRevenueCents: { $sum: "$totalSpendCents" },
                        },
                    },
                    { $sort: { _id: 1 } },
                ],
            },
        },
    ]
}

export function buildCrmProfileSummaryPipeline({
    businessId,
    reEngagementCutoff,
    dormantCutoff,
}) {
    return [
        { $match: { businessId, guestStatus: "customer" } },
        {
            $group: {
                _id: null,
                totalCustomers: { $sum: 1 },
                marketingConsentCount: {
                    $sum: { $cond: ["$marketingConsent", 1, 0] },
                },
                recentCustomerCount: {
                    $sum: {
                        $cond: [
                            { $gte: ["$lastVisitAt", reEngagementCutoff] },
                            1,
                            0,
                        ],
                    },
                },
                reEngagementCustomerCount: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $ne: ["$lastVisitAt", null] },
                                    {
                                        $lt: [
                                            "$lastVisitAt",
                                            reEngagementCutoff,
                                        ],
                                    },
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
                dormantCustomerCount: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $ne: ["$lastVisitAt", null] },
                                    { $lt: ["$lastVisitAt", dormantCutoff] },
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
            },
        },
    ]
}

export function chooseCrmTrendBucket({ from, to, timezone }) {
    const start = DateTime.fromISO(from, { zone: timezone }).startOf("day")
    const end = DateTime.fromISO(to, { zone: timezone }).startOf("day")
    const inclusiveDays = Math.round(end.diff(start, "days").days) + 1
    if (inclusiveDays <= 31) return "day"
    if (inclusiveDays <= 120) return "week"
    return "month"
}

function trendBucketStart(date, bucket, timezone) {
    const localDate = DateTime.fromISO(date, { zone: timezone })
    if (bucket === "week") return localDate.startOf("week").toISODate()
    if (bucket === "month") return localDate.startOf("month").toISODate()
    return localDate.toISODate()
}

export function bucketCrmDailyActivity({ rows, from, to, timezone }) {
    const bucket = chooseCrmTrendBucket({ from, to, timezone })
    const buckets = new Map()

    for (const date of enumerateAnalyticsLocalDates({ from, to, timezone })) {
        const key = trendBucketStart(date, bucket, timezone)
        if (!buckets.has(key)) {
            buckets.set(key, {
                date: key,
                newCustomers: 0,
                returningCustomers: 0,
                visits: 0,
            })
        }
    }

    for (const row of rows || []) {
        const date = typeof row?._id === "string" ? row._id : row?.date
        if (!date) continue
        const key = trendBucketStart(date, bucket, timezone)
        const current = buckets.get(key) || {
            date: key,
            newCustomers: 0,
            returningCustomers: 0,
            visits: 0,
        }
        current.newCustomers += integer(row.newCustomers)
        current.returningCustomers += integer(row.returningCustomers)
        current.visits += integer(row.visits)
        buckets.set(key, current)
    }

    return {
        bucket,
        points: [...buckets.values()].sort((left, right) =>
            left.date.localeCompare(right.date),
        ),
    }
}

export function bucketCrmJourneyDailyActivity({ rows, from, to, timezone }) {
    const bucket = chooseCrmTrendBucket({ from, to, timezone })
    const buckets = new Map()

    for (const date of enumerateAnalyticsLocalDates({ from, to, timezone })) {
        const key = trendBucketStart(date, bucket, timezone)
        if (!buckets.has(key)) {
            buckets.set(key, {
                date: key,
                orderingVisitors: 0,
                visitorsWhoOrdered: 0,
                identifiedVisitors: 0,
                anonymousOrderingVisitors: 0,
                journeyRevenueCents: 0,
            })
        }
    }

    for (const row of rows || []) {
        const date = typeof row?._id === "string" ? row._id : row?.date
        if (!date) continue
        const key = trendBucketStart(date, bucket, timezone)
        const current = buckets.get(key) || {
            date: key,
            orderingVisitors: 0,
            visitorsWhoOrdered: 0,
            identifiedVisitors: 0,
            anonymousOrderingVisitors: 0,
            journeyRevenueCents: 0,
        }
        current.orderingVisitors += integer(row.orderingVisitors)
        current.visitorsWhoOrdered += integer(row.visitorsWhoOrdered)
        current.identifiedVisitors += integer(row.identifiedVisitors)
        current.anonymousOrderingVisitors += integer(row.anonymousOrderingVisitors)
        current.journeyRevenueCents += integer(row.journeyRevenueCents)
        buckets.set(key, current)
    }

    return {
        bucket,
        points: [...buckets.values()].sort((left, right) =>
            left.date.localeCompare(right.date),
        ),
    }
}

function cutoffDateForThreshold(currentBusinessDate, days, timezone) {
    return DateTime.fromISO(currentBusinessDate, { zone: timezone })
        .minus({ days: days - 1 })
        .toISODate()
}

function resolveActivityCutoff({
    business,
    timezone,
    currentBusinessDate,
    days,
    generatedAt,
    rangeResolver,
}) {
    const date = cutoffDateForThreshold(
        currentBusinessDate,
        days,
        timezone,
    )
    return rangeResolver({
        preset: "custom",
        from: date,
        to: date,
        timezone,
        now: generatedAt,
        business,
    }).startUtc
}

function normalizeCustomer(row) {
    return {
        guestId: String(row?._id || row?.guestId || ""),
        name: row?.name || "",
        email: row?.email || "",
        visitCount: integer(row?.visitCount),
        orderCount: integer(row?.paidOrderCount ?? row?.orderCount),
        totalSpendCents: integer(row?.totalSpendCents),
        lastVisitAt: row?.lastVisitAt
            ? new Date(row.lastVisitAt).toISOString()
            : null,
        marketingConsent: row?.marketingConsent === true,
    }
}

async function readCustomerList({ model, filter, sort, limit }) {
    const query = model
        .find(
            filter,
            "_id name email visitCount paidOrderCount orderCount totalSpendCents lastVisitAt marketingConsent",
        )
        .sort(sort)
        .limit(limit)
    const rows = typeof query?.lean === "function" ? await query.lean() : await query
    return (rows || []).map(normalizeCustomer)
}

export function createCrmAnalyticsService({
    businessModel = Business,
    guestProfileModel = GuestProfile,
    guestVisitModel = GuestVisit,
    ledgerModel = CrmOrderProjectionLedger,
    customerJourneyModel = CustomerJourney,
    rangeResolver = resolveAnalyticsRange,
    rangeSerializer = toAnalyticsRangeContract,
    clock = () => new Date(),
    customerLimit = CRM_ANALYTICS_CUSTOMER_LIMIT,
} = {}) {
    return async function crmAnalyticsService({
        businessId,
        range = "30days",
        from,
        to,
    }) {
        const business = await loadBusiness(businessModel, businessId)
        if (!business) {
            throw new CrmAnalyticsServiceError("Business not found", 404)
        }

        const generatedAt = clock()
        const analyticsRange = rangeResolver({
            preset: range,
            from,
            to,
            timezone: business.timezone,
            now: generatedAt,
            business,
        })
        const currentDayRange = rangeResolver({
            preset: "today",
            timezone: business.timezone,
            now: generatedAt,
            business,
        })
        const reEngagementCutoff = resolveActivityCutoff({
            business,
            timezone: currentDayRange.timezone,
            currentBusinessDate: currentDayRange.from,
            days: CRM_REENGAGEMENT_DAYS,
            generatedAt,
            rangeResolver,
        })
        const dormantCutoff = resolveActivityCutoff({
            business,
            timezone: currentDayRange.timezone,
            currentBusinessDate: currentDayRange.from,
            days: CRM_DORMANT_DAYS,
            generatedAt,
            rangeResolver,
        })
        const visitCollectionName =
            guestVisitModel.collection?.name || "guestvisits"

        const topCustomerFilter = {
            businessId,
            guestStatus: "customer",
        }
        const reEngagementFilter = {
            businessId,
            guestStatus: "customer",
            lastVisitAt: {
                $ne: null,
                $lt: reEngagementCutoff,
            },
        }

        const [
            visitResult,
            revenueResult,
            profileResult,
            topCustomers,
            reEngagementCustomers,
            journeyResult,
            earliestJourney,
        ] = await Promise.all([
            guestVisitModel.aggregate(
                buildCrmVisitActivityPipeline({
                    businessId,
                    from: analyticsRange.from,
                    to: analyticsRange.to,
                    collectionName: visitCollectionName,
                }),
            ),
            ledgerModel.aggregate(
                buildCrmRevenuePipeline({
                    businessId,
                    from: analyticsRange.from,
                    to: analyticsRange.to,
                }),
            ),
            guestProfileModel.aggregate(
                buildCrmProfileSummaryPipeline({
                    businessId,
                    reEngagementCutoff,
                    dormantCutoff,
                }),
            ),
            readCustomerList({
                model: guestProfileModel,
                filter: topCustomerFilter,
                sort: { totalSpendCents: -1, _id: -1 },
                limit: customerLimit,
            }),
            readCustomerList({
                model: guestProfileModel,
                filter: reEngagementFilter,
                sort: { lastVisitAt: -1, _id: -1 },
                limit: customerLimit,
            }),
            typeof customerJourneyModel?.aggregate === "function"
                ? customerJourneyModel.aggregate(
                    buildCrmCustomerJourneyPipeline({
                        businessId,
                        from: analyticsRange.from,
                        to: analyticsRange.to,
                    }),
                )
                : Promise.resolve([]),
            typeof customerJourneyModel?.findOne === "function"
                ? customerJourneyModel
                    .findOne(
                        { businessId },
                        "firstSeenAt localBusinessDate",
                    )
                    .sort({ firstSeenAt: 1 })
                    .lean()
                : Promise.resolve(null),
        ])

        const visitFacet = visitResult?.[0] || {}
        const visitSummary = visitFacet.summary?.[0] || {}
        const revenueSummary = revenueResult?.[0] || {}
        const profileSummary = profileResult?.[0] || {}
        const activeCustomers = integer(visitSummary.activeCustomers)
        const newCustomers = integer(visitSummary.newCustomers)
        const returningCustomers = integer(
            visitSummary.returningCustomers,
        )
        const totalVisits = integer(visitSummary.totalVisits)
        const totalCustomers = integer(profileSummary.totalCustomers)
        const customerRevenueCents = integer(
            revenueSummary.customerRevenueCents,
        )
        const marketingConsentCount = integer(
            profileSummary.marketingConsentCount,
        )
        const recentCustomerCount = integer(
            profileSummary.recentCustomerCount,
        )
        const reEngagementCustomerCount = integer(
            profileSummary.reEngagementCustomerCount,
        )
        const dormantCustomerCount = integer(
            profileSummary.dormantCustomerCount,
        )
        const trend = bucketCrmDailyActivity({
            rows: visitFacet.daily || [],
            from: analyticsRange.from,
            to: analyticsRange.to,
            timezone: analyticsRange.timezone,
        })

        // Process CustomerJourney Acquisition Funnel
        const journeyFacet = journeyResult?.[0] || {}
        const journeySummary = journeyFacet.summary?.[0] || {}
        const journeyDailyRows = journeyFacet.daily || []

        const totalOrderingVisitors = integer(journeySummary.totalOrderingVisitors)
        const visitorsWhoOrdered = integer(journeySummary.visitorsWhoOrdered)
        const visitorsWithoutOrder = integer(journeySummary.visitorsWithoutOrder)
        const identifiedVisitors = integer(journeySummary.identifiedVisitors)
        const anonymousOrderingVisitors = integer(journeySummary.anonymousOrderingVisitors)
        const identifiedOrderingVisitors = integer(journeySummary.identifiedOrderingVisitors)
        const customerJourneyRevenueCents = integer(journeySummary.customerJourneyRevenueCents)

        const visitToOrderConversionRate = percentage(visitorsWhoOrdered, totalOrderingVisitors)
        const orderToIdentifiedConversionRate = percentage(identifiedOrderingVisitors, visitorsWhoOrdered)
        const visitToIdentifiedConversionRate = percentage(identifiedVisitors, totalOrderingVisitors)

        // Generate deterministic Insights
        const insights = []
        if (totalOrderingVisitors === 0) {
            insights.push("Customer journey tracking is active. As ordering visitors browse and place orders, conversion insights will appear here.")
        } else {
            if (visitToOrderConversionRate < 50) {
                insights.push(`${visitorsWithoutOrder.toLocaleString()} ordering visitors did not place an order during this period.`)
            } else {
                insights.push("Strong visit-to-order conversion rate during this period.")
            }

            if (orderToIdentifiedConversionRate < 50) {
                insights.push(`${anonymousOrderingVisitors.toLocaleString()} ordering visitors remained anonymous without becoming known CRM customers.`)
            } else {
                insights.push("High percentage of ordering visitors are becoming known CRM customers.")
            }
        }

        const customerJourneyTrend = bucketCrmJourneyDailyActivity({
            rows: journeyDailyRows,
            from: analyticsRange.from,
            to: analyticsRange.to,
            timezone: analyticsRange.timezone,
        })

        // Tracking availability is tenant-local and derived from the first
        // durable journey recorded for this business. A selected range before
        // that operational date is historical/untracked; a later range with
        // zero journeys is a genuine tracked zero.
        const trackingAvailableDate = earliestJourney?.localBusinessDate || null
        const hasTrackingData = totalOrderingVisitors > 0 || Boolean(
            trackingAvailableDate && analyticsRange.to >= trackingAvailableDate,
        )
        const trackingAvailableFrom = earliestJourney?.firstSeenAt
            ? new Date(earliestJourney.firstSeenAt).toISOString()
            : null

        return {
            contractVersion: 1,
            range: rangeSerializer(analyticsRange),
            currency: getCurrency(business),
            generatedAt: generatedAt.toISOString(),
            metricScopes: {
                totalCustomers: "lifetimeCurrentState",
                newCustomers: "selectedPeriod",
                returningCustomers: "selectedPeriod",
                repeatCustomerRatePercent: "selectedPeriod",
                totalVisits: "selectedPeriod",
                averageVisitsPerCustomer: "selectedPeriod",
                customerRevenueCents: "selectedPeriod",
                averageSpendPerCustomerCents: "selectedPeriod",
                averageSpendPerVisitCents: "selectedPeriod",
                marketingConsentCount: "lifetimeCurrentState",
                marketingConsentPercent: "lifetimeCurrentState",
                reEngagementCustomerCount: "lifetimeCurrentState",
                dormantCustomerCount: "lifetimeCurrentState",
            },
            overview: {
                totalCustomers,
                activeCustomers,
                newCustomers,
                returningCustomers,
                repeatCustomerRatePercent: percentage(
                    returningCustomers,
                    activeCustomers,
                ),
                totalVisits,
                averageVisitsPerCustomer: safeRatio(
                    totalVisits,
                    activeCustomers,
                ),
                customerRevenueCents,
                paidOrderCount: integer(revenueSummary.paidOrderCount),
                averageSpendPerCustomerCents: activeCustomers > 0
                    ? Math.round(customerRevenueCents / activeCustomers)
                    : 0,
                averageSpendPerVisitCents: totalVisits > 0
                    ? Math.round(customerRevenueCents / totalVisits)
                    : 0,
                marketingConsentCount,
                marketingConsentPercent: percentage(
                    marketingConsentCount,
                    totalCustomers,
                ),
                recentCustomerCount,
                reEngagementCustomerCount,
                dormantCustomerCount,
            },
            customerActivity: {
                bucket: trend.bucket,
                points: trend.points.map((point) => ({
                    date: point.date,
                    newCustomers: point.newCustomers,
                    returningCustomers: point.returningCustomers,
                })),
            },
            visits: {
                bucket: trend.bucket,
                points: trend.points.map((point) => ({
                    date: point.date,
                    visits: point.visits,
                })),
            },
            segments: [
                {
                    id: "new",
                    label: "New",
                    count: newCustomers,
                    scope: "selectedPeriod",
                },
                {
                    id: "returning",
                    label: "Returning",
                    count: returningCustomers,
                    scope: "selectedPeriod",
                },
                {
                    id: "recent",
                    label: `Recent (under ${CRM_REENGAGEMENT_DAYS} days)`,
                    count: recentCustomerCount,
                    scope: "lifetimeCurrentState",
                },
                {
                    id: "reEngagement",
                    label: `Needs re-engagement (${CRM_REENGAGEMENT_DAYS}+ days)`,
                    count: reEngagementCustomerCount,
                    scope: "lifetimeCurrentState",
                },
                {
                    id: "dormant",
                    label: `Dormant (${CRM_DORMANT_DAYS}+ days)`,
                    count: dormantCustomerCount,
                    scope: "lifetimeCurrentState",
                },
                {
                    id: "marketingOptIn",
                    label: "Marketing opt-in",
                    count: marketingConsentCount,
                    scope: "lifetimeCurrentState",
                },
            ],
            topCustomers,
            reEngagement: {
                thresholdDays: CRM_REENGAGEMENT_DAYS,
                dormantThresholdDays: CRM_DORMANT_DAYS,
                customerCount: reEngagementCustomerCount,
                dormantCustomerCount,
                customers: reEngagementCustomers,
            },
            customerJourney: {
                totalOrderingVisitors,
                visitorsWhoOrdered,
                visitorsWithoutOrder,
                identifiedVisitors,
                anonymousOrderingVisitors,
                identifiedOrderingVisitors,
                visitToOrderConversionRate,
                orderToIdentifiedConversionRate,
                visitToIdentifiedConversionRate,
                customerJourneyRevenueCents,
                trend: customerJourneyTrend.points,
                insights,
                tracking: {
                    hasTrackingData,
                    availableFrom: trackingAvailableFrom,
                },
            },
        }
    }
}

export const crmAnalyticsService = createCrmAnalyticsService()
