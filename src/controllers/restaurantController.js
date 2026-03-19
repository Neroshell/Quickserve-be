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

export async function updateOrderingPreferences(req, res) {
    try {
        const { restaurantId, orderingPreferences } = req.body

        if (!restaurantId || !orderingPreferences) {
            return res.status(400).json({ message: "restaurantId and orderingPreferences are required" })
        }

        // Only allow the known boolean fields to be updated
        const { dineInEnabled, takeoutEnabled, callWaiterEnabled, hideOutOfStockItems, qrOrderingEnabled } = orderingPreferences
        const safePrefs = {}
        if (typeof dineInEnabled === "boolean") safePrefs["orderingPreferences.dineInEnabled"] = dineInEnabled
        if (typeof takeoutEnabled === "boolean") safePrefs["orderingPreferences.takeoutEnabled"] = takeoutEnabled
        if (typeof callWaiterEnabled === "boolean") safePrefs["orderingPreferences.callWaiterEnabled"] = callWaiterEnabled
        if (typeof hideOutOfStockItems === "boolean") safePrefs["orderingPreferences.hideOutOfStockItems"] = hideOutOfStockItems
        if (typeof qrOrderingEnabled === "boolean") safePrefs["orderingPreferences.qrOrderingEnabled"] = qrOrderingEnabled

        const restaurant = await Restaurant.findOneAndUpdate(
            { restaurantId },
            { $set: safePrefs },
            { new: true, runValidators: true }
        )

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        return res.json({ orderingPreferences: restaurant.orderingPreferences })
    } catch (err) {
        console.error("Update ordering preferences error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updatePaymentPreferences(req, res) {
    try {
        const { restaurantId, paymentPreferences } = req.body

        if (!restaurantId || !paymentPreferences) {
            return res.status(400).json({ message: "restaurantId and paymentPreferences are required" })
        }

        const { acceptOnlinePayments, acceptOfflinePayments, acceptCash, acceptPosCard } = paymentPreferences
        const safePrefs = {}
        if (typeof acceptOnlinePayments === "boolean") safePrefs["paymentPreferences.acceptOnlinePayments"] = acceptOnlinePayments
        if (typeof acceptOfflinePayments === "boolean") safePrefs["paymentPreferences.acceptOfflinePayments"] = acceptOfflinePayments
        if (typeof acceptCash === "boolean") safePrefs["paymentPreferences.acceptCash"] = acceptCash
        if (typeof acceptPosCard === "boolean") safePrefs["paymentPreferences.acceptPosCard"] = acceptPosCard

        const restaurant = await Restaurant.findOneAndUpdate(
            { restaurantId },
            { $set: safePrefs },
            { new: true, runValidators: true }
        )

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        return res.json({ paymentPreferences: restaurant.paymentPreferences })
    } catch (err) {
        console.error("Update payment preferences error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateTablePreferences(req, res) {
    try {
        const { restaurantId, tablePreferences } = req.body

        if (!restaurantId || !tablePreferences) {
            return res.status(400).json({ message: "restaurantId and tablePreferences are required" })
        }

        const { sessionExpiryMinutes, maxActiveSessionsPerTable } = tablePreferences
        const safePrefs = {}

        if (typeof sessionExpiryMinutes === "number" && sessionExpiryMinutes > 0) {
            safePrefs["tablePreferences.sessionExpiryMinutes"] = sessionExpiryMinutes
        } else if (sessionExpiryMinutes !== undefined) {
             return res.status(400).json({ message: "sessionExpiryMinutes must be a positive number" })
        }
        
        if (typeof maxActiveSessionsPerTable === "number" && maxActiveSessionsPerTable > 0) {
            safePrefs["tablePreferences.maxActiveSessionsPerTable"] = maxActiveSessionsPerTable
        } else if (maxActiveSessionsPerTable !== undefined) {
             return res.status(400).json({ message: "maxActiveSessionsPerTable must be a positive number" })
        }

        const restaurant = await Restaurant.findOneAndUpdate(
            { restaurantId },
            { $set: safePrefs },
            { new: true, runValidators: true }
        )

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        return res.json({ tablePreferences: restaurant.tablePreferences })
    } catch (err) {
        console.error("Update table preferences error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}
