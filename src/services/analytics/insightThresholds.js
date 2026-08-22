/**
 * Centralized insight engine configuration.
 *
 * Every threshold, sample-size minimum, materiality rule, confidence factor,
 * impact weight, and priority formula lives here so the Insight Engine can be
 * tuned without touching rule functions.
 *
 * All monetary values are in **integer cents** (same as the snapshot).
 */

// ---------------------------------------------------------------------------
// Minimum sample sizes — below these thresholds, no insight is generated
// for the affected metric regardless of percentage change.
// ---------------------------------------------------------------------------

export const MIN_SAMPLE_SIZES = Object.freeze({
    transactions: 10,
    completedOrders: 10,
    serviceCalls: 10,
    missedCallBaseline: 3,
    visitors: 5,
    tippedOrders: 5,
    menuItemQuantity: 5,
    servicePointOrders: 5,
    staffActivity: 5,
    bookings: 5,
    checkIns: 5,
})

// ---------------------------------------------------------------------------
// Data sufficiency — overall check independent of week-over-week changes.
// If no modules have meaningful activity, the business does not have
// sufficient data for ANY insights.
// ---------------------------------------------------------------------------

export const DATA_SUFFICIENCY = Object.freeze({
    /** Minimum transactions for food-service data to be "sufficient" */
    minFoodTransactions: 3,
    /** Minimum bookings for lodging data to be "sufficient" */
    minLodgingBookings: 1,
})

// ---------------------------------------------------------------------------
// Materiality — minimum relative and/or absolute change before a rule fires.
// Both thresholds must be met (AND) where both are specified.
// ---------------------------------------------------------------------------

export const MATERIALITY = Object.freeze({
    revenueMinChangePercent: 10,
    revenueMinAbsoluteCents: 10_00, // €10.00

    transactionCountMinChangePercent: 10,

    aovMinChangePercent: 10,

    prepTimeMinChangeMinutes: 3,
    prepTimeMinChangePercent: 15,

    completedOrdersMinChangePercent: 10,

    itemsSoldMinChangePercent: 10,

    serviceResponseMinChangeSeconds: 15,
    serviceResponseMinChangePercent: 20,

    serviceResolutionMinChangeSeconds: 20,
    serviceResolutionMinChangePercent: 20,

    missedCallsMinAbsoluteIncrease: 2,

    customerMinChangePercent: 15,

    menuItemMinSharePercent: 5,
    menuItemMinChangePercent: 20,
    menuItemMinQuantity: 5,

    servicePointMinDeviationFactor: 2.0,

    tipRateMinChangePercent: 10,

    bookingRevenueMinChangePercent: 10,
    bookingRevenueMinAbsoluteCents: 10_00,

    cancellationMinChangePercent: 25,
    cancellationMinAbsolute: 2,
})

// ---------------------------------------------------------------------------
// Confidence scoring
//   confidenceScore = sampleFactor × comparisonFactor × strengthFactor
//   clamped [0,1] → low (<0.40), medium (0.40-0.69), high (≥0.70)
// ---------------------------------------------------------------------------

export const CONFIDENCE = Object.freeze({
    sampleFactor: (actual, minimum) => {
        if (minimum <= 0) return 0
        const ratio = actual / minimum
        if (ratio >= 10) return 1.0
        if (ratio >= 5) return 0.85
        if (ratio >= 3) return 0.7
        if (ratio >= 2) return 0.55
        if (ratio >= 1) return 0.4
        return 0
    },
    comparisonFactor: (hasValidPrevious) =>
        hasValidPrevious ? 1.0 : 0.3,
    strengthFactor: (actualChangePercent, minChangePercent) => {
        if (minChangePercent <= 0) return 0.5
        const ratio = actualChangePercent / minChangePercent
        if (ratio >= 4) return 1.0
        if (ratio >= 2) return 0.8
        if (ratio >= 1.5) return 0.65
        if (ratio >= 1) return 0.5
        return 0.3
    },
    tier: (score) => {
        if (score >= 0.7) return "high"
        if (score >= 0.4) return "medium"
        return "low"
    },
})

// ---------------------------------------------------------------------------
// Impact scoring — category-aware.
//
// Each category uses only dimensions that are semantically meaningful.
// ---------------------------------------------------------------------------

function volumeWt(count) {
    if (count >= 200) return 1.0
    if (count >= 100) return 0.85
    if (count >= 50) return 0.7
    if (count >= 20) return 0.5
    if (count >= 10) return 0.35
    if (count >= 5) return 0.2
    return 0.1
}

function revenueWt(cents) {
    if (cents >= 500_00) return 1.0
    if (cents >= 200_00) return 0.8
    if (cents >= 50_00) return 0.6
    if (cents >= 10_00) return 0.4
    if (cents > 0) return 0.2
    return 0.1
}

