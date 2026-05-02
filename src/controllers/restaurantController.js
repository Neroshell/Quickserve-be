import Restaurant from "../models/Restaurant.js"
import Order from "../models/order.js"
import Plan from "../models/Plan.js"
import crypto from "crypto"
import { sendOnboardingEmail } from "../utils/emailService.js"

function generateBusinessId() {
    return `rest_${crypto.randomBytes(4).toString("hex")}`
}

export async function getSettings(req, res) {
    try {
        const businessId = req.query.businessId || req.query.restaurantId || process.env.NEXT_PUBLIC_RESTAURANT_ID || "default-restaurant-id"

        let restaurant = await Restaurant.findOne({ businessId })

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        return res.json(restaurant)
    } catch (err) {
        console.error("Get settings error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateSettings(req, res) {
    try {
        const { settings, ...updates } = req.body
        const businessId = req.body.businessId || req.body.restaurantId

        if (!businessId) {
            return res.status(400).json({ message: "businessId is required" })
        }

        const updateObj = { ...updates }

        // Handle nested settings if provided
        if (settings && typeof settings === 'object') {
            for (const [key, value] of Object.entries(settings)) {
                updateObj[`settings.${key}`] = value
            }
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

            const existing = await Restaurant.findOne({ slug: updates.slug, businessId: { $ne: businessId } })
            if (existing) {
                return res.status(400).json({ message: "Slug already in use" })
            }
        }

        const restaurant = await Restaurant.findOneAndUpdate(
            { businessId },
            { $set: updateObj },
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
        const { operatingHours } = req.body
        const businessId = req.body.businessId || req.body.restaurantId

        if (!businessId || !operatingHours) {
            return res.status(400).json({ message: "businessId and operatingHours are required" })
        }

        const restaurant = await Restaurant.findOneAndUpdate(
            { businessId },
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
        const { orderingPreferences } = req.body
        const businessId = req.body.businessId || req.body.restaurantId

        if (!businessId || !orderingPreferences) {
            return res.status(400).json({ message: "businessId and orderingPreferences are required" })
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
            { businessId },
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
        const { paymentPreferences } = req.body
        const businessId = req.body.businessId || req.body.restaurantId

        if (!businessId || !paymentPreferences) {
            return res.status(400).json({ message: "businessId and paymentPreferences are required" })
        }

        const { acceptOnlinePayments, acceptOfflinePayments, acceptCash, acceptPosCard } = paymentPreferences
        const safePrefs = {}
        if (typeof acceptOnlinePayments === "boolean") safePrefs["paymentPreferences.acceptOnlinePayments"] = acceptOnlinePayments
        if (typeof acceptOfflinePayments === "boolean") safePrefs["paymentPreferences.acceptOfflinePayments"] = acceptOfflinePayments
        if (typeof acceptCash === "boolean") safePrefs["paymentPreferences.acceptCash"] = acceptCash
        if (typeof acceptPosCard === "boolean") safePrefs["paymentPreferences.acceptPosCard"] = acceptPosCard

        const restaurant = await Restaurant.findOneAndUpdate(
            { businessId },
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
        const { tablePreferences } = req.body
        const businessId = req.body.businessId || req.body.restaurantId

        if (!businessId || !tablePreferences) {
            return res.status(400).json({ message: "businessId and tablePreferences are required" })
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
            { businessId },
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

const VALID_BUSINESS_TYPES = ["restaurant", "bar_lounge", "hotel_apartment"]
const VALID_PLANS = ["basic", "starter", "growth", "enterprise"]

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
            language,
            settings,
            businessType,
            plan,
            planId,
            notes
        } = req.body

        // Simple validation
        if (!name || !displayName || !slug) {
            return res.status(400).json({ message: "Missing required fields (name, displayName, slug)" })
        }

        // businessType validation
        if (businessType && !VALID_BUSINESS_TYPES.includes(businessType)) {
            return res.status(400).json({ message: `Invalid businessType. Must be one of: ${VALID_BUSINESS_TYPES.join(", ")}` })
        }

        // plan validation
        if (plan && !VALID_PLANS.includes(plan)) {
            return res.status(400).json({ message: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}` })
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

        const businessId = generateBusinessId()

        const restaurant = await Restaurant.create({
            businessId,
            restaurantId: businessId, // legacy alias stored in DB for existing integrations
            name,
            displayName,
            slug,
            contactEmail,
            phoneNumber: phone,
            address,
            country,
            currency,
            timezone,
            language: language || "en",
            settings: settings || {
                onlinePaymentEnabled: true,
                offlinePaymentEnabled: true,
                acceptCash: true,
                acceptPOS: true,
                dineInEnabled: true,
                takeoutEnabled: false,
                callWaiterEnabled: true
            },
            businessType,
            plan,
            planId,
            notes,
            status: "draft"
        })

        return res.status(201).json(restaurant)
    } catch (err) {
        if (err.code === 11000) {
            const field = Object.keys(err.keyPattern || {})[0]
            if (field === "slug") {
                return res.status(400).json({ message: "A restaurant with this slug already exists. Please choose a different slug." })
            }
            return res.status(400).json({ message: "Duplicate entry error" })
        }
        console.error("Create restaurant error:", err)
        return res.status(500).json({ message: "Server error creating restaurant" })
    }
}

export async function createAdminOwner(req, res) {
    try {
        const { ownerName, ownerEmail } = req.body
        const businessId = req.body.businessId || req.body.restaurantId

        if (!businessId || !ownerName || !ownerEmail) {
            return res.status(400).json({ message: "Missing required fields (businessId, ownerName, ownerEmail)" })
        }

        const restaurant = await Restaurant.findOne({ businessId })
        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        if (restaurant.ownerEmail) {
            return res.status(400).json({ message: "This restaurant already has an owner assigned" })
        }

        // Check for existing owner account across all restaurants
        const normalizedOwnerEmail = ownerEmail.trim().toLowerCase()
        const existingOwner = await Restaurant.findOne({ ownerEmail: normalizedOwnerEmail })
        if (existingOwner) {
            return res.status(409).json({ message: "An owner account with this email already exists." })
        }

        const inviteToken = crypto.randomBytes(32).toString("hex")
        const inviteTokenExpires = new Date(Date.now() + 48 * 60 * 60 * 1000) // 48 hours

        const updatedRestaurant = await Restaurant.findOneAndUpdate(
            { businessId },
            { 
                $set: { 
                    ownerName, 
                    ownerEmail: normalizedOwnerEmail,
                    ownerStatus: "pending",
                    inviteToken,
                    inviteTokenExpires
                } 
            },
            { new: true }
        )

        // Send invitation email in background
        const inviteLink = `${process.env.FRONTEND_BASE_URL || 'http://localhost:3000'}/setup-account?token=${inviteToken}`
        
        sendOnboardingEmail({ to: ownerEmail, userName: ownerName, businessName: updatedRestaurant.displayName, inviteLink, role: "owner" }).catch(err => {
            console.error(`[createAdminOwner] Failed to send invitation email to ${ownerEmail}:`, err)
        })

        return res.status(201).json(updatedRestaurant)
    } catch (err) {
        console.error("Create admin owner error:", err)
        return res.status(500).json({ message: "Server error creating owner" })
    }
}

export async function getAdminRestaurants(req, res) {
    try {
        const restaurants = await Restaurant.find().populate("planId").lean()

        const enrichedRestaurants = await Promise.all(restaurants.map(async (rest) => {
            // Aggregate metrics from orders
            const stats = await Order.aggregate([
                { 
                    $match: { 
                        $or: [{ businessId: rest.businessId }, { restaurantId: rest.restaurantId }],
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
            
            // Calculate commission based on assigned plan or default to 10%
            const commissionRate = rest.planId?.commissionPercentage ?? 10
            const commission = metrics.totalSales * (commissionRate / 100)

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
            id: rest._id,
            name: rest.ownerName || "Unknown",
            email: rest.ownerEmail || "Unknown",
            status: "active",
            createdAt: rest.createdAt,
            businessId: rest.businessId,
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
        const { businessId: paramId } = req.params
        const restaurant = await Restaurant.findOne({ $or: [{ businessId: paramId }, { restaurantId: paramId }] }).populate("planId").lean()

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        // Aggregate metrics from orders
        const stats = await Order.aggregate([
            { 
                $match: { 
                    $or: [{ businessId: restaurant.businessId }, { restaurantId: restaurant.restaurantId }],
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
        
        // Calculate commission based on assigned plan or default to 10%
        const commissionRate = restaurant.planId?.commissionPercentage ?? 10
        const commission = metrics.totalSales * (commissionRate / 100)

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
        const { businessId: paramId } = req.params
        const updateData = req.body

        const restaurant = await Restaurant.findOneAndUpdate(
            { $or: [{ businessId: paramId }, { restaurantId: paramId }] },
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
        const [restaurants, plans] = await Promise.all([
            Restaurant.find().lean(),
            Plan.find({ isActive: true }).lean()
        ])
        const totalRestaurants = restaurants.length
        
        const statsByStatus = {
            active: 0,
            draft: 0,
            suspended: 0,
            archived: 0
        }
        
        // Build dynamic plan stats from db plans
        const statsByPlan = {}
        plans.forEach(p => {
            statsByPlan[p.name.toLowerCase()] = 0
        })
        
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
        
        let newRestaurants = 0
        
        restaurants.forEach(r => {
            if (statsByStatus.hasOwnProperty(r.status)) statsByStatus[r.status]++
            
            // Increment plan stat - handle both string plan name and potential missing plans
            const planKey = r.plan?.toLowerCase() || "basic"
            if (statsByPlan.hasOwnProperty(planKey)) {
                statsByPlan[planKey]++
            } else if (!statsByPlan[planKey] && plans.length > 0) {
                // Fallback for custom or legacy plan names not in the current active plans list
                if (!statsByPlan["other"]) statsByPlan["other"] = 0
                statsByPlan["other"]++
            }
            
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
                    byBusiness: [
                        { $match: { paymentStatus: "paid" } },
                        {
                            $group: {
                                _id: "$businessId",
                                revenue: { $sum: "$total" },
                                orders: { $sum: 1 }
                            }
                        },
                        { $sort: { revenue: -1 } },
                        { $limit: 10 }
                    ],
                    zeroOrders30d: [
                        { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                        { $group: { _id: "$businessId" } }
                    ]
                }
            }
        ])

        const totals = orderStats[0].totals[0] || { totalRevenue: 0, totalTransactions: 0 }
        const totalOrders = orderStats[0].orderCount[0]?.count || 0
        
        // Enrich top businesses with display names
        const topByRevenueData = orderStats[0].byBusiness
        const businessIds = topByRevenueData.map(item => item._id)
        const topRestaurantDocs = await Restaurant.find({ businessId: { $in: businessIds } }).lean()
        
        const enrichedTopByRevenue = topByRevenueData.map(item => {
            const doc = topRestaurantDocs.find(d => d.businessId === item._id)
            return {
                businessId: item._id,
                displayName: doc?.displayName || "Unknown",
                revenue: item.revenue,
                orders: item.orders,
                status: doc?.status || "active"
            }
        })

        const topByOrders = [...enrichedTopByRevenue].sort((a, b) => b.orders - a.orders).slice(0, 5)
        const topByRevenue = enrichedTopByRevenue.slice(0, 5)

        // Calculate zero orders in last 30 days
        const activeBusinessIdsWithOrders = new Set(orderStats[0].zeroOrders30d.map(item => item._id))
        const zeroOrders30dCount = restaurants.filter(r => 
            r.status === "active" && !activeBusinessIdsWithOrders.has(r.businessId)
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

export async function getCategories(req, res) {
    try {
        const businessId = req.query.businessId || req.query.restaurantId || req.user?.businessId || req.user?.restaurantId
        if (!businessId) {
            return res.status(400).json({ message: "businessId is required" })
        }

        const restaurant = await Restaurant.findOne({ businessId })
        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        // Return menuCategories array or default if not set
        return res.json(restaurant.menuCategories && restaurant.menuCategories.length > 0 
            ? restaurant.menuCategories 
            : ["appetizers", "mains", "desserts", "beverages"])
    } catch (err) {
        console.error("Get categories error:", err)
        return res.status(500).json({ message: "Server error fetching categories" })
    }
}

export async function addCategory(req, res) {
    try {
        const businessId = req.body.businessId || req.body.restaurantId || req.user?.businessId || req.user?.restaurantId
        const { category } = req.body

        if (!businessId || !category) {
            return res.status(400).json({ message: "businessId and category are required" })
        }

        const trimmedCategory = category.trim().toLowerCase()
        if (!trimmedCategory) {
            return res.status(400).json({ message: "Invalid category" })
        }

        const restaurant = await Restaurant.findOneAndUpdate(
            { businessId },
            { $addToSet: { menuCategories: trimmedCategory } },
            { new: true }
        )

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        return res.json(restaurant.menuCategories)
    } catch (err) {
        console.error("Add category error:", err)
        return res.status(500).json({ message: "Server error adding category" })
    }
}

export async function removeCategory(req, res) {
    try {
        const businessId = req.query.businessId || req.query.restaurantId || req.body.businessId || req.body.restaurantId || req.user?.businessId || req.user?.restaurantId
        const category = req.query.category || req.body.category

        if (!businessId || !category) {
            return res.status(400).json({ message: "businessId and category are required" })
        }

        const trimmedCategory = category.trim().toLowerCase()
        const defaultCategories = ["appetizers", "mains", "desserts", "beverages"]

        if (defaultCategories.includes(trimmedCategory)) {
            return res.status(400).json({ message: "Cannot delete default categories" })
        }

        const restaurant = await Restaurant.findOneAndUpdate(
            { businessId },
            { $pull: { menuCategories: trimmedCategory } },
            { new: true }
        )

        if (!restaurant) {
            return res.status(404).json({ message: "Restaurant not found" })
        }

        return res.json(restaurant.menuCategories)
    } catch (err) {
        console.error("Remove category error:", err)
        return res.status(500).json({ message: "Server error removing category" })
    }
}

export async function deleteAdminRestaurant(req, res) {
    try {
        const { businessId: paramId } = req.params;

        if (!paramId) {
            return res.status(400).json({ message: "Business ID is required" });
        }

        const deletedRestaurant = await Restaurant.findOneAndDelete({ $or: [{ businessId: paramId }, { restaurantId: paramId }] });

        if (!deletedRestaurant) {
            return res.status(404).json({ message: "Restaurant not found" });
        }

        return res.json({ message: "Restaurant successfully deleted", businessId: paramId });
    } catch (err) {
        console.error("Delete administration restaurant error:", err);
        return res.status(500).json({ message: "Server error deleting restaurant" });
    }
}
