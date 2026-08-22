/**
 * V5 Evidence Pack Builder
 *
 * Unlike V4's aiPayloadBuilder which filtered down to pre-selected signals,
 * V5 sends the full sanitized weekly snapshot as a structured "Evidence Pack"
 * so Mayor can investigate cross-domain relationships independently.
 *
 * Privacy: all PII (staff names, customer emails) is stripped or anonymized.
 * Internal IDs (servicePointId, staffId) are replaced with references.
 */

const STAFF_ANON_PREFIX = "staff_"

function anonymizeStaff(foodServiceStaff) {
    if (!Array.isArray(foodServiceStaff)) return []
    return foodServiceStaff.map((s, i) => ({
        ref: `${STAFF_ANON_PREFIX}${i + 1}`,
        callsAcknowledged: s.callsAcknowledged ?? 0,
        callsResolved: s.callsResolved ?? 0,
        averageResponseTimeSeconds: s.averageResponseTimeSeconds ?? 0,
        averageResolutionTimeSeconds: s.averageResolutionTimeSeconds ?? 0,
        ordersServed: s.ordersServed ?? 0,
        paymentsConfirmed: s.paymentsConfirmed ?? 0,
        totalOfflinePaymentsConfirmedCents: s.totalOfflinePaymentsConfirmedCents ?? 0,
    }))
}

function anonymizeLodgingStaff(checkIns, checkOuts) {
    const map = new Map()
    let idx = 0
    for (const s of [...(checkIns || []), ...(checkOuts || [])]) {
        if (!map.has(s.staffId)) {
            idx++
            map.set(s.staffId, `${STAFF_ANON_PREFIX}${idx}`)
        }
    }
    return {
        checkIns: (checkIns || []).map((s) => ({
            ref: map.get(s.staffId) || s.staffId,
            checkInsCompleted: s.checkInsCompleted ?? 0,
            averageCheckInDelayMinutes: s.averageCheckInDelayMinutes ?? 0,
        })),
        checkOuts: (checkOuts || []).map((s) => ({
            ref: map.get(s.staffId) || s.staffId,
            checkOutsCompleted: s.checkOutsCompleted ?? 0,
            averageCheckoutDelayMinutes: s.averageCheckoutDelayMinutes ?? 0,
        })),
    }
}

function stripServicePointIds(spList) {
    if (!Array.isArray(spList)) return []
    return spList.map((sp, i) => {
        const { servicePointId, code, ...rest } = sp
        return { ref: sp.label || `sp_${i + 1}`, ...rest }
    })
}

