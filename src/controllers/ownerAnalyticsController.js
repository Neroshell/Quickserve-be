import { AnalyticsRangeError } from "../services/analytics/analyticsRangeService.js"
import { ownerAnalyticsService } from "../services/analytics/ownerAnalyticsService.js"

export function createOwnerAnalyticsController({
    getAnalytics = ownerAnalyticsService,
} = {}) {
    return async function ownerAnalytics(req, res) {
        try {
            const businessId = req.session?.user?.businessId
            if (!businessId) {
                return res
                    .status(400)
                    .json({ error: "businessId is required" })
            }

            const { range = "today", from, to } = req.query
            const result = await getAnalytics({
                businessId,
                range,
                from,
                to,
            })

            return res.json(result)
        } catch (error) {
            if (error instanceof AnalyticsRangeError) {
                return res
                    .status(error.statusCode)
                    .json({ error: error.message })
            }

            console.error("[ownerAnalytics]", error)
            return res
                .status(500)
                .json({ error: "Failed to generate owner analytics" })
        }
    }
}

export const ownerAnalytics = createOwnerAnalyticsController()
