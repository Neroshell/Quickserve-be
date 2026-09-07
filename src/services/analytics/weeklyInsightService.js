/**
 * Deterministic Weekly Insight Engine.
 *
 * Consumes a Phase 1 weeklyAnalystSnapshotService snapshot and returns
 * a ranked, deduplicated, bounded list of structured business insights
 * together with data-sufficiency metadata.
 *
 * No Qwen. No natural-language generation. No side effects.
 */
import {
    MIN_SAMPLE_SIZES,
    MATERIALITY,
    CONFIDENCE,
    impactScore,
    impactTier,
    PRIORITY,
    OUTPUT,
    DIVERSITY,
    DEDUP_GROUPS,
    classifyType,
    DATA_SUFFICIENCY,
} from "./insightThresholds.js"
import { INVENTORY_MOVEMENT_TYPES } from "../../constants/inventory.js"

// ---------------------------------------------------------------------------
// Data sufficiency — overall check independent of week-over-week rules.
// ---------------------------------------------------------------------------

function hasSufficientData(snapshot) {
    const hasFood = snapshot.business?.modules?.includes("foodService")
    const hasLodge = snapshot.business?.modules?.includes("lodging")

    let foodOk = true
    let lodgeOk = true

    if (hasFood) {
        foodOk =
            (snapshot.sales?.transactionCount || 0) >=
            DATA_SUFFICIENCY.minFoodTransactions
    }
    if (hasLodge) {
        lodgeOk =
            (snapshot.reservations?.paidBookingCount || 0) >=
            DATA_SUFFICIENCY.minLodgingBookings
    }

    const feedbackOk =
        (snapshot.feedback?.current?.reviewCount || 0) >=
        DATA_SUFFICIENCY.minFeedbackReviews
    const inventoryOk =
        (snapshot.inventory?.current?.totalMovementCount || 0) >=
            DATA_SUFFICIENCY.minInventoryEvents ||
        (snapshot.inventory?.current?.ingredientShortages?.eventCount || 0) >=
            DATA_SUFFICIENCY.minInventoryEvents

    if (hasFood && hasLodge) return foodOk || lodgeOk || feedbackOk || inventoryOk
    if (hasFood) return foodOk || feedbackOk || inventoryOk
    if (hasLodge) return lodgeOk || feedbackOk || inventoryOk

    // No modules at all → insufficient
    return feedbackOk || inventoryOk
}

// ---------------------------------------------------------------------------
// Scoring pipeline
// ---------------------------------------------------------------------------

function buildConfidenceScore(
    actualSample,
    minSample,
    hasValidPrevious,
    actualChangePct,
    minChangePct,
) {
    const s = CONFIDENCE.sampleFactor(actualSample, minSample)
    const c = CONFIDENCE.comparisonFactor(hasValidPrevious)
    const f = CONFIDENCE.strengthFactor(
        Math.abs(actualChangePct),
        minChangePct,
    )
    return Math.min(1, s * c * f)
}

function buildInsight({
    id,
    category,
    messageKey,
    type,
    impactInputs = {},
    hasValidPrevious = true,
    actualSample = 0,
    minSample = 5,
    actualChangePct = 0,
    minChangePct = 5,
    evidence = {},
}) {
    const confScore = buildConfidenceScore(
        actualSample,
        minSample,
        hasValidPrevious,
        actualChangePct,
        minChangePct,
    )
    const impScore = impactScore(category, impactInputs)
    const priScore = PRIORITY.calculate(impScore, confScore)

    return {
        id,
        category,
        type,
        messageKey,
        priority: PRIORITY.tier(priScore),
        impact: impactTier(impScore),
        confidence: CONFIDENCE.tier(confScore),
        priorityScore: priScore,
        evidence: {
            ...evidence,
            sampleSize: actualSample,
            changePercent: actualChangePct,
        },
    }
}

// ---------------------------------------------------------------------------
// Materiality gate
// ---------------------------------------------------------------------------

function materialityGate({
    current,
    previous,
    minChangePct,
    minAbsolute,
    actualSample,
    minSample,
    hasValidPrevious,
}) {
    if (!hasValidPrevious || previous === null || previous === undefined) {
        return null
    }
    if (actualSample < minSample) return null

    const changePct =
        previous === 0
            ? current > 0
                ? null
                : 0
            : Math.round(((current - previous) / previous) * 1000) / 10

    if (changePct === null) return null

    const absPct = Math.abs(changePct)
    if (absPct < minChangePct) return null

    if (
        minAbsolute !== undefined &&
        Math.abs(current - previous) < minAbsolute
    ) {
        return null
    }

    return { changePct }
}

// ---------------------------------------------------------------------------
// Rule functions — one per insight category family
// ---------------------------------------------------------------------------

