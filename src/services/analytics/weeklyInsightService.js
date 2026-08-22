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

    if (hasFood && hasLodge) return foodOk || lodgeOk
    if (hasFood) return foodOk
    if (hasLodge) return lodgeOk

    // No modules at all → insufficient
    return false
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
        let bestScore = remaining[0].priorityScore

        for (let i = 1; i < remaining.length; i++) {
            const candidate = remaining[i]
            const diff = candidate.priorityScore - bestScore
            if (diff <= 0) continue

            if (
                diff <= DIVERSITY.tieThreshold &&
                (categoryCounts.get(candidate.category) || 0) <
                    (categoryCounts.get(remaining[bestIdx].category) || 0)
            ) {
                bestIdx = i
                bestScore = candidate.priorityScore
            } else if (diff > DIVERSITY.tieThreshold) {
                bestIdx = i
                bestScore = candidate.priorityScore
            }
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
    if (!snapshot || snapshot.schemaVersion !== 1) {
        throw new TypeError("Invalid snapshot: expected schemaVersion 1")
    }

    // Overall data sufficiency
    const sufficient = hasSufficientData(snapshot)

    if (!sufficient) {
        return {
            insights: [],
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
    ]

    const deduped = deduplicate(candidates)
    deduped.sort((a, b) => b.priorityScore - a.priorityScore)

    const primary = balanceCategories(deduped).slice(0, OUTPUT.maxPrimary)

    return {
        insights: primary,
        insufficientData: false,
        noSignificantInsights: primary.length === 0,
    }
}

export default generateWeeklyInsights