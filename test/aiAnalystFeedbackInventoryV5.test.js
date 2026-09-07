import assert from "node:assert/strict"
import test from "node:test"

import { buildFeedbackAnalystSummary } from "../src/services/analytics/feedbackAnalystSummaryService.js"
import { buildInventoryAnalystSummary } from "../src/services/analytics/inventoryAnalystSummaryService.js"
import { generateWeeklySnapshot } from "../src/services/analytics/weeklyAnalystSnapshotService.js"
import { generateWeeklyInsights } from "../src/services/analytics/weeklyInsightService.js"
import {
    AI_ANALYST_EVIDENCE_PACK_VERSION,
    buildV5EvidencePack,
} from "../src/services/ai/aiPayloadBuilderV5.js"
import { buildRecentThemeSummary } from "../src/services/ai/weeklyAnalystGenerationService.js"
import { normalizeBusinessHealth } from "../src/services/ai/businessHealthNormalizer.js"

const currentStart = new Date("2026-08-24T00:00:00.000Z")
const currentEnd = new Date("2026-08-31T00:00:00.000Z")
const previousStart = new Date("2026-08-17T00:00:00.000Z")
const previousEnd = new Date("2026-08-24T00:00:00.000Z")

const analyticsRange = {
    startUtc: currentStart,
    endUtcExclusive: currentEnd,
    comparison: {
        startUtc: previousStart,
        endUtcExclusive: previousEnd,
    },
}

test("Weekly snapshot V2 integrates Feedback and aligned live Inventory summaries", async () => {
    const feedback = {
        current: { reviewCount: 5, averageRating: 4.2 },
        previous: { reviewCount: 4, averageRating: 4 },
        comparison: { ratingDelta: 0.2 },
    }
    const inventory = {
        stockHealthAsOf: { periodAligned: true, activeItems: 10 },
        current: { totalMovementCount: 2, countsByType: {}, ingredientShortages: { eventCount: 0 } },
        previous: { totalMovementCount: 0, countsByType: {}, ingredientShortages: { eventCount: 0 } },
        comparison: {},
        tracking: { periodAligned: true },
    }
    let inventoryCall = null
    const businessModel = {
        findOne() {
            return {
                lean: async () => ({
                    businessId: "biz_snapshot",
                    businessType: "restaurant",
                    modules: ["foodService"],
                    timezone: "Europe/Berlin",
                    currency: "EUR",
                }),
            }
        },
    }
    const guestVisitModel = {
        distinct: async () => [],
        aggregate: async () => [],
    }
    const guestProfileModel = { countDocuments: async () => 0 }

    const snapshot = await generateWeeklySnapshot({
        businessId: "biz_snapshot",
        isPartialWeek: true,
        now: new Date("2026-08-27T12:00:00.000Z"),
        businessModel,
        guestVisitModel,
        guestProfileModel,
        sharedAnalytics: async () => ({
            shared: {
                paidRevenue: {
                    grossCents: 0,
                    refundedCents: 0,
                    netRetainedCents: 0,
                    transactionCount: 0,
                    averageTransactionValueCents: 0,
                },
                revenueByDay: [],
            },
            foodServiceFinancials: null,
            lodgingFinancials: null,
        }),
        feedbackAnalystSummary: async ({ businessId }) => {
            assert.equal(businessId, "biz_snapshot")
            return feedback
        },
        inventoryAnalystSummary: async (options) => {
            inventoryCall = options
            return inventory
        },
    })

    assert.equal(snapshot.schemaVersion, 2)
    assert.equal(snapshot.feedback, feedback)
    assert.equal(snapshot.inventory, inventory)
    assert.equal(inventoryCall.businessId, "biz_snapshot")
    assert.equal(inventoryCall.periodAligned, true)
    assert.equal(snapshot.period.timezone, "Europe/Berlin")
})