function revenueRules(snapshot) {
    const s = snapshot.sales
    if (!s) return []
    const results = []
    const hasPrev = s.previousTransactionCount > 0

    const revGate = materialityGate({
        current: s.paidRevenueCents,
        previous: s.previousPaidRevenueCents,
        minChangePct: MATERIALITY.revenueMinChangePercent,
        minAbsolute: MATERIALITY.revenueMinAbsoluteCents,
        actualSample: s.transactionCount,
        minSample: MIN_SAMPLE_SIZES.transactions,
        hasValidPrevious: hasPrev,
    })
    if (revGate) {
        const growing = revGate.changePct > 0
        results.push(
            buildInsight({
                id: growing ? "revenue_growth" : "revenue_decline",
                category: "revenue",
                messageKey: growing
                    ? "REVENUE_SIGNIFICANT_GROWTH"
                    : "REVENUE_SIGNIFICANT_DECLINE",
                type: classifyType("revenue", revGate.changePct, growing),
                impactInputs: {
                    revenueCents: s.paidRevenueCents - s.previousPaidRevenueCents,
                    volume: s.transactionCount,
                },
                hasValidPrevious: hasPrev,
                actualSample: s.transactionCount,
                minSample: MIN_SAMPLE_SIZES.transactions,
                actualChangePct: Math.abs(revGate.changePct),
                minChangePct: MATERIALITY.revenueMinChangePercent,
                evidence: {
                    currentRevenueCents: s.paidRevenueCents,
                    previousRevenueCents: s.previousPaidRevenueCents,
                    transactionCount: s.transactionCount,
                },
            }),
        )
    }

    const txnGate = materialityGate({
        current: s.transactionCount,
        previous: s.previousTransactionCount,
        minChangePct: MATERIALITY.transactionCountMinChangePercent,
        actualSample: s.transactionCount,
        minSample: MIN_SAMPLE_SIZES.transactions,
        hasValidPrevious: hasPrev,
    })
    if (txnGate) {
        const growing = txnGate.changePct > 0
        results.push(
            buildInsight({
                id: growing
                    ? "transaction_growth"
                    : "transaction_decline",
                category: "revenue",
                messageKey: growing
                    ? "TRANSACTION_COUNT_GROWTH"
                    : "TRANSACTION_COUNT_DECLINE",
                type: classifyType(
                    "transactionCount",
                    txnGate.changePct,
                    growing,
                ),
                impactInputs: {
                    revenueCents: s.paidRevenueCents,
                    volume: s.transactionCount,
                },
                hasValidPrevious: hasPrev,
                actualSample: s.transactionCount,
                minSample: MIN_SAMPLE_SIZES.transactions,
                actualChangePct: Math.abs(txnGate.changePct),
                minChangePct: MATERIALITY.transactionCountMinChangePercent,
                evidence: {
                    currentTransactions: s.transactionCount,
                    previousTransactions: s.previousTransactionCount,
                },
            }),
        )
    }

    // AOV
    const aovGate = materialityGate({
        current: s.averageTransactionValueCents,
        previous: s.previousAverageTransactionValueCents,
        minChangePct: MATERIALITY.aovMinChangePercent,
        actualSample: s.transactionCount,
        minSample: MIN_SAMPLE_SIZES.transactions,
        hasValidPrevious: hasPrev,
    })
    if (aovGate) {
        const growing = aovGate.changePct > 0
        results.push(
            buildInsight({
                id: growing ? "aov_growth" : "aov_decline",
                category: "revenue",
                messageKey: growing ? "AOV_GROWTH" : "AOV_DECLINE",
                type: classifyType("aov", aovGate.changePct, null),
                impactInputs: {
                    revenueCents: s.paidRevenueCents - s.previousPaidRevenueCents,
                    volume: s.transactionCount,
                },
                hasValidPrevious: hasPrev,
                actualSample: s.transactionCount,
                minSample: MIN_SAMPLE_SIZES.transactions,
                actualChangePct: Math.abs(aovGate.changePct),
                minChangePct: MATERIALITY.aovMinChangePercent,
                evidence: {
                    currentAovCents: s.averageTransactionValueCents,
                    previousAovCents: s.previousAverageTransactionValueCents,
                    transactionCount: s.transactionCount,
                },
            }),
        )
    }

    const tradingDays = (s.revenueByDay || []).filter((day) => day.grossCents > 0)
    if (
        s.transactionCount >= MIN_SAMPLE_SIZES.transactions &&
        s.paidRevenueCents > 0 &&
        tradingDays.length >= MATERIALITY.revenueConcentrationMinActiveDays
    ) {
        const topDay = [...tradingDays].sort((a, b) => b.grossCents - a.grossCents)[0]
        const topDaySharePercent = Math.round(
            (topDay.grossCents / s.paidRevenueCents) * 1000,
        ) / 10
        if (topDaySharePercent >= MATERIALITY.revenueConcentrationMinSharePercent) {
            results.push(buildInsight({
                id: "revenue_concentration",
                category: "revenue",
                messageKey: "REVENUE_CONCENTRATION",
                type: "warning",
                impactInputs: {
                    revenueCents: s.paidRevenueCents,
                    volume: s.transactionCount,
                    sharePercent: topDaySharePercent,
                },
                hasValidPrevious: false,
                actualSample: s.transactionCount,
                minSample: MIN_SAMPLE_SIZES.transactions,
                actualChangePct: topDaySharePercent,
                minChangePct: MATERIALITY.revenueConcentrationMinSharePercent,
                evidence: {
                    topDay: topDay.date,
                    topDayRevenueCents: topDay.grossCents,
                    topDaySharePercent,
                    activeTradingDays: tradingDays.length,
                    weeklyRevenueCents: s.paidRevenueCents,
                },
            }))
        }
    }

    return results
}

