import { DateTime } from "luxon"
import Business from "../../models/Business.js"
import GuestProfile from "../../models/GuestProfile.js"
import GuestVisit from "../../models/GuestVisit.js"
import Feedback from "../../models/Feedback.js"
import { resolveBusinessCapabilities } from "../businessCapabilityService.js"
import {
    resolveAnalyticsDomainRanges,
    resolveAnalyticsTimezone,
} from "./analyticsRangeService.js"
import { getSharedAnalytics } from "./sharedAnalyticsService.js"
import { getFoodServiceAnalytics } from "./foodServiceAnalyticsService.js"
import { getLodgingAnalytics } from "./lodgingAnalyticsService.js"

export class WeeklyAnalystSnapshotServiceError extends Error {
    constructor(message, statusCode = 500) {
        super(message)
        this.name = "WeeklyAnalystSnapshotServiceError"
        this.statusCode = statusCode
    }
}

// ---------- helpers ----------

function integer(v) {
    const n = Number(v || 0)
    return Number.isFinite(n) ? Math.round(n) : 0
}

function roundPct(v, d = 1) {
    const m = Math.pow(10, d)
    return Math.round(Number(v || 0) * m) / m
}

function changePct(cur, prev) {
    const c = Number(cur || 0), p = Number(prev || 0)
    if (p === 0) return c === 0 ? 0 : null
    return roundPct(((c - p) / p) * 100)
}

function isoWeekKey(isoDate, tz) {
    const dt = DateTime.fromISO(isoDate, { zone: tz })
    return dt.isValid ? `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}` : null
}

// ---------- period ----------

function resolveWeeklyPeriod(now, timezone, explicitStart, explicitEnd) {
    if (explicitStart && explicitEnd) {
        return { start: explicitStart, end: explicitEnd }
    }
    const today = DateTime.isDateTime(now)
        ? now.setZone(timezone).startOf("day")
        : DateTime.fromJSDate(now, { zone: timezone }).startOf("day")
    // today.weekday: 1=Mon … 7=Sun.  The most recently completed
    // Sunday is exactly `today.weekday` days before today.
    const sunday = today.minus({ days: today.weekday })
    return {
        start: sunday.minus({ days: 6 }).toISODate(),
        end: sunday.toISODate(),
    }
}

// ---------- business ----------

async function loadBusiness(model, id) {
    const q = model.findOne(
        { businessId: id },
        "businessId businessType modules timezone currency hotelSettings",
    )
    return typeof q?.lean === "function" ? q.lean() : q
}

// ---------- comparison range ----------

function cmpRange(r) {
    return {
        preset: "custom",
        timezone: r.timezone,
        rolloverHour: r.rolloverHour,
        from: r.comparison.from,
        to: r.comparison.to,
        startUtc: r.comparison.startUtc,
        endUtcExclusive: r.comparison.endUtcExclusive,
    }
}

function zeroFin() {
    return { grossCents: 0, refundedCents: 0, netRetainedCents: 0, netToBusinessCents: 0, transactionCount: 0, averageTransactionValueCents: 0 }
}

function zeroTip() {
    return { totalTipsCents: 0, averageTipCents: 0, highestTipCents: 0, ordersWithTips: 0, tipRatePercent: 0 }
}

function foodPrevFin(shared) {
    const c = shared?.comparison || zeroFin()
    return { current: { ...c }, comparison: { ...zeroFin(), ...zeroTip() }, revenueByDay: [], hourlyOrders: [], averageTransactionValueComparisonPercent: null }
}

function lodgingPrevFin(shared) {
    const c = shared?.comparison || zeroFin()
    return { current: { ...c }, comparison: zeroFin(), revenueByDay: [], averageTransactionValueComparisonPercent: null }
}

// ---------- CRM ----------

