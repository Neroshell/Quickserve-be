import Plan from "../models/Plan.js"
import Business from "../models/Business.js"
import { invalidatePublicBusinessConfigs } from "../services/cacheInvalidationService.js"

export async function getPlans(req, res) {
    try {
        const plans = await Plan.find().sort({ monthlyPrice: 1 })
        return res.json(plans)
    } catch (err) {
        console.error("Get plans error:", err)
        return res.status(500).json({ message: "Server error fetching plans" })
    }
}

export async function updatePlan(req, res) {
    try {
        const { id } = req.params
        const { offlineCommissionRate, monthlyPrice, currency, isActive } = req.body

        // Only set fields that were actually provided, so a partial update
        // doesn't wipe other values.
        const updates = {}
        if (offlineCommissionRate !== undefined) updates.offlineCommissionRate = offlineCommissionRate
        if (monthlyPrice !== undefined) updates.monthlyPrice = monthlyPrice
        if (currency !== undefined) updates.currency = currency
        if (isActive !== undefined) updates.isActive = isActive

        const plan = await Plan.findByIdAndUpdate(
            id,
            { $set: updates },
            { new: true, runValidators: true }
        )

        if (!plan) {
            return res.status(404).json({ message: "Plan not found" })
        }

        // Public business config embeds the plan commission rate. Plan edits
        // are rare platform-admin operations, so invalidate every tenant's
        // public config without introducing wildcard cache deletion.
        try {
            const businesses = await Business.find({})
                .select("businessId")
                .lean()
            await invalidatePublicBusinessConfigs(
                businesses.map(business => business.businessId)
            )
        } catch (invalidationError) {
            console.error(
                "[Cache] Failed to enumerate public-config keys after plan update",
                invalidationError?.code || invalidationError?.name || "invalidation_error",
            )
        }

        return res.json(plan)
    } catch (err) {
        console.error("Update plan error:", err)
        return res.status(500).json({ message: "Server error updating plan" })
    }
}