function operationsRules(snapshot) {
    const ops = snapshot.operations
    if (!ops) return []
    const results = []
    const hasPrev = ops.previousCompletedOrders > 0

    if (ops.completedOrders >= MIN_SAMPLE_SIZES.completedOrders) {
        const prepGate = materialityGate({
            current: ops.averagePrepTimeMinutes,
            previous: ops.previousAveragePrepTimeMinutes,
            minChangePct: MATERIALITY.prepTimeMinChangePercent,
            minAbsolute: MATERIALITY.prepTimeMinChangeMinutes,
            actualSample: ops.completedOrders,
            minSample: MIN_SAMPLE_SIZES.completedOrders,
            hasValidPrevious: hasPrev,
        })
        if (prepGate) {
            const worse = prepGate.changePct > 0
            results.push(
                buildInsight({
                    id: worse
                        ? "prep_time_deterioration"
                        : "prep_time_improvement",
                    category: "operations",
                    messageKey: worse
                        ? "PREP_TIME_DETERIORATION"
                        : "PREP_TIME_IMPROVEMENT",
                    type: classifyType("prepTime", prepGate.changePct, !worse),
                    impactInputs: { volume: ops.completedOrders },
                    hasValidPrevious: hasPrev,
                    actualSample: ops.completedOrders,
                    minSample: MIN_SAMPLE_SIZES.completedOrders,
                    actualChangePct: Math.abs(prepGate.changePct),
                    minChangePct: MATERIALITY.prepTimeMinChangePercent,
                    evidence: {
                        currentAvgPrepMinutes: ops.averagePrepTimeMinutes,
                        previousAvgPrepMinutes: ops.previousAveragePrepTimeMinutes,
                        completedOrders: ops.completedOrders,
                    },
                }),
            )
        }
    }

    const coGate = materialityGate({
        current: ops.completedOrders,
        previous: ops.previousCompletedOrders,
        minChangePct: MATERIALITY.completedOrdersMinChangePercent,
        actualSample: ops.completedOrders,
        minSample: MIN_SAMPLE_SIZES.completedOrders,
        hasValidPrevious: hasPrev,
    })
    if (coGate) {
        const growing = coGate.changePct > 0
        results.push(
            buildInsight({
                id: growing
                    ? "completed_orders_growth"
                    : "completed_orders_decline",
                category: "operations",
                messageKey: growing
                    ? "COMPLETED_ORDERS_GROWTH"
                    : "COMPLETED_ORDERS_DECLINE",
                type: classifyType("completedOrders", coGate.changePct, growing),
                impactInputs: { volume: ops.completedOrders },
                hasValidPrevious: hasPrev,
                actualSample: ops.completedOrders,
                minSample: MIN_SAMPLE_SIZES.completedOrders,
                actualChangePct: Math.abs(coGate.changePct),
                minChangePct: MATERIALITY.completedOrdersMinChangePercent,
                evidence: {
                    currentCompletedOrders: ops.completedOrders,
                    previousCompletedOrders: ops.previousCompletedOrders,
                },
            }),
        )
    }

    const isGate = materialityGate({
        current: ops.totalItemsSold,
        previous: ops.previousTotalItemsSold,
        minChangePct: MATERIALITY.itemsSoldMinChangePercent,
        actualSample: ops.totalItemsSold,
        minSample: MIN_SAMPLE_SIZES.completedOrders,
        hasValidPrevious: hasPrev,
    })
    if (isGate) {
        const growing = isGate.changePct > 0
        results.push(
            buildInsight({
                id: growing
                    ? "items_sold_growth"
                    : "items_sold_decline",
                category: "operations",
                messageKey: growing
                    ? "ITEMS_SOLD_GROWTH"
                    : "ITEMS_SOLD_DECLINE",
                type: classifyType("itemsSold", isGate.changePct, growing),
                impactInputs: { volume: ops.totalItemsSold },
                hasValidPrevious: hasPrev,
                actualSample: ops.totalItemsSold,
                minSample: MIN_SAMPLE_SIZES.completedOrders,
                actualChangePct: Math.abs(isGate.changePct),
                minChangePct: MATERIALITY.itemsSoldMinChangePercent,
                evidence: {
                    currentItemsSold: ops.totalItemsSold,
                    previousItemsSold: ops.previousTotalItemsSold,
                },
            }),
        )
    }

    return results
}

function serviceRules(snapshot) {
    const svc = snapshot.service
    if (!svc) return []
    const results = []
    const hasPrev = svc.previousTotal > 0
    const total = svc.total

    if (total >= MIN_SAMPLE_SIZES.serviceCalls) {
        const respGate = materialityGate({
            current: svc.averageResponseTimeSeconds,
            previous: svc.previousAverageResponseTimeSeconds,
            minChangePct: MATERIALITY.serviceResponseMinChangePercent,
            minAbsolute: MATERIALITY.serviceResponseMinChangeSeconds,
            actualSample: total,
            minSample: MIN_SAMPLE_SIZES.serviceCalls,
            hasValidPrevious: hasPrev,
        })
        if (respGate) {
            const worse = respGate.changePct > 0
            results.push(
                buildInsight({
                    id: worse
                        ? "service_response_deterioration"
                        : "service_response_improvement",
                    category: "service",
                    messageKey: worse
                        ? "SERVICE_RESPONSE_DETERIORATION"
                        : "SERVICE_RESPONSE_IMPROVEMENT",
                    type: classifyType(
                        "serviceResponseTime",
                        respGate.changePct,
                        !worse,
                    ),
                    impactInputs: { volume: total },
                    hasValidPrevious: hasPrev,
                    actualSample: total,
                    minSample: MIN_SAMPLE_SIZES.serviceCalls,
                    actualChangePct: Math.abs(respGate.changePct),
                    minChangePct: MATERIALITY.serviceResponseMinChangePercent,
                    evidence: {
                        currentAvgResponseSeconds: svc.averageResponseTimeSeconds,
                        previousAvgResponseSeconds: svc.previousAverageResponseTimeSeconds,
                        totalCalls: total,
                    },
                }),
            )
        }

        const resGate = materialityGate({
            current: svc.averageResolutionTimeSeconds,
            previous: svc.previousAverageResolutionTimeSeconds,
            minChangePct: MATERIALITY.serviceResolutionMinChangePercent,
            minAbsolute: MATERIALITY.serviceResolutionMinChangeSeconds,
            actualSample: total,
            minSample: MIN_SAMPLE_SIZES.serviceCalls,
            hasValidPrevious: hasPrev,
        })
        if (resGate) {
            const worse = resGate.changePct > 0
            results.push(
                buildInsight({
                    id: worse
                        ? "service_resolution_deterioration"
                        : "service_resolution_improvement",
                    category: "service",
                    messageKey: worse
                        ? "SERVICE_RESOLUTION_DETERIORATION"
                        : "SERVICE_RESOLUTION_IMPROVEMENT",
                    type: classifyType(
                        "serviceResolutionTime",
                        resGate.changePct,
                        !worse,
                    ),
                    impactInputs: { volume: total },
                    hasValidPrevious: hasPrev,
                    actualSample: total,
                    minSample: MIN_SAMPLE_SIZES.serviceCalls,
                    actualChangePct: Math.abs(resGate.changePct),
                    minChangePct: MATERIALITY.serviceResolutionMinChangePercent,
                    evidence: {
                        currentAvgResolutionSeconds: svc.averageResolutionTimeSeconds,
                        previousAvgResolutionSeconds: svc.previousAverageResolutionTimeSeconds,
                        totalCalls: total,
                    },
                }),
            )
        }
    }

    // Missed calls
    if (
        svc.missed >= MIN_SAMPLE_SIZES.missedCallBaseline &&
        total >= MIN_SAMPLE_SIZES.serviceCalls
    ) {
        const missedIncrease = svc.missed - (svc.previousMissed || 0)
        if (missedIncrease >= MATERIALITY.missedCallsMinAbsoluteIncrease) {
            results.push(
                buildInsight({
                    id: "missed_calls_increase",
                    category: "service",
                    messageKey: "MISSED_CALLS_INCREASE",
                    type: "warning",
                    impactInputs: { volume: total },
                    hasValidPrevious: hasPrev,
                    actualSample: total,
                    minSample: MIN_SAMPLE_SIZES.serviceCalls,
                    actualChangePct:
                        svc.previousMissed > 0
                            ? Math.abs(
                                  Math.round(
                                      (missedIncrease / svc.previousMissed) *
                                          1000,
                                  ) / 10,
                              )
                            : 100,
                    minChangePct: 10,
                    evidence: {
                        currentMissed: svc.missed,
                        previousMissed: svc.previousMissed,
                        missedIncrease,
                        totalCalls: total,
                    },
                }),
            )
        }
    }

    return results
}

