const CATEGORY_MATCHERS = [
    ["feedback", /feedback|review|rating/],
    ["inventory", /inventory|stock|ingredient shortage|waste/],
    ["reservations", /reservation|booking|occupancy/],
    ["servicePoints", /service point|table|room performance/],
    ["tipsPayments", /tip|payment/],
    ["staff", /team|staff/],
    ["menu", /menu|item performance/],
    ["operations", /kitchen|preparation|operation|order speed/],
    ["customers", /repeat customer|returning customer|retention|visitor/],
    ["revenue", /sale|revenue|customer spending|transaction|average order/],
    ["service", /service|waiter call|response time/],
]

function categoryForArea(area) {
    const normalized = String(area || "").trim().toLowerCase()
    return CATEGORY_MATCHERS.find(([, matcher]) => matcher.test(normalized))?.[0] || null
}

function hasArrayEntries(value) {
    if (Array.isArray(value)) return value.length > 0
    if (!value || typeof value !== "object") return false
    return Object.values(value).some(hasArrayEntries)
}

function domainHasData(category, snapshot) {
    if (!snapshot || !category) return null

    switch (category) {
        case "revenue":
            return Number(snapshot.sales?.transactionCount || 0) > 0
        case "operations":
            return Number(snapshot.operations?.completedOrders || 0) > 0
        case "menu":
            return (snapshot.menu?.topItems || []).length > 0
        case "service":
            return Number(snapshot.service?.total || 0) > 0
        case "customers":
            return Number(snapshot.customers?.distinctVisitors || 0) > 0
        case "feedback":
            return Number(snapshot.feedback?.current?.reviewCount || 0) > 0
        case "inventory":
            return Number(snapshot.inventory?.current?.totalMovementCount || 0) > 0 ||
                Number(snapshot.inventory?.current?.ingredientShortages?.eventCount || 0) > 0 ||
                (snapshot.inventory?.stockHealthAsOf?.periodAligned === true &&
                    Number(snapshot.inventory?.stockHealthAsOf?.activeItems || 0) > 0)
        case "reservations":
            return Number(snapshot.reservations?.paidBookingCount || 0) > 0
        case "staff":
            return hasArrayEntries(snapshot.staff)
        case "servicePoints":
            return hasArrayEntries(snapshot.servicePoints)
        case "tipsPayments":
            return Number(snapshot.sales?.transactionCount || 0) > 0
        default:
            return null
    }
}

function statusForInsights(insights) {
    const warnings = insights.filter((insight) => insight?.type === "warning")
    if (warnings.length > 0) {
        const elevated = warnings.some((insight) =>
            ["critical", "high"].includes(insight?.priority) ||
            insight?.impact === "high"
        )
        return elevated ? "Strained" : "Watch"
    }
    if (insights.some((insight) => insight?.type === "positive")) {
        return "Healthy"
    }
    return "Stable"
}

function statusForChange(value, { lowerIsBetter = false } = {}) {
    const change = Number(value)
    if (!Number.isFinite(change) || change === 0) return "Stable"

    const favorable = lowerIsBetter ? change < 0 : change > 0
    if (favorable) return "Healthy"
    return Math.abs(change) >= 25 ? "Strained" : "Watch"
}

function statusForSnapshot(category, snapshot) {
    switch (category) {
        case "revenue":
            return statusForChange(snapshot?.sales?.revenueChangePercent)
        case "operations": {
            const prepChange = snapshot?.operations?.prepTimeChangePercent
            if (Number.isFinite(Number(prepChange)) && Number(prepChange) !== 0) {
                return statusForChange(prepChange, { lowerIsBetter: true })
            }
            return statusForChange(snapshot?.operations?.completedOrdersChangePercent)
        }
        case "customers":
            return statusForChange(snapshot?.customers?.returningCustomersChangePercent)
        case "feedback": {
            const rating = Number(snapshot?.feedback?.current?.averageRating)
            if (!Number.isFinite(rating)) return "Stable"
            if (rating >= 4) return "Healthy"
            if (rating < 2.5) return "Strained"
            if (rating < 3.5) return "Watch"
            return "Stable"
        }
        case "inventory": {
            const shortages = Number(
                snapshot?.inventory?.current?.ingredientShortages?.eventCount || 0,
            )
            const stock = snapshot?.inventory?.stockHealthAsOf
            const outOfStock = stock?.periodAligned === true
                ? Number(stock.outOfStockItems || 0)
                : 0
            const lowStock = stock?.periodAligned === true
                ? Number(stock.lowStockItems || 0)
                : 0
            const wasteEvents = Number(
                snapshot?.inventory?.current?.countsByType?.WASTE || 0,
            )
            if (shortages >= 5 || outOfStock >= 3) return "Strained"
            if (shortages > 0 || outOfStock > 0 || lowStock >= 2 || wasteEvents >= 3) {
                return "Watch"
            }
            return "Stable"
        }
        case "reservations":
            return statusForChange(snapshot?.reservations?.paidBookingRevenueChangePercent)
        case "tipsPayments":
            return statusForChange(snapshot?.tipsPayments?.totalTipsChangePercent)
        case "service": {
            const missedChange = snapshot?.service?.missedChangePercent
            if (Number.isFinite(Number(missedChange)) && Number(missedChange) !== 0) {
                return statusForChange(missedChange, { lowerIsBetter: true })
            }
            return statusForChange(snapshot?.service?.responseTimeChangePercent, { lowerIsBetter: true })
        }
        default:
            return "Stable"
    }
}

/**
 * Treat generated prose as presentation, never as the source of truth for
 * health status. Statuses are derived from the deterministic insight engine
 * and from whether the relevant snapshot contains evidence.
 */
export function normalizeBusinessHealth(
    generatedReport,
    deterministicInsights,
    analyticsSnapshot,
) {
    if (!generatedReport || !Array.isArray(generatedReport.businessHealth)) {
        return generatedReport
    }

    const insights = Array.isArray(deterministicInsights?.insights)
        ? deterministicInsights.insights
        : []

    return {
        ...generatedReport,
        businessHealth: generatedReport.businessHealth.map((entry) => {
            const category = categoryForArea(entry?.area)
            const hasData = domainHasData(category, analyticsSnapshot)
            const matchingInsights = category
                ? insights.filter((insight) => insight?.category === category)
                : []

            let status = "Stable"
            if (deterministicInsights?.insufficientData || hasData === false) {
                status = "Insufficient data"
            } else if (matchingInsights.length > 0) {
                status = statusForInsights(matchingInsights)
            } else if (category) {
                status = statusForSnapshot(category, analyticsSnapshot)
            }

            return { ...entry, status }
        }),
    }
}
