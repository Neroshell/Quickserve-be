import { resolveAnalyticsRange } from "./analyticsRangeService.js"
import { getFoodServiceAnalytics } from "./foodServiceAnalyticsService.js"

/**
 * Phase 1 analytics orchestration.
 *
 * The legacy flat DTO remains intact while the food-service implementation is
 * isolated behind a domain service. Capability-driven lodging orchestration is
 * intentionally deferred.
 */
export function createOwnerAnalyticsService({
    rangeResolver = resolveAnalyticsRange,
    foodServiceAnalytics = getFoodServiceAnalytics,
} = {}) {
    return async function ownerAnalyticsService({
        businessId,
        range = "today",
        from,
        to,
    }) {
        const analyticsRange = rangeResolver({
            preset: range,
            from,
            to,
        })

        return foodServiceAnalytics({
            businessId,
            analyticsRange,
        })
    }
}

export const ownerAnalyticsService = createOwnerAnalyticsService()