function customerRules(snapshot) {
    const cust = snapshot.customers
    if (!cust) return []
    const results = []
    const hasPrev = cust.previousDistinctVisitors > 0

    const rules = [
        {
            idSuffix: "new_customers",
            current: cust.newCustomers,
            previous: cust.previousNewCustomers,
            keyG: "NEW_CUSTOMERS_GROWTH",
            keyD: "NEW_CUSTOMERS_DECLINE",
            metric: "newCustomers",
        },
        {
            idSuffix: "returning_customers",
            current: cust.returningCustomers,
            previous: cust.previousReturningCustomers,
            keyG: "RETURNING_CUSTOMERS_GROWTH",
            keyD: "RETURNING_CUSTOMERS_DECLINE",
            metric: "returningCustomers",
        },
        {
            idSuffix: "distinct_visitors",
            current: cust.distinctVisitors,
            previous: cust.previousDistinctVisitors,
            keyG: "DISTINCT_VISITORS_GROWTH",
            keyD: "DISTINCT_VISITORS_DECLINE",
            metric: "distinctVisitors",
        },
    ]

    for (const r of rules) {
        const gate = materialityGate({
            current: r.current,
            previous: r.previous,
            minChangePct: MATERIALITY.customerMinChangePercent,
            actualSample: cust.distinctVisitors,
            minSample: MIN_SAMPLE_SIZES.visitors,
            hasValidPrevious: hasPrev,
        })
        if (gate) {
            const growing = gate.changePct > 0
            results.push(
                buildInsight({
                    id: `${r.idSuffix}_${growing ? "growth" : "decline"}`,
                    category: "customers",
                    messageKey: growing ? r.keyG : r.keyD,
                    type: classifyType(r.metric, gate.changePct, growing),
                    impactInputs: { volume: cust.distinctVisitors },
                    hasValidPrevious: hasPrev,
                    actualSample: cust.distinctVisitors,
                    minSample: MIN_SAMPLE_SIZES.visitors,
                    actualChangePct: Math.abs(gate.changePct),
                    minChangePct: MATERIALITY.customerMinChangePercent,
                    evidence: {
                        current: r.current,
                        previous: r.previous,
                        distinctVisitors: cust.distinctVisitors,
                    },
                }),
            )
        }
    }

    return results
}

function menuRules(snapshot) {
    const menu = snapshot.menu
    if (!menu) return []
    const results = []

    const totalItemRevenue =
        menu.categoryPerformance?.reduce(
            (sum, c) => sum + (c.paidItemRevenueCents || 0),
            0,
        ) || 0

    for (const item of menu.topItems || []) {
        const qty = item.quantity || 0
        if (qty < MIN_SAMPLE_SIZES.menuItemQuantity) continue

        const share =
            totalItemRevenue > 0
                ? Math.round(
                      ((item.paidItemRevenueCents || 0) /
                          totalItemRevenue) *
                          1000,
                  ) / 10
                : 0
        if (share < MATERIALITY.menuItemMinSharePercent) continue

        const prev = (menu.previousTopItems || []).find(
            (p) => p.itemName === item.itemName,
        )
        if (!prev || prev.quantity === 0) continue

        const qtyChange = qty - prev.quantity
        const qtyChangePct =
            Math.round((qtyChange / prev.quantity) * 1000) / 10

        if (
            qtyChangePct <= 0 ||
            Math.abs(qtyChangePct) < MATERIALITY.menuItemMinChangePercent
        )
            continue

        results.push(
            buildInsight({
                id: "menu_item_momentum",
                category: "menu",
                messageKey: "MENU_ITEM_MOMENTUM",
                type: "positive",
                impactInputs: {
                    revenueCents: item.paidItemRevenueCents || 0,
                    volume: qty,
                    sharePercent: share,
                },
                hasValidPrevious: true,
                actualSample: qty,
                minSample: MIN_SAMPLE_SIZES.menuItemQuantity,
                actualChangePct: Math.abs(qtyChangePct),
                minChangePct: MATERIALITY.menuItemMinChangePercent,
                evidence: {
                    itemName: item.itemName,
                    currentQuantity: qty,
                    previousQuantity: prev.quantity,
                    quantityChangePercent: qtyChangePct,
                    paidItemRevenueCents: item.paidItemRevenueCents || 0,
                    category: item.category,
                    sharePercent: share,
                },
            }),
        )
    }

    return results
}

function servicePointRules(snapshot) {
    const sp = snapshot.servicePoints
    if (!sp?.foodService?.length) return []
    const results = []

    const points = sp.foodService
    const totalRev = points.reduce(
        (sum, p) => sum + (p.paidRevenueCents || 0),
        0,
    )
    const avgRev = totalRev / Math.max(1, points.length)

    for (const point of points) {
        const orders = point.orderCount || 0
        if (orders < MIN_SAMPLE_SIZES.servicePointOrders) continue
        const rev = point.paidRevenueCents || 0

        if (
            avgRev > 0 &&
            rev >= avgRev * MATERIALITY.servicePointMinDeviationFactor
        ) {
            const share =
                totalRev > 0
                    ? Math.round((rev / totalRev) * 1000) / 10
                    : 0
            results.push(
                buildInsight({
                    id: "service_point_outperforming",
                    category: "servicePoints",
                    messageKey: "SERVICE_POINT_OUTPERFORMING",
                    type: "positive",
                    impactInputs: {
                        revenueCents: rev,
                        volume: orders,
                        sharePercent: share,
                    },
                    hasValidPrevious: true,
                    actualSample: orders,
                    minSample: MIN_SAMPLE_SIZES.servicePointOrders,
                    actualChangePct:
                        avgRev > 0
                            ? Math.abs(
                                  Math.round(
                                      ((rev - avgRev) / avgRev) *
                                          1000,
                                  ) / 10,
                              )
                            : 0,
                    minChangePct: 20,
                    evidence: {
                        servicePointId: point.servicePointId,
                        label: point.label,
                        paidRevenueCents: rev,
                        avgPaidRevenueCents: Math.round(avgRev),
                        orderCount: orders,
                    },
                }),
            )
        }
    }

    return results
}