async function buildCustomerSnapshot({
    businessId, periodFrom, periodTo, comparisonFrom, comparisonTo,
    visitorEmails, comparisonVisitorEmails,
    guestVisitModel = GuestVisit,
    guestProfileModel = GuestProfile,
}) {
    const pStart = new Date(`${periodFrom}T00:00:00.000Z`)
    const pEnd = new Date(`${DateTime.fromISO(periodTo, { zone: "UTC" }).plus({ days: 1 }).toISODate()}T00:00:00.000Z`)
    const cStart = new Date(`${comparisonFrom}T00:00:00.000Z`)
    const cEnd = new Date(`${DateTime.fromISO(comparisonTo, { zone: "UTC" }).plus({ days: 1 }).toISODate()}T00:00:00.000Z`)

    const [curAgg, cmpAgg, totalCust, consent, inactive, nw, pnw] = await Promise.all([
        guestVisitModel.aggregate([{ $match: { businessId, visitDate: { $gte: periodFrom, $lte: periodTo } } }, { $group: { _id: null, totalVisits: { $sum: 1 }, totalSpendCents: { $sum: "$spendCents" }, totalPaidOrders: { $sum: { $size: "$paidOrderIds" } } } }]).then(r => r?.[0] || {}),
        guestVisitModel.aggregate([{ $match: { businessId, visitDate: { $gte: comparisonFrom, $lte: comparisonTo } } }, { $group: { _id: null, totalVisits: { $sum: 1 }, totalSpendCents: { $sum: "$spendCents" } } }]).then(r => r?.[0] || {}),
        guestProfileModel.countDocuments({ businessId, guestStatus: "customer" }),
        guestProfileModel.countDocuments({ businessId, guestStatus: "customer", marketingConsent: true }),
        guestProfileModel.countDocuments({ businessId, guestStatus: "customer", lastVisitAt: { $lt: DateTime.fromISO(periodTo, { zone: "UTC" }).minus({ days: 90 }).toJSDate() } }),
        visitorEmails.length > 0 ? guestProfileModel.countDocuments({ businessId, email: { $in: visitorEmails }, guestStatus: "customer", firstCapturedAt: { $gte: pStart, $lt: pEnd } }) : 0,
        comparisonVisitorEmails.length > 0 ? guestProfileModel.countDocuments({ businessId, email: { $in: comparisonVisitorEmails }, guestStatus: "customer", firstCapturedAt: { $gte: cStart, $lt: cEnd } }) : 0,
    ])

    const dVis = visitorEmails.length
    const pVis = comparisonVisitorEmails.length

    return {
        activeCustomerCount: totalCust,
        newCustomers: integer(nw),
        previousNewCustomers: integer(pnw),
        returningCustomers: Math.max(0, dVis - nw),
        previousReturningCustomers: Math.max(0, pVis - pnw),
        distinctVisitors: dVis,
        previousDistinctVisitors: pVis,
        totalVisits: integer(curAgg.totalVisits),
        previousTotalVisits: integer(cmpAgg.totalVisits),
        totalSpendCents: integer(curAgg.totalSpendCents),
        previousTotalSpendCents: integer(cmpAgg.totalSpendCents),
        totalPaidOrders: integer(curAgg.totalPaidOrders),
        marketingConsentCount: consent,
        inactiveCount: inactive,
    }
}