function computeDerivedMetrics(snapshot) {
    const derived = {}
    const s = snapshot

    // Revenue concentration by day
    if (s.sales?.revenueByDay?.length) {
        const totalCents = s.sales.paidRevenueCents || 0
        if (totalCents > 0) {
            const sorted = [...s.sales.revenueByDay]
                .filter(d => d.grossCents > 0)
                .sort((a, b) => b.grossCents - a.grossCents)
            const activeDays = sorted.length
            const topDay = sorted[0]
            derived.revenueConcentration = {
                activeTradingDays: activeDays,
                totalDaysInPeriod: s.sales.revenueByDay.length,
                topDay: topDay ? {
                    date: topDay.date,
                    grossCents: topDay.grossCents,
                    shareOfWeeklyRevenue: Math.round((topDay.grossCents / totalCents) * 1000) / 10
                } : null,
                top2DaysSharePercent: sorted.length >= 2
                    ? Math.round(((sorted[0].grossCents + sorted[1].grossCents) / totalCents) * 1000) / 10
                    : null,
            }
        }
    }

    // Customer concentration
    if (s.customers) {
        const { distinctVisitors, totalVisits, guestSpendCents, totalPaidOrders } = s.customers
        if (distinctVisitors > 0 && totalPaidOrders > 0) {
            derived.customerConcentration = {
                distinctVisitors,
                totalVisits,
                averageVisitsPerCustomer: Math.round((totalVisits / distinctVisitors) * 10) / 10,
                totalGuestSpendCents: guestSpendCents,
                averageSpendPerVisitorCents: Math.round(guestSpendCents / distinctVisitors),
                paidOrdersPerVisitor: Math.round((totalPaidOrders / distinctVisitors) * 10) / 10,
            }
        }
    }

    // Transaction growth vs revenue growth divergence
    if (s.sales) {
        const revChange = s.sales.revenueChangePercent
        const txnChange = s.sales.transactionCountChangePercent
        if (revChange != null && txnChange != null) {
            derived.growthDivergence = {
                revenueGrowthPercent: revChange,
                transactionGrowthPercent: txnChange,
                averageOrderValueCurrentCents: s.sales.averageTransactionValueCents,
                averageOrderValuePreviousCents: s.sales.previousAverageTransactionValueCents,
                aovChangePercent: s.sales.previousAverageTransactionValueCents > 0
                    ? Math.round(((s.sales.averageTransactionValueCents - s.sales.previousAverageTransactionValueCents) / s.sales.previousAverageTransactionValueCents) * 1000) / 10
                    : null,
                divergenceNote: Math.abs((revChange || 0) - (txnChange || 0)) > 20
                    ? "Revenue and transaction growth are diverging significantly — investigate average order value shifts."
                    : null,
            }
        }
    }

    // Order status vs payment status
    if (s.operations && s.sales) {
        const active = s.operations.activeOrders || 0
        const completed = s.operations.completedOrders || 0
        const totalOrders = active + completed
        const paidTransactions = s.sales.transactionCount || 0
        if (totalOrders > 0) {
            derived.orderPaymentReconciliation = {
                totalOrdersInPeriod: totalOrders,
                completedOrders: completed,
                activeOrStuckOrders: active,
                paidTransactions,
                unpaidOrderEstimate: Math.max(0, totalOrders - paidTransactions),
                activeOrderSharePercent: totalOrders > 0 ? Math.round((active / totalOrders) * 1000) / 10 : 0,
            }
        }
    }

    // Menu concentration
    if (s.menu?.topItems?.length) {
        const totalQty = s.menu.topItems.reduce((sum, it) => sum + it.quantity, 0)
        const totalRev = s.menu.topItems.reduce((sum, it) => sum + it.paidItemRevenueCents, 0)
        const topItem = s.menu.topItems[0]
        if (totalQty > 0 && topItem) {
            derived.menuConcentration = {
                totalItemsSold: totalQty,
                topItemName: topItem.itemName,
                topItemQuantity: topItem.quantity,
                topItemShareOfQuantity: Math.round((topItem.quantity / totalQty) * 1000) / 10,
                topItemShareOfRevenue: totalRev > 0 ? Math.round((topItem.paidItemRevenueCents / totalRev) * 1000) / 10 : null,
            }
        }
    }

    // Category attachment analysis
    if (s.menu?.categoryPerformance?.length) {
        const cats = s.menu.categoryPerformance
        const totalQty = cats.reduce((sum, c) => sum + c.quantity, 0)
        derived.categoryAttachment = cats.map(c => ({
            category: c.category,
            quantity: c.quantity,
            shareOfItems: totalQty > 0 ? Math.round((c.quantity / totalQty) * 1000) / 10 : 0,
            shareOfRevenue: c.percentageOfItemRevenue,
        }))
    }

    // Service point concentration
    if (s.servicePoints?.foodService?.length) {
        const sps = s.servicePoints.foodService
        const totalOrders = sps.reduce((sum, sp) => sum + sp.orderCount, 0)
        const totalRev = sps.reduce((sum, sp) => sum + sp.paidRevenueCents, 0)
        if (totalOrders > 0) {
            const top = sps[0] // already sorted by orderCount in snapshot
            derived.servicePointConcentration = {
                totalServicePoints: sps.length,
                totalOrdersAcrossPoints: totalOrders,
                topPointLabel: top.label,
                topPointOrders: top.orderCount,
                topPointShareOfOrders: Math.round((top.orderCount / totalOrders) * 1000) / 10,
                topPointRevenueCents: top.paidRevenueCents,
                topPointShareOfRevenue: totalRev > 0 ? Math.round((top.paidRevenueCents / totalRev) * 1000) / 10 : null,
            }
        }
    }

    return derived
}