function staffRules(snapshot) {
    const staff = snapshot.staff
    if (!staff?.foodService?.length) return []
    const results = []

    const members = staff.foodService.filter(
        (s) =>
            (s.ordersServed || 0) +
                (s.callsResolved || 0) +
                (s.paymentsConfirmed || 0) >=
            MIN_SAMPLE_SIZES.staffActivity,
    )
    if (members.length < 2) return results

    const sorted = [...members].sort(
        (a, b) => (b.ordersServed || 0) - (a.ordersServed || 0),
    )
    const top = sorted[0]
    const median = sorted[Math.floor(sorted.length / 2)]
    const medianServed = median.ordersServed || 0

    if (
        medianServed > 0 &&
        (top.ordersServed || 0) >= medianServed * 2 &&
        (top.ordersServed || 0) >= MIN_SAMPLE_SIZES.staffActivity
    ) {
        results.push(
            buildInsight({
                id: "staff_top_performer",
                category: "staff",
                messageKey: "STAFF_TOP_PERFORMER",
                type: "positive",
                impactInputs: { volume: top.ordersServed || 0 },
                hasValidPrevious: true,
                actualSample: top.ordersServed || 0,
                minSample: MIN_SAMPLE_SIZES.staffActivity,
                actualChangePct:
                    Math.round(
                        (((top.ordersServed || 0) - medianServed) /
                            medianServed) *
                            1000,
                    ) / 10,
                minChangePct: 50,
                evidence: {
                    staffId: top.staffId,
                    name: top.name,
                    ordersServed: top.ordersServed || 0,
                    medianOrdersServed: medianServed,
                },
            }),
        )
    }

    return results
}

function lodgingRules(snapshot) {
    const res = snapshot.reservations
    if (!res) return []
    const results = []
    const hasPrev = res.previousPaidBookingCount > 0

    // Booking revenue growth/decline
    const revGate = materialityGate({
        current: res.paidBookingRevenueCents,
        previous: res.previousPaidBookingRevenueCents,
        minChangePct: MATERIALITY.bookingRevenueMinChangePercent,
        minAbsolute: MATERIALITY.bookingRevenueMinAbsoluteCents,
        actualSample: res.paidBookingCount,
        minSample: MIN_SAMPLE_SIZES.bookings,
        hasValidPrevious: hasPrev,
    })
    if (revGate) {
        const growing = revGate.changePct > 0
        results.push(
            buildInsight({
                id: growing
                    ? "booking_revenue_growth"
                    : "booking_revenue_decline",
                category: "reservations",
                messageKey: growing
                    ? "BOOKING_REVENUE_GROWTH"
                    : "BOOKING_REVENUE_DECLINE",
                type: classifyType("bookingRevenue", revGate.changePct, growing),
                impactInputs: {
                    revenueCents:
                        res.paidBookingRevenueCents -
                        res.previousPaidBookingRevenueCents,
                    volume: res.paidBookingCount,
                },
                hasValidPrevious: hasPrev,
                actualSample: res.paidBookingCount,
                minSample: MIN_SAMPLE_SIZES.bookings,
                actualChangePct: Math.abs(revGate.changePct),
                minChangePct: MATERIALITY.bookingRevenueMinChangePercent,
                evidence: {
                    currentBookingRevenueCents: res.paidBookingRevenueCents,
                    previousBookingRevenueCents: res.previousPaidBookingRevenueCents,
                    paidBookingCount: res.paidBookingCount,
                },
            }),
        )
    }

    // Cancellation increase
    const canc = res.cancellations
    if (
        canc?.count >= MIN_SAMPLE_SIZES.bookings &&
        canc.comparisonPercent !== null
    ) {
        const prevCanc = Math.round(
            canc.count / (1 + (canc.comparisonPercent || 0) / 100),
        )
        const cancGate = materialityGate({
            current: canc.count,
            previous: prevCanc,
            minChangePct: MATERIALITY.cancellationMinChangePercent,
            minAbsolute: MATERIALITY.cancellationMinAbsolute,
            actualSample: canc.count,
            minSample: MIN_SAMPLE_SIZES.bookings,
            hasValidPrevious: true,
        })
        if (cancGate) {
            results.push(
                buildInsight({
                    id: "booking_cancellation_increase",
                    category: "reservations",
                    messageKey: "BOOKING_CANCELLATION_INCREASE",
                    type: "warning",
                    impactInputs: { volume: res.paidBookingCount },
                    hasValidPrevious: true,
                    actualSample: canc.count,
                    minSample: MIN_SAMPLE_SIZES.bookings,
                    actualChangePct: Math.abs(cancGate.changePct),
                    minChangePct: MATERIALITY.cancellationMinChangePercent,
                    evidence: {
                        currentCancellations: canc.count,
                        cancellationRatePercent:
                            canc.cancelledBookingCohortRatePercent,
                    },
                }),
            )
        }
    }

    // NO low-occupancy rule in v1 — previous-period occupancy data
    // is not available in the Phase 1 snapshot.

    return results
}

function tipsRules(snapshot) {
    const tips = snapshot.tipsPayments
    if (!tips) return []
    const results = []
    const hasPrev = tips.previousTotalTipsCents > 0

    if (tips.ordersWithTips >= MIN_SAMPLE_SIZES.tippedOrders) {
        const trGate = materialityGate({
            current: tips.tipRatePercent,
            previous: tips.previousTipRatePercent,
            minChangePct: MATERIALITY.tipRateMinChangePercent,
            actualSample: tips.ordersWithTips,
            minSample: MIN_SAMPLE_SIZES.tippedOrders,
            hasValidPrevious: hasPrev,
        })
        if (trGate) {
            const growing = trGate.changePct > 0
            results.push(
                buildInsight({
                    id: growing
                        ? "tip_rate_growth"
                        : "tip_rate_decline",
                    category: "tipsPayments",
                    messageKey: growing
                        ? "TIP_RATE_GROWTH"
                        : "TIP_RATE_DECLINE",
                    type: classifyType("tipRate", trGate.changePct, growing),
                    impactInputs: {
                        revenueCents:
                            tips.totalTipsCents - tips.previousTotalTipsCents,
                        volume: tips.ordersWithTips,
                    },
                    hasValidPrevious: hasPrev,
                    actualSample: tips.ordersWithTips,
                    minSample: MIN_SAMPLE_SIZES.tippedOrders,
                    actualChangePct: Math.abs(trGate.changePct),
                    minChangePct: MATERIALITY.tipRateMinChangePercent,
                    evidence: {
                        currentTipRatePercent: tips.tipRatePercent,
                        previousTipRatePercent: tips.previousTipRatePercent,
                        tippedOrders: tips.ordersWithTips,
                        totalTipsCents: tips.totalTipsCents,
                    },
                }),
            )
        }
    }

    return results
}

