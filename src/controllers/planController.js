import Plan from "../models/Plan.js"

export async function getPlans(req, res) {
    try {
        const plans = await Plan.find().sort({ monthlyFee: 1 })
        return res.json(plans)
    } catch (err) {
        console.error("Get plans error:", err)
        return res.status(500).json({ message: "Server error fetching plans" })
    }
}

export async function updatePlan(req, res) {
    try {
        const { id } = req.params
        const { commissionPercentage, monthlyFee, isActive } = req.body

        const plan = await Plan.findByIdAndUpdate(
            id,
            { 
                $set: { 
                    commissionPercentage, 
                    monthlyFee, 
                    isActive 
                } 
            },
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
            { name: "Basic", commissionPercentage: 2.5, monthlyFee: 0 },
            { name: "Starter", commissionPercentage: 2.5, monthlyFee: 39 },
            { name: "Growth", commissionPercentage: 2.5, monthlyFee: 79 },
            { name: "Enterprise", commissionPercentage: 2, monthlyFee: 119 },
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