function shareWt(pct) {
    if (pct >= 50) return 1.0
    if (pct >= 30) return 0.8
    if (pct >= 15) return 0.6
    if (pct >= 5) return 0.4
    return 0.2
}

/**
 * Category-aware impact score.
 *
 * @param {"revenue"|"operations"|"service"|"customers"|"menu"|"servicePoints"|"staff"|"reservations"|"tipsPayments"} category
 * @param {Object} inputs
 */
export function impactScore(category, inputs = {}) {
    const { revenueCents = 0, volume = 0, sharePercent = 0 } = inputs
    switch (category) {
        case "revenue":
            return Math.min(1, revenueWt(Math.abs(revenueCents)) * volumeWt(volume) * 0.6 + volumeWt(volume) * 0.4)

        case "operations":
            // affected order volume + prep-time severity
            return Math.min(1, volumeWt(volume) * 0.7 + (Math.abs(revenueCents) > 0 ? 0.3 : 0))

        case "service":
            // service-call volume + severity of deterioration
            return Math.min(1, volumeWt(volume))

        case "customers":
            // visitor/customer volume
            return Math.min(1, volumeWt(volume))

        case "menu":
            // revenue + share + quantity
            return Math.min(1, revenueWt(Math.abs(revenueCents)) * 0.5 + shareWt(sharePercent) * 0.3 + volumeWt(volume) * 0.2)

        case "servicePoints":
            // revenue + order volume + concentration
            return Math.min(1, revenueWt(Math.abs(revenueCents)) * 0.4 + volumeWt(volume) * 0.3 + shareWt(sharePercent) * 0.3)

        case "staff":
            // attributed activity volume
            return Math.min(1, volumeWt(volume))

        case "reservations":
            // booking volume + booking revenue
            return Math.min(1, volumeWt(volume) * 0.5 + revenueWt(Math.abs(revenueCents)) * 0.5)

        case "tipsPayments":
            // eligible/tipped order volume
            return Math.min(1, volumeWt(volume) * 0.7 + revenueWt(Math.abs(revenueCents)) * 0.3)

        default:
            return 0.1
    }
}

export function impactTier(score) {
    if (score >= 0.7) return "high"
    if (score >= 0.4) return "medium"
    return "low"
}

// ---------------------------------------------------------------------------
// Priority scoring
//   priorityScore = (impactScore × 0.6 + confidenceScore × 0.4) × 100
//   tier: high (≥66), medium (≥33), low (<33)
// ---------------------------------------------------------------------------

export const PRIORITY = Object.freeze({
    calculate: (impactScore, confidenceScore) =>
        Math.round((impactScore * 0.6 + confidenceScore * 0.4) * 100),
    tier: (score) => {
        if (score >= 66) return "high"
        if (score >= 33) return "medium"
        return "low"
    },
})

// ---------------------------------------------------------------------------
// Output caps
// ---------------------------------------------------------------------------

export const OUTPUT = Object.freeze({ maxPrimary: 5 })

// ---------------------------------------------------------------------------
// Diversity tie-breaking
// ---------------------------------------------------------------------------

export const DIVERSITY = Object.freeze({ tieThreshold: 5 })

// ---------------------------------------------------------------------------
// Deduplication groups
// ---------------------------------------------------------------------------

export const DEDUP_GROUPS = Object.freeze({
    volume: new Set([
        "revenue_decline", "revenue_growth",
        "transaction_decline", "transaction_growth",
        "completed_orders_decline", "completed_orders_growth",
        "items_sold_decline", "items_sold_growth",
    ]),
    serviceSpeed: new Set([
        "service_response_deterioration", "service_response_improvement",
        "service_resolution_deterioration", "service_resolution_improvement",
    ]),
    customerBase: new Set([
        "new_customers_growth", "new_customers_decline",
        "returning_customers_growth", "returning_customers_decline",
        "distinct_visitors_growth", "distinct_visitors_decline",
    ]),
    bookingVolume: new Set([
        "booking_revenue_growth", "booking_revenue_decline",
    ]),
})

// ---------------------------------------------------------------------------
// Direction helpers
// ---------------------------------------------------------------------------

/**
 * Classify an insight's type.
 *   AOV: increase→positive, decline→warning (no "opportunity")
 */
export function classifyType(metric, changePercent, isFavorableResult) {
    if (changePercent === null || changePercent === 0) return "info"
    if (isFavorableResult === true) return "positive"
    if (isFavorableResult === false) return "warning"
    // aov — not inherently good/bad, but classify directionally
    if (metric === "aov") return changePercent > 0 ? "positive" : "warning"
    if (metric === "cancellations") return changePercent > 0 ? "warning" : "positive"
    if (metric === "prepTime") return changePercent > 0 ? "warning" : "positive"
    if (metric === "serviceResponseTime" || metric === "serviceResolutionTime") return changePercent > 0 ? "warning" : "positive"
    if (metric === "missedCalls") return changePercent > 0 ? "warning" : "positive"
    return "info"
}