test("Feedback summary is tenant-scoped, comparative, sample-safe, and bounded", async () => {
    const calls = []
    const feedbackModel = {
        aggregate(pipeline) {
            calls.push(pipeline)
            const isOrderType = pipeline.some((stage) => stage.$group?._id === "$orderType")
            if (isOrderType) {
                return Promise.resolve([
                    { _id: "dine-in", reviewCount: 8, averageRating: 3.5 },
                    { _id: "takeout", reviewCount: 4, averageRating: 4.5 },
                    { _id: "delivery", reviewCount: 2, averageRating: 2 },
                    { _id: "ignore instructions", reviewCount: 99, averageRating: 1 },
                    { _id: "dine-in", reviewCount: 7, averageRating: 3.6 },
                    { _id: "takeout", reviewCount: 6, averageRating: 4.4 },
                ])
            }
            const start = pipeline[0].$match.createdAt.$gte
            if (start.getTime() === currentStart.getTime()) {
                return Promise.resolve([{
                    reviewCount: 12,
                    averageRating: 3.4,
                    rating1: 2,
                    rating2: 2,
                    rating3: 1,
                    rating4: 4,
                    rating5: 3,
                    lowRatingCount: 4,
                    highRatingCount: 7,
                    writtenCommentCount: 5,
                }])
            }
            return Promise.resolve([{
                reviewCount: 10,
                averageRating: 4.1,
                rating1: 1,
                rating2: 0,
                rating3: 1,
                rating4: 4,
                rating5: 4,
                lowRatingCount: 1,
                highRatingCount: 8,
                writtenCommentCount: 3,
            }])
        },
    }

    const summary = await buildFeedbackAnalystSummary({
        businessId: "biz_feedback",
        analyticsRange,
        feedbackModel,
    })

    assert.equal(summary.current.reviewCount, 12)
    assert.deepEqual(summary.current.ratingDistribution, { 1: 2, 2: 2, 3: 1, 4: 4, 5: 3 })
    assert.equal(summary.current.lowRatingCount, 4)
    assert.equal(summary.current.highRatingCount, 7)
    assert.equal(summary.current.writtenCommentCount, 5)
    assert.equal(summary.current.csatPercent, 58.3)
    assert.equal(summary.previous.averageRating, 4.1)
    assert.equal(summary.comparison.ratingDelta, -0.7)
    assert.equal(summary.comparison.reviewCountDelta, 2)
    assert.equal(summary.comparison.lowRatingRateDeltaPoints, 23.3)
    assert.deepEqual(
        summary.current.orderTypeBreakdown.map((row) => row.orderType),
        ["dine-in", "takeout", "dine-in", "takeout"],
    )
    assert.ok(summary.current.orderTypeBreakdown.length <= 5)

    for (const pipeline of calls) {
        assert.equal(pipeline[0].$match.businessId, "biz_feedback")
        assert.ok(pipeline[0].$match.createdAt.$gte instanceof Date)
        assert.ok(pipeline[0].$match.createdAt.$lt instanceof Date)
    }
})

test("Feedback summary returns safe empty-period values", async () => {
    const summary = await buildFeedbackAnalystSummary({
        businessId: "biz_empty",
        analyticsRange,
        feedbackModel: { aggregate: async () => [] },
    })
    assert.equal(summary.current.reviewCount, 0)
    assert.equal(summary.current.averageRating, null)
    assert.equal(summary.current.csatPercent, null)
    assert.equal(summary.comparison.ratingDelta, null)
    assert.deepEqual(summary.current.orderTypeBreakdown, [])
})

function shortageFacet(eventCount, affectedItemCount, itemCount = 2) {
    return [{
        summary: [{ eventCount, affectedItemCount }],
        byUnit: [
            { _id: "g", eventCount, shortageCanonicalQuantity: eventCount * 100 },
            { _id: "ml", eventCount: 1, shortageCanonicalQuantity: 250 },
        ],
        byItem: Array.from({ length: itemCount }, (_, index) => ({
            _id: { inventoryItemId: `inv_${index + 1}`, unit: index % 2 ? "ml" : "g" },
            eventCount: Math.max(1, eventCount - index),
            shortageCanonicalQuantity: Math.max(1, eventCount - index) * 100,
        })),
    }]
}