/**
 * Build the V5 Evidence Pack from a weekly snapshot.
 *
 * @param {Object} snapshot — the full weekly analytics snapshot
 * @returns {Object} sanitized evidence pack for Mayor
 */
export function buildV5EvidencePack(snapshot) {
    const s = snapshot || {}
    const biz = s.business || {}
    const hasFood = biz.modules?.includes("foodService")
    const hasLodge = biz.modules?.includes("lodging")

    const pack = {
        packVersion: "5.0",
        period: {
            start: s.period?.start,
            end: s.period?.end,
            previousStart: s.period?.previousStart,
            previousEnd: s.period?.previousEnd,
            timezone: s.period?.timezone,
            comparison: "week_over_week",
        },
        business: {
            businessType: biz.businessType,
            currency: biz.currency,
            modules: biz.modules,
        },
        domains: {},
        derivedCrossChecks: {},
    }

    // ── Sales ──────────────────────────────────────────────────────────────
    if (s.sales) {
        pack.domains.sales = {
            paidRevenueCents: s.sales.paidRevenueCents,
            previousPaidRevenueCents: s.sales.previousPaidRevenueCents,
            revenueChangePercent: s.sales.revenueChangePercent,
            refundedCents: s.sales.refundedCents,
            netRetainedCents: s.sales.netRetainedCents,
            transactionCount: s.sales.transactionCount,
            previousTransactionCount: s.sales.previousTransactionCount,
            transactionCountChangePercent: s.sales.transactionCountChangePercent,
            averageTransactionValueCents: s.sales.averageTransactionValueCents,
            previousAverageTransactionValueCents: s.sales.previousAverageTransactionValueCents,
            revenueByDay: (s.sales.revenueByDay || []).map(d => ({
                date: d.date,
                grossCents: d.grossCents,
                transactionCount: d.transactionCount,
            })),
        }
    }

    // ── Operations ─────────────────────────────────────────────────────────
    if (hasFood && s.operations) {
        pack.domains.operations = {
            activeOrders: s.operations.activeOrders,
            completedOrders: s.operations.completedOrders,
            previousCompletedOrders: s.operations.previousCompletedOrders,
            completedOrdersChangePercent: s.operations.completedOrdersChangePercent,
            averagePrepTimeMinutes: s.operations.averagePrepTimeMinutes,
            previousAveragePrepTimeMinutes: s.operations.previousAveragePrepTimeMinutes,
            prepTimeChangePercent: s.operations.prepTimeChangePercent,
            peakOrderHour: s.operations.peakOrderHour,
            totalItemsSold: s.operations.totalItemsSold,
            previousTotalItemsSold: s.operations.previousTotalItemsSold,
            itemsSoldChangePercent: s.operations.itemsSoldChangePercent,
        }
    }

    // ── Menu ───────────────────────────────────────────────────────────────
    if (hasFood && s.menu) {
        pack.domains.menu = {
            topItems: (s.menu.topItems || []).map(it => ({
                itemName: it.itemName,
                quantity: it.quantity,
                paidItemRevenueCents: it.paidItemRevenueCents,
                category: it.category,
            })),
            previousTopItems: (s.menu.previousTopItems || []).map(it => ({
                itemName: it.itemName,
                quantity: it.quantity,
                paidItemRevenueCents: it.paidItemRevenueCents,
                category: it.category,
            })),
            categoryPerformance: s.menu.categoryPerformance || [],
            previousCategoryPerformance: s.menu.previousCategoryPerformance || [],
            orderTypeBreakdown: s.menu.orderTypeBreakdown || [],
            channelBreakdown: s.menu.channelBreakdown || [],
        }
    }

    // ── Customers (anonymized) ─────────────────────────────────────────────
    if (s.customers) {
        pack.domains.customers = {
            activeCustomerCount: s.customers.activeCustomerCount,
            newCustomers: s.customers.newCustomers,
            previousNewCustomers: s.customers.previousNewCustomers,
            newCustomersChangePercent: s.customers.newCustomersChangePercent,
            returningCustomers: s.customers.returningCustomers,
            previousReturningCustomers: s.customers.previousReturningCustomers,
            returningCustomersChangePercent: s.customers.returningCustomersChangePercent,
            distinctVisitors: s.customers.distinctVisitors,
            previousDistinctVisitors: s.customers.previousDistinctVisitors,
            totalVisits: s.customers.totalVisits,
            previousTotalVisits: s.customers.previousTotalVisits,
            guestSpendCents: s.customers.guestSpendCents,
            previousGuestSpendCents: s.customers.previousGuestSpendCents,
            totalPaidOrders: s.customers.totalPaidOrders,
            marketingConsentCount: s.customers.marketingConsentCount,
            inactiveCount: s.customers.inactiveCount,
        }
    }

    // ── Feedback ────────────────────────────────────────────────────────────
    if (s.feedback) {
        pack.domains.feedback = {
            reviewCount: s.feedback.reviewCount,
            averageRating: s.feedback.averageRating,
            csatPercent: s.feedback.csatPercent,
            negativeThemes: s.feedback.negativeThemes || [],
        }
    }

    // ── Service Calls ──────────────────────────────────────────────────────
    if (hasFood && s.service) {
        pack.domains.service = {
            total: s.service.total,
            previousTotal: s.service.previousTotal,
            totalChangePercent: s.service.totalChangePercent,
            pending: s.service.pending,
            acknowledged: s.service.acknowledged,
            resolved: s.service.resolved,
            missed: s.service.missed,
            previousMissed: s.service.previousMissed,
            missedChangePercent: s.service.missedChangePercent,
            averageResponseTimeSeconds: s.service.averageResponseTimeSeconds,
            previousAverageResponseTimeSeconds: s.service.previousAverageResponseTimeSeconds,
            responseTimeChangePercent: s.service.responseTimeChangePercent,
            averageResolutionTimeSeconds: s.service.averageResolutionTimeSeconds,
            previousAverageResolutionTimeSeconds: s.service.previousAverageResolutionTimeSeconds,
            resolutionTimeChangePercent: s.service.resolutionTimeChangePercent,
            byReason: s.service.byReason,
        }
    }

    // ── Staff (anonymized) ─────────────────────────────────────────────────
    const staff = {}
    if (hasFood && s.staff?.foodService?.length) {
        staff.foodService = anonymizeStaff(s.staff.foodService)
    }
    if (hasLodge && s.staff?.lodging) {
        staff.lodging = anonymizeLodgingStaff(s.staff.lodging.checkIns, s.staff.lodging.checkOuts)
    }
    if (Object.keys(staff).length > 0) {
        pack.domains.staff = staff
    }

    // ── Service Points (anonymized IDs) ────────────────────────────────────
    const sp = {}
    if (s.servicePoints?.foodService?.length) {
        sp.foodService = stripServicePointIds(s.servicePoints.foodService)
    }
    if (s.servicePoints?.lodging?.length) {
        sp.lodging = stripServicePointIds(s.servicePoints.lodging)
    }
    if (Object.keys(sp).length > 0) {
        pack.domains.servicePoints = sp
    }

    // ── Reservations ───────────────────────────────────────────────────────
    if (hasLodge && s.reservations) {
        pack.domains.reservations = { ...s.reservations }
    }

    // ── Tips & Payments ────────────────────────────────────────────────────
    if (s.tipsPayments) {
        pack.domains.tipsPayments = { ...s.tipsPayments }
    }

    // ── Derived Cross-Checks ───────────────────────────────────────────────
    pack.derivedCrossChecks = computeDerivedMetrics(s)

    return pack
}

export default buildV5EvidencePack
