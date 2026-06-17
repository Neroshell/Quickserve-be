import Plan from "../models/Plan.js"

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

        return res.json(plan)
    } catch (err) {
        console.error("Update plan error:", err)
        return res.status(500).json({ message: "Server error updating plan" })
    }
}

// Internal seeding helper
export async function seedPlans(req, res) {
    try {
        const defaultPlans = [
            { name: "Basic", slug: "basic", offlineCommissionRate: 2.5, monthlyPrice: 0 },
            { name: "Growth", slug: "growth", offlineCommissionRate: 3.0, monthlyPrice: 0 },
            { name: "Enterprise", slug: "enterprise", offlineCommissionRate: 4.0, monthlyPrice: 0 },
        ]

        for (const p of defaultPlans) {
            await Plan.findOneAndUpdate(
                { name: p.name },
                { $setOnInsert: p },
                { upsert: true, new: true }
            )
        }

        const plans = await Plan.find()
        return res.json({ message: "Plans seeded successfully", plans })
    } catch (err) {
        console.error("Seed plans error:", err)
        return res.status(500).json({ message: "Server error seeding plans" })
    }
}