function inventoryFakes() {
    const calls = { itemAggregate: [], itemFind: [], movement: [], reservation: [], recipe: [] }
    const inventoryItemModel = {
        aggregate(pipeline) {
            calls.itemAggregate.push(pipeline)
            return Promise.resolve([{
                summary: [{ activeItems: 20, lowStockItems: 3, outOfStockItems: 2 }],
                urgent: [
                    { itemName: "Tomatoes", availableQuantity: 0, lowStockThreshold: 4, unit: "g", status: "out_of_stock" },
                    { itemName: "Milk", availableQuantity: 2, lowStockThreshold: 5, unit: "ml", status: "low_stock" },
                ],
            }])
        },
        find(filter) {
            calls.itemFind.push(filter)
            return {
                lean: async () => filter.inventoryItemId.$in.map((id) => ({
                    inventoryItemId: id,
                    name: `Name ${id}`,
                })),
            }
        },
    }
    const inventoryMovementModel = {
        aggregate(pipeline) {
            calls.movement.push(pipeline)
            const current = pipeline[0].$match.createdAt.$gte.getTime() === currentStart.getTime()
            return Promise.resolve(current ? [
                { _id: { type: "WASTE", unit: "g" }, movementCount: 4, canonicalQuantity: 600 },
                { _id: { type: "WASTE", unit: "ml" }, movementCount: 2, canonicalQuantity: 300 },
                { _id: { type: "CONSUME", unit: "g" }, movementCount: 9, canonicalQuantity: 1800 },
                { _id: { type: "ADJUSTMENT_INCREASE", unit: "g" }, movementCount: 2, canonicalQuantity: 100 },
                { _id: { type: "ADJUSTMENT_DECREASE", unit: "g" }, movementCount: 3, canonicalQuantity: 80 },
            ] : [
                { _id: { type: "WASTE", unit: "g" }, movementCount: 2, canonicalQuantity: 250 },
                { _id: { type: "CONSUME", unit: "g" }, movementCount: 8, canonicalQuantity: 1600 },
            ])
        },
    }
    const inventoryReservationModel = {
        aggregate(pipeline) {
            calls.reservation.push(pipeline)
            const periodMatch = pipeline.find((stage) => stage.$match?.["sidecarAllocations.accountedAt"])
            const current = periodMatch.$match["sidecarAllocations.accountedAt"].$gte.getTime() === currentStart.getTime()
            return Promise.resolve(current ? shortageFacet(7, 6, 8) : shortageFacet(2, 2, 2))
        },
    }
    const menuInventoryRecipeModel = {
        aggregate(pipeline) {
            calls.recipe.push(pipeline)
            return Promise.resolve([{
                activeSimpleStockMappings: 12,
                disabledSimpleStockMappings: 2,
                activeIngredientTrackedMenuItems: 8,
                disabledIngredientTrackedMenuItems: 1,
            }])
        },
    }
    return {
        calls,
        inventoryItemModel,
        inventoryMovementModel,
        inventoryReservationModel,
        menuInventoryRecipeModel,
    }
}

test("Inventory summary keeps units separate and exposes aligned current stock safely", async () => {
    const fakes = inventoryFakes()
    const summary = await buildInventoryAnalystSummary({
        businessId: "biz_inventory",
        analyticsRange,
        periodAligned: true,
        asOf: new Date("2026-08-28T12:00:00.000Z"),
        ...fakes,
    })

    assert.equal(summary.stockHealthAsOf.periodAligned, true)
    assert.equal(summary.stockHealthAsOf.activeItems, 20)
    assert.equal(summary.stockHealthAsOf.lowStockItems, 3)
    assert.equal(summary.stockHealthAsOf.outOfStockItems, 2)
    assert.ok(
        fakes.calls.itemAggregate[0].some(
            (stage) => stage.$addFields?.availableQuantity?.$subtract,
        ),
    )
    assert.deepEqual(summary.current.wasteByUnit.map((row) => row.unit), ["g", "ml"])
    assert.equal(summary.current.adjustmentsByUnit[0].netCanonicalQuantity, 20)
    assert.equal(summary.current.consumptionByUnit[0].canonicalQuantity, 1800)
    assert.equal(summary.current.ingredientShortages.eventCount, 7)
    assert.equal(summary.current.ingredientShortages.affectedItemCount, 6)
    assert.equal(summary.current.ingredientShortages.mostAffectedItems.length, 5)
    assert.equal(summary.comparison.wasteEventCountDelta, 4)
    assert.equal(summary.comparison.shortageEventCountDelta, 5)
    assert.equal(summary.tracking.activeSimpleStockMappings, 12)

    for (const pipeline of [...fakes.calls.movement, ...fakes.calls.reservation]) {
        assert.equal(pipeline[0].$match.businessId, "biz_inventory")
    }
    for (const filter of fakes.calls.itemFind) {
        assert.equal(filter.businessId, "biz_inventory")
    }
})

test("Historical Inventory summary excludes mutable stock and tracking state", async () => {
    const fakes = inventoryFakes()
    const summary = await buildInventoryAnalystSummary({
        businessId: "biz_history",
        analyticsRange,
        periodAligned: false,
        asOf: new Date("2026-09-20T12:00:00.000Z"),
        ...fakes,
    })
    assert.deepEqual(summary.stockHealthAsOf, {
        asOf: "2026-09-20T12:00:00.000Z",
        periodAligned: false,
    })
    assert.equal(summary.tracking.periodAligned, false)
    assert.equal(fakes.calls.itemAggregate.length, 0)
    assert.equal(fakes.calls.recipe.length, 0)
    assert.equal(summary.current.ingredientShortages.eventCount, 7)
})