function feedbackRules(snapshot) {
    const current = snapshot.feedback?.current
    const previous = snapshot.feedback?.previous
    const comparison = snapshot.feedback?.comparison
    if (!current || !previous || !comparison) return []

    const results = []
    const currentSample = Number(current.reviewCount || 0)
    const previousSample = Number(previous.reviewCount || 0)
    const comparable =
        currentSample >= MIN_SAMPLE_SIZES.feedbackReviews &&
        previousSample >= MIN_SAMPLE_SIZES.feedbackReviews

    const addComparisonInsight = ({
        delta,
        minimum,
        improvingWhenPositive,
        improvingId,
        decliningId,
        improvingKey,
        decliningKey,
        evidence,
        sharePercent = 0,
        severityDivisor,
    }) => {
        if (!comparable || !Number.isFinite(Number(delta)) || Math.abs(delta) < minimum) {
            return
        }
        const improving = improvingWhenPositive ? delta > 0 : delta < 0
        results.push(buildInsight({
            id: improving ? improvingId : decliningId,
            category: "feedback",
            messageKey: improving ? improvingKey : decliningKey,
            type: improving ? "positive" : "warning",
            impactInputs: {
                volume: currentSample,
                sharePercent,
                severity: Math.min(1, Math.abs(delta) / severityDivisor),
            },
            hasValidPrevious: true,
            actualSample: currentSample,
            minSample: MIN_SAMPLE_SIZES.feedbackReviews,
            actualChangePct: Math.abs(delta),
            minChangePct: minimum,
            evidence,
        }))
    }

    addComparisonInsight({
        delta: Number(comparison.ratingDelta),
        minimum: MATERIALITY.feedbackRatingMinDelta,
        improvingWhenPositive: true,
        improvingId: "feedback_rating_improvement",
        decliningId: "feedback_rating_decline",
        improvingKey: "FEEDBACK_RATING_IMPROVEMENT",
        decliningKey: "FEEDBACK_RATING_DECLINE",
        severityDivisor: 1,
        evidence: {
            currentAverageRating: current.averageRating,
            previousAverageRating: previous.averageRating,
            ratingDelta: comparison.ratingDelta,
            currentReviews: currentSample,
            previousReviews: previousSample,
        },
    })

    addComparisonInsight({
        delta: Number(comparison.lowRatingRateDeltaPoints),
        minimum: MATERIALITY.feedbackShareMinDeltaPoints,
        improvingWhenPositive: false,
        improvingId: "feedback_low_rating_share_improvement",
        decliningId: "feedback_low_rating_share_increase",
        improvingKey: "FEEDBACK_LOW_RATING_SHARE_IMPROVEMENT",
        decliningKey: "FEEDBACK_LOW_RATING_SHARE_INCREASE",
        sharePercent: Number(current.lowRatingRatePercent || 0),
        severityDivisor: 30,
        evidence: {
            currentLowRatingCount: current.lowRatingCount,
            previousLowRatingCount: previous.lowRatingCount,
            currentLowRatingRatePercent: current.lowRatingRatePercent,
            previousLowRatingRatePercent: previous.lowRatingRatePercent,
            lowRatingRateDeltaPoints: comparison.lowRatingRateDeltaPoints,
            currentReviews: currentSample,
        },
    })

    addComparisonInsight({
        delta: Number(comparison.csatDeltaPoints),
        minimum: MATERIALITY.feedbackShareMinDeltaPoints,
        improvingWhenPositive: true,
        improvingId: "feedback_csat_improvement",
        decliningId: "feedback_csat_decline",
        improvingKey: "FEEDBACK_CSAT_IMPROVEMENT",
        decliningKey: "FEEDBACK_CSAT_DECLINE",
        sharePercent: Math.max(0, 100 - Number(current.csatPercent || 0)),
        severityDivisor: 30,
        evidence: {
            currentCsatPercent: current.csatPercent,
            previousCsatPercent: previous.csatPercent,
            csatDeltaPoints: comparison.csatDeltaPoints,
            currentReviews: currentSample,
        },
    })

    const volumeGate = materialityGate({
        current: currentSample,
        previous: previousSample,
        minChangePct: MATERIALITY.feedbackReviewVolumeMinChangePercent,
        actualSample: currentSample,
        minSample: MIN_SAMPLE_SIZES.feedbackReviews,
        hasValidPrevious: previousSample >= MIN_SAMPLE_SIZES.feedbackReviews,
    })
    if (volumeGate) {
        const growing = volumeGate.changePct > 0
        results.push(buildInsight({
            id: growing ? "feedback_review_volume_growth" : "feedback_review_volume_decline",
            category: "feedback",
            messageKey: growing
                ? "FEEDBACK_REVIEW_VOLUME_GROWTH"
                : "FEEDBACK_REVIEW_VOLUME_DECLINE",
            type: "info",
            impactInputs: { volume: currentSample, severity: 0.2 },
            hasValidPrevious: true,
            actualSample: currentSample,
            minSample: MIN_SAMPLE_SIZES.feedbackReviews,
            actualChangePct: Math.abs(volumeGate.changePct),
            minChangePct: MATERIALITY.feedbackReviewVolumeMinChangePercent,
            evidence: { currentReviews: currentSample, previousReviews: previousSample },
        }))
    }

    if (
        currentSample >= MIN_SAMPLE_SIZES.feedbackReviews &&
        current.averageRating !== null &&
        current.averageRating !== undefined &&
        Number.isFinite(Number(current.averageRating)) &&
        Number(current.averageRating) < 3
    ) {
        results.push(buildInsight({
            id: "feedback_low_rating_level",
            category: "feedback",
            messageKey: "FEEDBACK_LOW_RATING_LEVEL",
            type: "warning",
            impactInputs: {
                volume: currentSample,
                sharePercent: Number(current.lowRatingRatePercent || 0),
                severity: Math.min(1, (3 - Number(current.averageRating)) / 1.5),
            },
            hasValidPrevious: false,
            actualSample: currentSample,
            minSample: MIN_SAMPLE_SIZES.feedbackReviews,
            actualChangePct: Math.max(0, (3 - Number(current.averageRating)) * 20),
            minChangePct: 5,
            evidence: {
                currentAverageRating: current.averageRating,
                currentLowRatingRatePercent: current.lowRatingRatePercent,
                currentReviews: currentSample,
            },
        }))
    }

    return results
}

