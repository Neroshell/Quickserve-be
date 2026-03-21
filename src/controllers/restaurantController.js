import Restaurant from "../models/Restaurant.js"
import Order from "../models/order.js"
import crypto from "crypto"

function generateRestaurantId() {
    return `rest_${crypto.randomBytes(4).toString("hex")}`
}

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

export async function createRestaurant(req, res) {
    try {
        const {
            name,
            displayName,
            slug,
            contactEmail,
            phone,
            address,
            country,
            currency,
            timezone,
            ownerName,
            ownerEmail,
            plan,
            notes
        } = req.body

        // Simple validation
        if (!name || !displayName || !slug || !ownerName || !ownerEmail) {
            return res.status(400).json({ message: "Missing required fields (name, displayName, slug, ownerName, ownerEmail)" })
        }

        // Slug validation
        const slugRegex = /^[a-z0-9-]+$/
        if (!slugRegex.test(slug)) {
            return res.status(400).json({ message: "Slug: lowercase, letters, numbers, hyphens only" })
        }

        const existingSlug = await Restaurant.findOne({ slug })
        if (existingSlug) {
            return res.status(400).json({ message: "Slug already in use" })
        }

        const restaurantId = generateRestaurantId()

        const restaurant = await Restaurant.create({
            restaurantId,
            name,
            displayName,
            slug,
            contactEmail,
            phoneNumber: phone,
            address,
            country,
            currency,
            timezone,
            ownerName,
            ownerEmail,
            plan,
            notes,
            status: "draft"
        })

        return res.status(201).json(restaurant)
    } catch (err) {
        console.error("Create restaurant error:", err)
        return res.status(500).json({ message: "Server error creating restaurant" })
    }
}

export async function getAdminRestaurants(req, res) {
    try {
        const restaurants = await Restaurant.find().lean()

        const enrichedRestaurants = await Promise.all(restaurants.map(async (rest) => {
            // Aggregate metrics from orders
            const stats = await Order.aggregate([
                { 
                    $match: { 
                        restaurantId: rest.restaurantId,
                        paymentStatus: "paid"
                    } 
                },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: "$total" },
                        lastOrderDate: { $max: "$createdAt" },
                        count: { $sum: 1 }
                    }
                }
            ])

            const metrics = stats[0] || { totalSales: 0, lastOrderDate: rest.createdAt, count: 0 }
            
            // Default commission 10%
            const commission = metrics.totalSales * 0.1

            return {
                ...rest,
                owner: {
                    id: rest._id,
                    name: rest.ownerName || "Unknown",
                    email: rest.ownerEmail || "Unknown",
                    status: "active",
                    createdAt: rest.createdAt
                },
                businessMetrics: {
                    totalSales: metrics.totalSales,
                    commission: commission,
                    lastOrderDate: metrics.lastOrderDate
                }
            }
        }))

        return res.json(enrichedRestaurants)
    } catch (err) {
        console.error("Get admin restaurants error:", err)
        return res.status(500).json({ message: "Server error fetching restaurants" })
    }
}

export async function getAdminOwners(req, res) {
    try {
        const restaurants = await Restaurant.find().lean()

        // Extract owners from restaurants
        // In the current schema, each restaurant has one owner (ownerName, ownerEmail)
        const owners = restaurants.map(rest => ({
            id: rest._id, // Using restaurant _id as the owner id for now
            name: rest.ownerName || "Unknown",
            email: rest.ownerEmail || "Unknown",
            status: "active",
            createdAt: rest.createdAt,
            restaurantId: rest.restaurantId,
            restaurantName: rest.displayName
        }))

        return res.json(owners)
    } catch (err) {
        console.error("Get admin owners error:", err)
        return res.status(500).json({ message: "Server error fetching owners" })
    }
}

export async function getAdminRestaurantById(req, res) {
    try {
        const { restaurantId } = req.params
        const restaurant = await Restaurant.findOne({ restaurantId }).lean()

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        // Aggregate metrics from orders
        const stats = await Order.aggregate([
            { 
                $match: { 
                    restaurantId: restaurant.restaurantId,
                    paymentStatus: "paid"
                } 
            },
            {
                $group: {
                    _id: null,
                    totalSales: { $sum: "$total" },
                    lastOrderDate: { $max: "$createdAt" },
                    count: { $sum: 1 }
                }
            }
        ])

        const metrics = stats[0] || { totalSales: 0, lastOrderDate: restaurant.createdAt, count: 0 }
        const commission = metrics.totalSales * 0.1

        const enrichedRestaurant = {
            ...restaurant,
            owner: {
                id: restaurant._id,
                name: restaurant.ownerName || "Unknown",
                email: restaurant.ownerEmail || "Unknown",
                status: "active",
                createdAt: restaurant.createdAt
            },
            businessMetrics: {
                totalSales: metrics.totalSales,
                commission: commission,
                lastOrderDate: metrics.lastOrderDate
            }
        }

        return res.json(enrichedRestaurant)
    } catch (err) {
        console.error("Get restaurant by ID error:", err)
        return res.status(500).json({ message: "Server error fetching restaurant" })
    }
}