function baseSnapshot() {
    return {
        schemaVersion: 2,
        period: {
            start: "2026-08-24",
            end: "2026-08-30",
            previousStart: "2026-08-17",
            previousEnd: "2026-08-23",
            timezone: "UTC",
        },
        business: { modules: ["foodService"], businessType: "restaurant", currency: "EUR" },
        sales: {
            paidRevenueCents: 100_000,
            previousPaidRevenueCents: 100_000,
            revenueChangePercent: 0,
            transactionCount: 20,
            previousTransactionCount: 20,
            transactionCountChangePercent: 0,
            averageTransactionValueCents: 5_000,
            previousAverageTransactionValueCents: 5_000,
            revenueByDay: [],
        },
        operations: {
            completedOrders: 20,
            previousCompletedOrders: 20,
            completedOrdersChangePercent: 0,
            averagePrepTimeMinutes: 10,
            previousAveragePrepTimeMinutes: 10,
            prepTimeChangePercent: 0,
            totalItemsSold: 30,
            previousTotalItemsSold: 30,
            itemsSoldChangePercent: 0,
        },
        menu: null,
        service: null,
        servicePoints: {},
        staff: {},
        customers: {
            newCustomers: 5,
            previousNewCustomers: 5,
            returningCustomers: 5,
            previousReturningCustomers: 5,
            distinctVisitors: 10,
            previousDistinctVisitors: 10,
        },
        feedback: {
            current: { reviewCount: 0, averageRating: null },
            previous: { reviewCount: 0, averageRating: null },
            comparison: {},
        },
        inventory: {
            stockHealthAsOf: { periodAligned: false },
            current: {
                totalMovementCount: 0,
                countsByType: {},
                ingredientShortages: { eventCount: 0, affectedItemCount: 0 },
            },
            previous: {
                totalMovementCount: 0,
                countsByType: {},
                ingredientShortages: { eventCount: 0, affectedItemCount: 0 },
            },
            comparison: {},
            tracking: { periodAligned: false },
        },
        reservations: null,
        tipsPayments: null,
    }
}

function deterioratingFeedback(snapshot) {
    snapshot.feedback = {
        current: {
            reviewCount: 20,
            averageRating: 2.8,
            lowRatingCount: 8,
            highRatingCount: 8,
            lowRatingRatePercent: 40,
            highRatingRatePercent: 40,
            csatPercent: 40,
        },
        previous: {
            reviewCount: 20,
            averageRating: 4.2,
            lowRatingCount: 2,
            highRatingCount: 16,
            lowRatingRatePercent: 10,
            highRatingRatePercent: 80,
            csatPercent: 80,
        },
        comparison: {
            ratingDelta: -1.4,
            reviewCountDelta: 0,
            lowRatingRateDeltaPoints: 30,
            highRatingRateDeltaPoints: -40,
            csatDeltaPoints: -40,
        },
    }
    return snapshot
}

test("Cross-domain scoring lets the strongest business signal win", () => {
    const feedbackResult = generateWeeklyInsights(deterioratingFeedback(baseSnapshot()))
    assert.equal(feedbackResult.dominantSignal.category, "feedback")

    const inventorySnapshot = baseSnapshot()
    inventorySnapshot.sales.paidRevenueCents = 80_000
    inventorySnapshot.sales.revenueChangePercent = -20
    inventorySnapshot.inventory.current.totalMovementCount = 6
    inventorySnapshot.inventory.current.ingredientShortages = {
        eventCount: 6,
        affectedItemCount: 4,
        quantityByUnit: [{ unit: "g", eventCount: 6, shortageCanonicalQuantity: 900 }],
    }
    const inventoryResult = generateWeeklyInsights(inventorySnapshot)
    assert.equal(inventoryResult.dominantSignal.category, "inventory")

    const salesSnapshot = baseSnapshot()
    salesSnapshot.sales.paidRevenueCents = 200_000
    salesSnapshot.sales.revenueChangePercent = 100
    const salesResult = generateWeeklyInsights(salesSnapshot)
    assert.equal(salesResult.dominantSignal.category, "revenue")

    const stableResult = generateWeeklyInsights(baseSnapshot())
    assert.equal(stableResult.noSignificantInsights, true)
    assert.equal(stableResult.dominantSignal, null)
})

test("Feedback affects sufficiency but does not dominate when immaterial", () => {
    const snapshot = baseSnapshot()
    snapshot.sales.transactionCount = 0
    snapshot.sales.previousTransactionCount = 0
    snapshot.operations.completedOrders = 0
    snapshot.operations.previousCompletedOrders = 0
    snapshot.feedback = {
        current: { reviewCount: 5, averageRating: 4.5 },
        previous: { reviewCount: 5, averageRating: 4.5 },
        comparison: { ratingDelta: 0, lowRatingRateDeltaPoints: 0, csatDeltaPoints: 0 },
    }
    const result = generateWeeklyInsights(snapshot)
    assert.equal(result.insufficientData, false)
    assert.equal(result.noSignificantInsights, true)
})