function sumMovementCounts(summary, types) {
    return types.reduce(
        (total, type) => total + Number(summary?.countsByType?.[type] || 0),
        0,
    )
}

function inventoryRules(snapshot) {
    const inventory = snapshot.inventory
    if (!inventory) return []
    const current = inventory.current || {}
    const previous = inventory.previous || {}
    const results = []

    const shortages = Number(current.ingredientShortages?.eventCount || 0)
    const previousShortages = Number(previous.ingredientShortages?.eventCount || 0)
    if (shortages >= MIN_SAMPLE_SIZES.inventoryShortageEvents) {
        const changePercent = previousShortages > 0
            ? Math.round(((shortages - previousShortages) / previousShortages) * 1000) / 10
            : 100
        results.push(buildInsight({
            id: "inventory_shortages_recorded",
            category: "inventory",
            messageKey: "INVENTORY_SHORTAGES_RECORDED",
            type: "warning",
            impactInputs: {
                volume: shortages,
                severity: Math.min(1, shortages / 5),
                persistence: previousShortages > 0 ? 1 : 0,
            },
            hasValidPrevious: true,
            actualSample: shortages,
            minSample: MIN_SAMPLE_SIZES.inventoryShortageEvents,
            actualChangePct: Math.abs(changePercent),
            minChangePct: 25,
            evidence: {
                shortageEvents: shortages,
                previousShortageEvents: previousShortages,
                affectedItemCount: current.ingredientShortages?.affectedItemCount || 0,
                quantityByUnit: current.ingredientShortages?.quantityByUnit || [],
            },
        }))
    } else if (previousShortages > 0) {
        results.push(buildInsight({
            id: "inventory_shortages_cleared",
            category: "inventory",
            messageKey: "INVENTORY_SHORTAGES_CLEARED",
            type: "positive",
            impactInputs: { volume: previousShortages, severity: 0.5 },
            hasValidPrevious: true,
            actualSample: previousShortages,
            minSample: MIN_SAMPLE_SIZES.inventoryShortageEvents,
            actualChangePct: 100,
            minChangePct: 25,
            evidence: { shortageEvents: 0, previousShortageEvents },
        }))
    }

    const wasteEvents = sumMovementCounts(current, [INVENTORY_MOVEMENT_TYPES.WASTE])
    const previousWasteEvents = sumMovementCounts(previous, [INVENTORY_MOVEMENT_TYPES.WASTE])
    if (wasteEvents >= MATERIALITY.inventoryWasteMinEvents) {
        const increasePercent = previousWasteEvents > 0
            ? ((wasteEvents - previousWasteEvents) / previousWasteEvents) * 100
            : 100
        if (
            previousWasteEvents === 0 ||
            increasePercent >= MATERIALITY.inventoryWasteMinIncreasePercent
        ) {
            results.push(buildInsight({
                id: "inventory_waste_activity",
                category: "inventory",
                messageKey: "INVENTORY_WASTE_ACTIVITY",
                type: "warning",
                impactInputs: {
                    volume: wasteEvents,
                    severity: Math.min(1, wasteEvents / 10),
                    persistence: previousWasteEvents > 0 ? 0.5 : 0,
                },
                hasValidPrevious: true,
                actualSample: wasteEvents,
                minSample: MATERIALITY.inventoryWasteMinEvents,
                actualChangePct: Math.abs(increasePercent),
                minChangePct: MATERIALITY.inventoryWasteMinIncreasePercent,
                evidence: {
                    wasteEvents,
                    previousWasteEvents,
                    wasteByUnit: current.wasteByUnit || [],
                },
            }))
        }
    }

    const adjustmentTypes = [
        INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_INCREASE,
        INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_DECREASE,
        INVENTORY_MOVEMENT_TYPES.COUNT_RECONCILIATION_INCREASE,
        INVENTORY_MOVEMENT_TYPES.COUNT_RECONCILIATION_DECREASE,
    ]
    const adjustmentEvents = sumMovementCounts(current, adjustmentTypes)
    const previousAdjustmentEvents = sumMovementCounts(previous, adjustmentTypes)
    if (adjustmentEvents >= MATERIALITY.inventoryAdjustmentMinEvents) {
        results.push(buildInsight({
            id: "inventory_repeated_adjustments",
            category: "inventory",
            messageKey: "INVENTORY_REPEATED_ADJUSTMENTS",
            type: "warning",
            impactInputs: {
                volume: adjustmentEvents,
                severity: Math.min(1, adjustmentEvents / 12),
                persistence: previousAdjustmentEvents >= MATERIALITY.inventoryAdjustmentMinEvents ? 1 : 0,
            },
            hasValidPrevious: true,
            actualSample: adjustmentEvents,
            minSample: MATERIALITY.inventoryAdjustmentMinEvents,
            actualChangePct: Math.abs(adjustmentEvents - previousAdjustmentEvents),
            minChangePct: 1,
            evidence: {
                adjustmentEvents,
                previousAdjustmentEvents,
                adjustmentsByUnit: current.adjustmentsByUnit || [],
            },
        }))
    }

    const stock = inventory.stockHealthAsOf
    if (stock?.periodAligned === true) {
        const activeItems = Number(stock.activeItems || 0)
        const riskItems = Number(stock.lowStockItems || 0) + Number(stock.outOfStockItems || 0)
        const riskShare = activeItems > 0 ? (riskItems / activeItems) * 100 : 0
        if (
            activeItems >= MIN_SAMPLE_SIZES.inventoryActiveItems &&
            (Number(stock.outOfStockItems || 0) > 0 ||
                riskItems >= MATERIALITY.inventoryStockRiskMinItems ||
                riskShare >= MATERIALITY.inventoryStockRiskMinSharePercent)
        ) {
            results.push(buildInsight({
                id: "inventory_stock_risk",
                category: "inventory",
                messageKey: "INVENTORY_STOCK_RISK",
                type: "warning",
                impactInputs: {
                    volume: riskItems,
                    sharePercent: riskShare,
                    severity: Math.min(
                        1,
                        Number(stock.outOfStockItems || 0) * 0.35 + riskShare / 50,
                    ),
                },
                hasValidPrevious: false,
                actualSample: activeItems,
                minSample: MIN_SAMPLE_SIZES.inventoryActiveItems,
                actualChangePct: riskShare,
                minChangePct: MATERIALITY.inventoryStockRiskMinSharePercent,
                evidence: {
                    asOf: stock.asOf,
                    periodAligned: true,
                    activeItems,
                    lowStockItems: stock.lowStockItems || 0,
                    outOfStockItems: stock.outOfStockItems || 0,
                    riskSharePercent: Math.round(riskShare * 10) / 10,
                    mostUrgentItems: stock.mostUrgentItems || [],
                },
            }))
        }
    }

    return results
}