export async function updateAdminRestaurant(req, res) {
    try {
        const { restaurantId } = req.params
        const updateData = req.body

        const restaurant = await Restaurant.findOneAndUpdate(
            { restaurantId },
            { $set: updateData },
            { new: true }
        )

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        return res.json(restaurant)
    } catch (err) {
        console.error("Update restaurant error:", err)
        return res.status(500).json({ message: "Server error updating restaurant" })
    }
}

export async function getAdminDashboardStats(req, res) {
    try {
        // 1. Restaurant Status & Plan Distribution
        const restaurants = await Restaurant.find().lean()
        const totalRestaurants = restaurants.length
        
        const statsByStatus = {
            active: 0,
            draft: 0,
            suspended: 0,
            archived: 0
        }
        
        const statsByPlan = {
            starter: 0,
            growth: 0,
            pro: 0,
            enterprise: 0
        }
        
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
        
        let newRestaurants = 0
        
        restaurants.forEach(r => {
            if (statsByStatus.hasOwnProperty(r.status)) statsByStatus[r.status]++
            if (statsByPlan.hasOwnProperty(r.plan)) statsByPlan[r.plan]++
            if (new Date(r.createdAt) > thirtyDaysAgo) newRestaurants++
        })

        // 2. Executive KPIs & Platform Performance
        // Aggregate all paid orders for revenue
        const orderStats = await Order.aggregate([
            { 
                $facet: {
                    totals: [
                        { $match: { paymentStatus: "paid" } },
                        {
                            $group: {
                                _id: null,
                                totalRevenue: { $sum: "$total" },
                                totalTransactions: { $sum: 1 }
                            }
                        }
                    ],
                    orderCount: [
                        { $count: "count" }
                    ],
                    byRestaurant: [
                        { $match: { paymentStatus: "paid" } },
                        {
                            $group: {
                                _id: "$restaurantId",
                                revenue: { $sum: "$total" },
                                orders: { $sum: 1 }
                            }
                        },
                        { $sort: { revenue: -1 } },
                        { $limit: 10 }
                    ],
                    zeroOrders30d: [
                        { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                        { $group: { _id: "$restaurantId" } }
                    ]
                }
            }
        ])

        const totals = orderStats[0].totals[0] || { totalRevenue: 0, totalTransactions: 0 }
        const totalOrders = orderStats[0].orderCount[0]?.count || 0
        
        // Enrich top restaurants with display names
        const topByRevenueData = orderStats[0].byRestaurant
        const restaurantIds = topByRevenueData.map(item => item._id)
        const topRestaurantDocs = await Restaurant.find({ restaurantId: { $in: restaurantIds } }).lean()
        
        const enrichedTopByRevenue = topByRevenueData.map(item => {
            const doc = topRestaurantDocs.find(d => d.restaurantId === item._id)
            return {
                restaurantId: item._id,
                displayName: doc?.displayName || "Unknown",
                revenue: item.revenue,
                orders: item.orders,
                status: doc?.status || "active"
            }
        })

        const topByOrders = [...enrichedTopByRevenue].sort((a, b) => b.orders - a.orders).slice(0, 5)
        const topByRevenue = enrichedTopByRevenue.slice(0, 5)

        // Calculate zero orders in last 30 days
        const activeRestaurantIdsWithOrders = new Set(orderStats[0].zeroOrders30d.map(item => item._id))
        const zeroOrders30dCount = restaurants.filter(r => 
            r.status === "active" && !activeRestaurantIdsWithOrders.has(r.restaurantId)
        ).length

        const dashboardData = {
            totalRevenue: totals.totalRevenue,
            totalOrders: totalOrders,
            totalTransactions: totals.totalTransactions,
            activeRestaurants: statsByStatus.active,
            newRestaurants: newRestaurants,
            totalRestaurants: totalRestaurants,
            draftRestaurants: statsByStatus.draft,
            suspendedRestaurants: statsByStatus.suspended,
            archivedRestaurants: statsByStatus.archived,
            byPlan: statsByPlan,
            topByRevenue: topByRevenue,
            topByOrders: topByOrders,
            zeroOrders30d: zeroOrders30dCount
        }

        return res.json(dashboardData)
    } catch (err) {
        console.error("Dashboard stats error:", err)
        return res.status(500).json({ message: "Server error fetching dashboard stats" })
    }
}
