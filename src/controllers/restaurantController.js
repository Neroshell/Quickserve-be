import Restaurant from "../models/Restaurant.js"

export async function getSettings(req, res) {
    try {
        const restaurantId = req.query.restaurantId || process.env.NEXT_PUBLIC_RESTAURANT_ID || "default-restaurant-id"

        let restaurant = await Restaurant.findOne({ restaurantId })

        if (!restaurant) {
            // Create a default restaurant record if it doesn't exist
            restaurant = await Restaurant.create({
                restaurantId,
                name: "My Restaurant",
                displayName: "New Restaurant",
                slug: `restaurant-${Date.now()}`,
                currency: "USD",
                timezone: "America/New_York",
                operatingHours: {
                    Monday: { enabled: true, openTime: "09:00", closeTime: "22:00" },
                    Tuesday: { enabled: true, openTime: "09:00", closeTime: "22:00" },
                    Wednesday: { enabled: true, openTime: "09:00", closeTime: "22:00" },
                    Thursday: { enabled: true, openTime: "09:00", closeTime: "22:00" },
                    Friday: { enabled: true, openTime: "09:00", closeTime: "23:00" },
                    Saturday: { enabled: true, openTime: "10:00", closeTime: "23:00" },
                    Sunday: { enabled: false, openTime: "10:00", closeTime: "22:00" }
                }
            })
        }

        return res.json(restaurant)
    } catch (err) {
        console.error("Get settings error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateSettings(req, res) {
    try {
        const { restaurantId, ...updates } = req.body

        if (!restaurantId) {
            return res.status(400).json({ message: "restaurantId is required" })
        }

        // Slug validation if being updated
        if (updates.slug) {
            const slugRegex = /^[a-z0-9-]+$/
            if (!slugRegex.test(updates.slug)) {
                return res.status(400).json({ message: "Slug: lowercase, letters, numbers, hyphens only" })
            }
            if (updates.slug.length < 3 || updates.slug.length > 40) {
                return res.status(400).json({ message: "Slug must be between 3 and 40 characters" })
            }

            const existing = await Restaurant.findOne({ slug: updates.slug, restaurantId: { $ne: restaurantId } })
            if (existing) {
                return res.status(400).json({ message: "Slug already in use" })
            }
        }

        const restaurant = await Restaurant.findOneAndUpdate(
            { restaurantId },
            { $set: updates },
            { new: true, runValidators: true }
        )

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        return res.json(restaurant)
    } catch (err) {
        console.error("Update settings error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateOperatingHours(req, res) {
    try {
        const { restaurantId, operatingHours } = req.body

        if (!restaurantId || !operatingHours) {
            return res.status(400).json({ message: "restaurantId and operatingHours are required" })
        }

        const restaurant = await Restaurant.findOneAndUpdate(
            { restaurantId },
            { $set: { operatingHours } },
            { new: true, runValidators: true }
        )

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        return res.json(restaurant)
    } catch (err) {
        console.error("Update operating hours error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}
