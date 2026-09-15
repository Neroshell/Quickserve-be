import Business from "../models/Business.js"
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js"

export function requireBusinessModule(moduleId) {
    return async function businessModuleMiddleware(req, res, next) {
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" })
        }

        try {
            const business = await Business.findOne({ businessId })
                .select("businessId businessType modules")
                .lean()
            if (!business) {
                return res.status(404).json({
                    error: "Business not found",
                    code: "BUSINESS_NOT_FOUND",
                })
            }
            if (!resolveBusinessCapabilities(business).visibleModules.includes(moduleId)) {
                return res.status(403).json({
                    error: "This business capability is not enabled",
                    code: "BUSINESS_MODULE_NOT_ENABLED",
                })
            }
            return next()
        } catch (error) {
            console.error("[businessCapabilityMiddleware]", error)
            return res.status(500).json({
                error: "Business capability could not be verified",
                code: "BUSINESS_CAPABILITY_CHECK_FAILED",
            })
        }
    }
}