async function buildFeedbackSnapshot({ businessId, periodFrom, periodTo, feedbackModel = Feedback }) {
    const pStart = new Date(`${periodFrom}T00:00:00.000Z`)
    const pEnd = new Date(`${DateTime.fromISO(periodTo, { zone: "UTC" }).plus({ days: 1 }).toISODate()}T00:00:00.000Z`)

    const [agg, negTags] = await Promise.all([
        feedbackModel.aggregate([
            { $match: { businessId, createdAt: { $gte: pStart, $lt: pEnd } } },
            {
                $group: {
                    _id: null,
                    reviewCount: { $sum: 1 },
                    averageRating: { $avg: "$overallRating" },
                    fourFiveStarCount: { $sum: { $cond: [{ $gte: ["$overallRating", 4] }, 1, 0] } },
                }
            }
        ]).then(r => r?.[0] || { reviewCount: 0, averageRating: null, fourFiveStarCount: 0 }),
        
        feedbackModel.aggregate([
            { $match: { businessId, createdAt: { $gte: pStart, $lt: pEnd }, sentiment: "negative" } },
            { $unwind: "$tags" },
            { $group: { _id: "$tags", count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ])
    ])

    const negativeThemes = negTags.map(t => ({
        theme: t._id,
        count: t.count,
        severity: "high"
    }))

    return {
        reviewCount: integer(agg.reviewCount),
        averageRating: roundPct(agg.averageRating || 0, 1) || null,
        csatPercent: agg.reviewCount > 0 ? roundPct((agg.fourFiveStarCount / agg.reviewCount) * 100, 0) : null,
        negativeThemes
    }
}

// ---------- main ----------

/**
 * @param {Object} opts
 * @param {string} opts.businessId
 * @param {string} [opts.periodStart]  YYYY-MM-DD in business tz
 * @param {string} [opts.periodEnd]
 * @param {Date}   [opts.now]
 * @returns {Object}
 */
export async function generateWeeklySnapshot({
    businessId,
    periodStart,
    periodEnd,
    now = new Date(),
    businessModel = Business,
    guestProfileModel = GuestProfile,
    guestVisitModel = GuestVisit,
    sharedAnalytics = getSharedAnalytics,
    foodServiceAnalytics = getFoodServiceAnalytics,
    lodgingAnalytics = getLodgingAnalytics,
}) {
    // 1. load business
    const biz = await loadBusiness(businessModel, businessId)
    if (!biz) throw new WeeklyAnalystSnapshotServiceError("Business not found", 404)

    const cap = resolveBusinessCapabilities(biz)
    const bizType = cap.identity.businessType
    const modules = cap.visibleModules
    const currency = (biz.currency || "EUR").toUpperCase()
    const tz = resolveAnalyticsTimezone(biz.timezone, "UTC")
    const hasFood = modules.includes("foodService")
    const hasLodge = modules.includes("lodging")

    // 2. period
    const { start: s, end: e } = resolveWeeklyPeriod(now, tz, periodStart, periodEnd)
    if (!s || !e) throw new WeeklyAnalystSnapshotServiceError("Could not determine period")
    const periodKey = isoWeekKey(s, tz)

    // 3. ranges
    const ranges = resolveAnalyticsDomainRanges({ preset: "custom", from: s, to: e, now, timezone: tz, business: biz })
    const fR = ranges.foodOperationalRange
    const lR = ranges.lodgingCalendarRange
    const payable = modules.filter(m => ["foodService", "lodging"].includes(m))

    // 4. shared + visitor emails
    const [shared, vis, cmpVis] = await Promise.all([
        sharedAnalytics({ businessId, enabledAnalyticsModules: payable, foodOperationalRange: fR, lodgingCalendarRange: lR }),
        guestVisitModel.distinct("email", { businessId, visitDate: { $gte: s, $lte: e } }),
        guestVisitModel.distinct("email", { businessId, visitDate: { $gte: fR.comparison.from, $lte: fR.comparison.to } }),
    ])

    const sFood = shared.foodServiceFinancials || null
    const sLodge = shared.lodgingFinancials || null

    // 5. all module + CRM calls
    const [fc, fp, lc, lp, crm, fb] = await Promise.all([
        hasFood && sFood ? foodServiceAnalytics({ businessId, analyticsRange: fR, financials: sFood }) : null,
        hasFood && sFood ? foodServiceAnalytics({ businessId, analyticsRange: cmpRange(fR), financials: foodPrevFin(sFood) }) : null,
        hasLodge && sLodge ? lodgingAnalytics({ businessId, analyticsRange: lR, financials: sLodge, generatedAt: now, hotelSettings: biz.hotelSettings || {} }) : null,
        hasLodge && sLodge ? lodgingAnalytics({ businessId, analyticsRange: cmpRange(lR), financials: lodgingPrevFin(sLodge), generatedAt: now, hotelSettings: biz.hotelSettings || {} }) : null,
        buildCustomerSnapshot({ businessId, periodFrom: s, periodTo: e, comparisonFrom: fR.comparison.from, comparisonTo: fR.comparison.to, visitorEmails: vis, comparisonVisitorEmails: cmpVis, guestVisitModel, guestProfileModel }),
    ])

    // ---------- shape ----------
    const sr = shared.shared?.paidRevenue || {}
    const cg = integer(sr.grossCents || 0)
    const pg = integer(sFood?.comparison?.grossCents || 0) + integer(sLodge?.comparison?.grossCents || 0)
    const ct = integer(sr.transactionCount || 0)
    const pt = integer(sFood?.comparison?.transactionCount || 0) + integer(sLodge?.comparison?.transactionCount || 0)

    const fco = fc?.overview || {}; const fpo = fp?.overview || {}
    const fcs = fc?.serviceRequests || {}; const fps = fp?.serviceRequests || {}
    const fctt = fc?.tips || {}; const fptt = fp?.tips || {}
    const lco = lc?.overview || {}; const lpo = lp?.overview || {}
    const lcl = lc?.lifecycle || {}

    const salesCents = {
        paidRevenueCents: cg,
        previousPaidRevenueCents: pg,
        revenueChangePercent: changePct(cg, pg),
        refundedCents: integer(sr.refundedCents || 0),
        netRetainedCents: integer(sr.netRetainedCents || 0),
        transactionCount: ct,
        previousTransactionCount: pt,
        transactionCountChangePercent: changePct(ct, pt),
        averageTransactionValueCents: integer(sr.averageTransactionValueCents || 0),
        previousAverageTransactionValueCents: pt > 0 ? Math.round(pg / pt) : 0,
        revenueByDay: (shared.shared?.revenueByDay || []).map(row => ({ date: row.date, grossCents: integer(row.grossCents), transactionCount: integer(row.transactionCount) })),
    }

    const ops = hasFood ? {
        activeOrders: integer(fco.activeOrders || 0),
        completedOrders: integer(fco.completedOrders || 0),
        previousCompletedOrders: integer(fpo.completedOrders || 0),
        completedOrdersChangePercent: changePct(fco.completedOrders, fpo.completedOrders),
        averagePrepTimeMinutes: integer(fco.averagePrepTimeMinutes || 0),
        previousAveragePrepTimeMinutes: integer(fpo.averagePrepTimeMinutes || 0),
        prepTimeChangePercent: changePct(fco.averagePrepTimeMinutes, fpo.averagePrepTimeMinutes),
        peakOrderHour: fco.peakOrderHour || null,
        totalItemsSold: integer(fco.totalItemsSold || 0),
        previousTotalItemsSold: integer(fpo.totalItemsSold || 0),
        itemsSoldChangePercent: changePct(fco.totalItemsSold, fpo.totalItemsSold),
    } : null

    const menu = hasFood ? {
        topItems: (fc?.topItems || []).map(it => ({ itemName: it.itemName, quantity: integer(it.quantity), paidItemRevenueCents: integer(it.paidItemRevenueCents), category: it.category || "uncategorized" })),
        previousTopItems: (fp?.topItems || []).map(it => ({ itemName: it.itemName, quantity: integer(it.quantity), paidItemRevenueCents: integer(it.paidItemRevenueCents), category: it.category || "uncategorized" })),
        categoryPerformance: (fc?.categoryPerformance || []).map(c => ({ category: c.category, quantity: integer(c.quantity), paidItemRevenueCents: integer(c.paidItemRevenueCents), percentageOfItemRevenue: roundPct(c.percentageOfItemRevenue || 0) })),
        previousCategoryPerformance: (fp?.categoryPerformance || []).map(c => ({ category: c.category, quantity: integer(c.quantity), paidItemRevenueCents: integer(c.paidItemRevenueCents), percentageOfItemRevenue: roundPct(c.percentageOfItemRevenue || 0) })),
        orderTypeBreakdown: fc?.orderTypeBreakdown || [],
        channelBreakdown: fc?.channelBreakdown || [],
    } : null

    const svc = hasFood ? {
        total: integer(fcs.total || 0),
        previousTotal: integer(fps.total || 0),
        totalChangePercent: changePct(fcs.total, fps.total),
        pending: integer(fcs.pending || 0),
        acknowledged: integer(fcs.acknowledged || 0),
        resolved: integer(fcs.resolved || 0),
        missed: integer(fcs.missed || 0),
        previousMissed: integer(fps.missed || 0),
        missedChangePercent: changePct(fcs.missed, fps.missed),
        averageResponseTimeSeconds: integer(fcs.averageResponseTimeSeconds || 0),
        previousAverageResponseTimeSeconds: integer(fps.averageResponseTimeSeconds || 0),
        responseTimeChangePercent: changePct(fcs.averageResponseTimeSeconds, fps.averageResponseTimeSeconds),
        averageResolutionTimeSeconds: integer(fcs.averageResolutionTimeSeconds || 0),
        previousAverageResolutionTimeSeconds: integer(fps.averageResolutionTimeSeconds || 0),
        resolutionTimeChangePercent: changePct(fcs.averageResolutionTimeSeconds, fps.averageResolutionTimeSeconds),
        byReason: fcs.byReason || {},
    } : null

    const sp = {}
    if (hasFood) sp.foodService = (fc?.servicePointPerformance || []).map(x => ({ servicePointId: x.servicePointId, label: x.label, code: x.code, servicePointType: x.servicePointType, orderCount: integer(x.orderCount), paidOrders: integer(x.paidOrders), unpaidOrders: integer(x.unpaidOrders), paidRevenueCents: integer(x.paidRevenueCents), averagePaidOrderValueCents: integer(x.averagePaidOrderValueCents) }))
    if (hasLodge) sp.lodging = (lc?.roomRevenuePerformance || []).map(x => ({ servicePointId: x.servicePointId, label: x.label, code: x.code, paidBookingCount: integer(x.paidBookingCount), paidRevenueCents: integer(x.paidRevenueCents), averageBookingValueCents: integer(x.averageBookingValueCents), totalNights: integer(x.totalNights) }))

    const staff = {}
    if (hasFood) staff.foodService = (fc?.staffPerformance || []).map(x => ({ staffId: x.staffId, name: x.name, callsAcknowledged: integer(x.callsAcknowledged), callsResolved: integer(x.callsResolved), averageResponseTimeSeconds: integer(x.averageResponseTimeSeconds), averageResolutionTimeSeconds: integer(x.averageResolutionTimeSeconds), ordersServed: integer(x.ordersServed), paymentsConfirmed: integer(x.paymentsConfirmed), totalOfflinePaymentsConfirmedCents: integer(x.totalOfflinePaymentsConfirmedCents) }))
    if (hasLodge) staff.lodging = {
        checkIns: (lc?.checkInStaffPerformance || []).map(x => ({ staffId: x.staffId, name: x.name, checkInsCompleted: integer(x.checkInsCompleted), averageCheckInDelayMinutes: roundPct(x.averageCheckInDelayMinutes || 0) })),
        checkOuts: (lc?.checkOutStaffPerformance || []).map(x => ({ staffId: x.staffId, name: x.name, checkOutsCompleted: integer(x.checkOutsCompleted), averageCheckoutDelayMinutes: roundPct(x.averageCheckoutDelayMinutes || 0) })),
    }

    const cust = {
        activeCustomerCount: integer(crm.activeCustomerCount),
        newCustomers: integer(crm.newCustomers),
        previousNewCustomers: integer(crm.previousNewCustomers),
        newCustomersChangePercent: changePct(crm.newCustomers, crm.previousNewCustomers),
        returningCustomers: integer(crm.returningCustomers),
        previousReturningCustomers: integer(crm.previousReturningCustomers),
        returningCustomersChangePercent: changePct(crm.returningCustomers, crm.previousReturningCustomers),
        distinctVisitors: integer(crm.distinctVisitors),
        previousDistinctVisitors: integer(crm.previousDistinctVisitors),
        totalVisits: integer(crm.totalVisits),
        previousTotalVisits: integer(crm.previousTotalVisits),
        guestSpendCents: integer(crm.totalSpendCents),
        previousGuestSpendCents: integer(crm.previousTotalSpendCents),
        totalPaidOrders: integer(crm.totalPaidOrders),
        marketingConsentCount: integer(crm.marketingConsentCount),
        inactiveCount: integer(crm.inactiveCount),
    }

    const res = hasLodge ? {
        paidBookingRevenueCents: integer(lco.paidBookingRevenueCents || 0),
        previousPaidBookingRevenueCents: integer(lpo.paidBookingRevenueCents || 0),
        paidBookingRevenueChangePercent: changePct(lco.paidBookingRevenueCents, lpo.paidBookingRevenueCents),
        paidBookingCount: integer(lco.paidBookingCount || 0),
        previousPaidBookingCount: integer(lpo.paidBookingCount || 0),
        averageLengthOfStayNights: roundPct(lco.averageLengthOfStayNights || 0),
        confirmations: { count: integer(lcl.confirmations?.count || 0), comparisonPercent: lcl.confirmations?.comparisonPercent ?? null },
        cancellations: { count: integer(lcl.cancellations?.count || 0), comparisonPercent: lcl.cancellations?.comparisonPercent ?? null, cancelledBookingCohortRatePercent: lcl.cancellations?.cancelledBookingCohortRatePercent ?? null },
        arrivals: { scheduled: integer(lc?.arrivals?.scheduled || 0), checkedIn: integer(lc?.arrivals?.checkedIn || 0), pending: integer(lc?.arrivals?.pending || 0) },
        departures: { scheduled: integer(lc?.departures?.scheduled || 0) },
        occupancy: { occupiedRoomNights: integer(lc?.occupancy?.occupiedRoomNights || 0), availableRoomNights: integer(lc?.occupancy?.availableRoomNights || 0), occupancyRatePercent: lc?.occupancy?.occupancyRatePercent ?? null },
        reservationStatusBreakdown: lc?.reservationStatusBreakdown || [],
        paymentStatusBreakdown: lc?.paymentStatusBreakdown || [],
        bookingSourceBreakdown: lc?.bookingSourceBreakdown || [],
    } : null

    const tips = hasFood ? {
        totalTipsCents: integer(fctt.totalTipsCents || 0),
        previousTotalTipsCents: integer(fptt.totalTipsCents || 0),
        totalTipsChangePercent: changePct(fctt.totalTipsCents, fptt.totalTipsCents),
        averageTipCents: integer(fctt.averageTipCents || 0),
        highestTipCents: integer(fctt.highestTipCents || 0),
        ordersWithTips: integer(fctt.ordersWithTips || 0),
        tipRatePercent: roundPct(fctt.tipRatePercent || 0),
        previousTipRatePercent: roundPct(fptt.tipRatePercent || 0),
    } : null

    return {
        schemaVersion: 1,
        period: { key: periodKey, start: s, end: e, previousStart: fR.comparison.from, previousEnd: fR.comparison.to, timezone: tz },
        business: { businessType: bizType, currency, modules: [...modules] },
        sales: salesCents,
        operations: ops,
        menu,
        service: svc,
        servicePoints: sp,
        staff,
        customers: cust,
        feedback: fb,
        reservations: res,
        tipsPayments: tips,
    }
}

export default generateWeeklySnapshot