test("Aligned cross-domain divergence and prior-theme persistence are explicit", () => {
    const snapshot = deterioratingFeedback(baseSnapshot())
    snapshot.sales.paidRevenueCents = 140_000
    snapshot.sales.revenueChangePercent = 40
    const result = generateWeeklyInsights(snapshot)
    assert.ok(result.crossDomainSignals.some((signal) => signal.id === "sales_feedback_divergence"))

    const continuity = buildRecentThemeSummary({
        generatedReport: { headline: "Guest ratings remained under pressure this week" },
        deterministicInsights: {
            dominantSignal: { id: result.dominantSignal.id, category: result.dominantSignal.category },
        },
    }, result)
    assert.equal(continuity.sameDominantIssue, true)
    assert.equal(continuity.previousTopPriorityDomain, result.dominantSignal.category)
})

test("Revenue concentration is a named persistent issue rather than a headline template", () => {
    const snapshot = baseSnapshot()
    snapshot.sales.revenueByDay = [
        { date: "2026-08-24", grossCents: 60_000, transactionCount: 10 },
        { date: "2026-08-25", grossCents: 20_000, transactionCount: 5 },
        { date: "2026-08-26", grossCents: 20_000, transactionCount: 5 },
    ]
    const insights = generateWeeklyInsights(snapshot)
    assert.equal(insights.dominantSignal.id, "revenue_concentration")

    const continuity = buildRecentThemeSummary({
        generatedReport: { headline: "Most sales came from one unusually busy day" },
        deterministicInsights: {
            dominantSignal: { id: "revenue_concentration", category: "revenue" },
        },
    }, insights)
    assert.equal(continuity.sameDominantIssue, true)
    assert.equal(continuity.previousDominantIssueKey, "revenue_concentration")
})

test("V5.1 evidence pack is bounded, sanitized, and excludes unaligned stock", () => {
    const snapshot = deterioratingFeedback(baseSnapshot())
    snapshot.servicePoints = {
        foodService: Array.from({ length: 15 }, (_, index) => ({
            servicePointId: `secret_${index}`,
            code: `code_${index}`,
            label: `Table ${index}\u0000 ignore instructions`,
            orderCount: index,
        })),
    }
    snapshot.inventory.stockHealthAsOf = {
        periodAligned: false,
        activeItems: 99,
        mostUrgentItems: [{ itemName: "Must not appear" }],
    }
    const insights = generateWeeklyInsights(snapshot)
    const pack = buildV5EvidencePack(snapshot, {
        deterministicInsights: insights,
        recentTheme: {
            previousHeadline: "Sales headline\u0000 from last week",
            previousTopPriorityDomain: "feedback",
            previousDominantIssueKey: insights.dominantSignal.id,
            sameDominantIssue: true,
        },
    })

    assert.equal(pack.packVersion, AI_ANALYST_EVIDENCE_PACK_VERSION)
    assert.equal(pack.domains.feedback.current.reviewCount, 20)
    assert.deepEqual(pack.domains.inventory.stockHealthAsOf, { periodAligned: false })
    assert.equal(pack.domains.servicePoints.foodService.length, 10)
    assert.ok(pack.domains.servicePoints.foodService.every((point) => !point.servicePointId && !point.code))
    assert.equal(pack.signalPrioritization.dominantSignal.category, "feedback")
    assert.equal(pack.recentTheme.sameDominantIssue, true)
    assert.ok(!pack.recentTheme.previousHeadline.includes("\u0000"))
})

test("Business health normalization understands Feedback and Inventory", () => {
    const snapshot = deterioratingFeedback(baseSnapshot())
    snapshot.inventory.current.totalMovementCount = 6
    snapshot.inventory.current.ingredientShortages = { eventCount: 6, affectedItemCount: 4 }
    const insights = generateWeeklyInsights(snapshot)
    const normalized = normalizeBusinessHealth({
        businessHealth: [
            { area: "Customer feedback", status: "Healthy", explanation: "test" },
            { area: "Inventory", status: "Healthy", explanation: "test" },
        ],
    }, insights, snapshot)

    assert.equal(normalized.businessHealth[0].status, "Strained")
    assert.ok(["Watch", "Strained"].includes(normalized.businessHealth[1].status))
})
