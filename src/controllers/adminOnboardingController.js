import Business from "../models/Business.js"
import { invalidateBusinessConfiguration } from "../services/cacheInvalidationService.js"
import { withReservationEligibilityFence } from "../services/reservationEligibilityService.js"

function completionReason(value) {
    if (typeof value !== "string") return null
    const normalized = value.trim()
    if (normalized.length < 3 || normalized.length > 500) return null
    return normalized
}

export async function completeAdminBusinessOnboarding(req, res, { businessModel = Business, invalidateConfiguration = invalidateBusinessConfiguration } = {}) {
    try {
        const platformAdminEmail = typeof req.platformAdmin?.email === "string"
            ? req.platformAdmin.email.trim().toLowerCase()
            : ""
        if (!platformAdminEmail) {
            return res.status(403).json({ message: "Platform administrator authorization is required." })
        }
        const reason = completionReason(req.body?.reason)
        if (!reason) {
            return res.status(400).json({ message: "A completion reason between 3 and 500 characters is required." })
        }
        const paramId = req.params?.businessId
        if (!paramId) {
            return res.status(400).json({ message: "businessId is required" })
        }

        const existingQuery = businessModel.findOne({
            $or: [{ businessId: paramId }, { businessId: paramId }],
        }).select("businessId onboardingCompleted")
        const existing = typeof existingQuery?.lean === "function" ? await existingQuery.lean() : await existingQuery
        if (!existing) {
            return res.status(404).json({ message: "Business not found" })
        }
        if (existing.onboardingCompleted === true) {
            return res.json({ success: true, alreadyCompleted: true, businessId: existing.businessId })
        }

        const completedAt = new Date()
        const business = await businessModel.findOneAndUpdate(
            { businessId: existing.businessId, onboardingCompleted: { $ne: true } },
            withReservationEligibilityFence({
                $set: {
                    onboardingCompleted: true,
                    onboardingCompletedAt: completedAt,
                    onboardingCompletionAudit: {
                        source: "platform_admin",
                        completedAt,
                        completedByPlatformAdminEmail: platformAdminEmail,
                        reason,
                    },
                },
            }, completedAt),
            { new: true, runValidators: true },
        )
        if (!business) {
            return res.status(409).json({ message: "Onboarding completion changed concurrently. Please retry." })
        }

        await invalidateConfiguration(business.businessId)
        return res.json({
            success: true,
            alreadyCompleted: false,
            businessId: business.businessId,
        })
    } catch (error) {
        console.error("[adminOnboarding.complete]", error)
        return res.status(500).json({ message: "Unable to complete business onboarding" })
    }
}