function buildCrossDomainSignals(insights) {
    const revenue = insights.find((insight) => insight.category === "revenue")
    const feedback = insights.find((insight) => insight.category === "feedback")
    const operations = insights.find((insight) => insight.category === "operations")
    const inventory = insights.find((insight) => insight.category === "inventory")
    const signals = []

    if (revenue && feedback && revenue.type !== feedback.type) {
        signals.push({
            id: "sales_feedback_divergence",
            categories: ["revenue", "feedback"],
            relationship: "occurred_alongside",
            periodAligned: true,
            signalIds: [revenue.id, feedback.id],
        })
    }
    if (operations && feedback && operations.type !== feedback.type) {
        signals.push({
            id: "operations_feedback_divergence",
            categories: ["operations", "feedback"],
            relationship: "occurred_alongside",
            periodAligned: true,
            signalIds: [operations.id, feedback.id],
        })
    }
    if (inventory?.type === "warning" && operations) {
        signals.push({
            id: "inventory_operational_risk",
            categories: ["inventory", "operations"],
            relationship: "operational_risk_during_period",
            periodAligned: true,
            signalIds: [inventory.id, operations.id],
        })
    }

    return signals.slice(0, 3)
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function deduplicate(insights) {
    const survivors = []
    const usedGroups = new Map()

    for (const insight of insights) {
        let group = null
        for (const [groupName, ids] of Object.entries(DEDUP_GROUPS)) {
            if (ids.has(insight.id)) {
                group = groupName
                break
            }
        }
        if (!group) {
            survivors.push(insight)
            continue
        }
        const existing = usedGroups.get(group)
        if (!existing) {
            usedGroups.set(group, {
                id: insight.id,
                priorityScore: insight.priorityScore,
            })
            survivors.push(insight)
        } else if (insight.priorityScore > existing.priorityScore) {
            const idx = survivors.findIndex((s) => s.id === existing.id)
            if (idx >= 0) survivors.splice(idx, 1)
            usedGroups.set(group, {
                id: insight.id,
                priorityScore: insight.priorityScore,
            })
            survivors.push(insight)
        }
    }

    return survivors
}

// ---------------------------------------------------------------------------
// Category balancing
// ---------------------------------------------------------------------------

function balanceCategories(sorted) {
    if (sorted.length <= OUTPUT.maxPrimary) return sorted
    const primary = []
    const categoryCounts = new Map()
    const remaining = [...sorted]

    while (primary.length < OUTPUT.maxPrimary && remaining.length > 0) {
        let bestIdx = 0
        const leadingScore = remaining[0].priorityScore

        for (let i = 1; i < remaining.length; i++) {
            const candidate = remaining[i]
            if (leadingScore - candidate.priorityScore > DIVERSITY.tieThreshold) break

            const candidateCategoryCount = categoryCounts.get(candidate.category) || 0
            const bestCategoryCount = categoryCounts.get(remaining[bestIdx].category) || 0
            if (
                candidateCategoryCount < bestCategoryCount ||
                (candidateCategoryCount === bestCategoryCount &&
                    candidate.priorityScore > remaining[bestIdx].priorityScore)
            ) bestIdx = i
        }

        const chosen = remaining[bestIdx]
        primary.push(chosen)
        categoryCounts.set(
            chosen.category,
            (categoryCounts.get(chosen.category) || 0) + 1,
        )
        remaining.splice(bestIdx, 1)
    }

    return primary
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate deterministic weekly insights from a Phase 1 snapshot.
 *
 * @param {Object} snapshot — output of generateWeeklySnapshot()
 * @returns {{ insights: Array, insufficientData: boolean, noSignificantInsights: boolean }}
 */
export function generateWeeklyInsights(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 2) {
        throw new TypeError("Invalid snapshot: expected schemaVersion 2")
    }

    // Overall data sufficiency
    const sufficient = hasSufficientData(snapshot)

    if (!sufficient) {
        return {
            insights: [],
            dominantSignal: null,
            crossDomainSignals: [],
            insufficientData: true,
            noSignificantInsights: false,
        }
    }

    // Collect all candidates
    const candidates = [
        ...revenueRules(snapshot),
        ...operationsRules(snapshot),
        ...serviceRules(snapshot),
        ...customerRules(snapshot),
        ...menuRules(snapshot),
        ...servicePointRules(snapshot),
        ...staffRules(snapshot),
        ...lodgingRules(snapshot),
        ...tipsRules(snapshot),
        ...feedbackRules(snapshot),
        ...inventoryRules(snapshot),
    ]

    const deduped = deduplicate(candidates)
    deduped.sort((a, b) => b.priorityScore - a.priorityScore)

    const primary = balanceCategories(deduped).slice(0, OUTPUT.maxPrimary)

    return {
        insights: primary,
        dominantSignal: primary[0]
            ? {
                id: primary[0].id,
                category: primary[0].category,
                type: primary[0].type,
                priorityScore: primary[0].priorityScore,
            }
            : null,
        crossDomainSignals: buildCrossDomainSignals(primary),
        insufficientData: false,
        noSignificantInsights: primary.length === 0,
    }
}

export default generateWeeklyInsights
