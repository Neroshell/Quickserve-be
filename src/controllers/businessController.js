import Business from "../models/Business.js"
import Order from "../models/order.js"
import Plan from "../models/Plan.js"
import crypto from "crypto"
import { sendOnboardingEmail } from "../utils/emailService.js"
import { generateSlugFromName } from "../utils/slugify.js"
import { deriveCountryCode } from "../utils/countryHelper.js"
import { hashToken } from "../utils/tokenHash.js"

function generateBusinessId() {
    return `rest_${crypto.randomBytes(7).toString("hex")}`
}

// Secret / credential fields that must NEVER be returned by any API response,
// including platform-admin responses. Also used to block them from $set updates.
const SENSITIVE_BUSINESS_FIELDS = [
    "ownerPasswordHash",
    "passwordResetToken",
    "passwordResetExpires",
    "inviteToken",
    "inviteTokenExpires",
]

// Mongoose .select() string that excludes the sensitive fields above.
const SAFE_BUSINESS_PROJECTION = SENSITIVE_BUSINESS_FIELDS.map((f) => `-${f}`).join(" ")

/** Strip secret fields from a Business object (plain or Mongoose doc) before sending it out. */
function sanitizeBusiness(biz) {
    if (!biz) return biz
    const obj = typeof biz.toObject === "function" ? biz.toObject() : { ...biz }
    for (const field of SENSITIVE_BUSINESS_FIELDS) delete obj[field]
    return obj
}

// Profile/config fields a tenant manager may edit via PATCH /business/settings.
// Deliberately EXCLUDES plan/billing/owner/stripe/status fields so a tenant
// cannot escalate their plan, bypass billing, or hijack ownership.
const ALLOWED_SETTINGS_UPDATE_FIELDS = [
    "name", "displayName", "slug", "address", "phoneNumber", "contactEmail",
    "currency", "timezone", "country", "countryCode", "language", "taxRate", "businessType",
    "logoUrl", "logoPublicId", "platformFeeLabel", "passPlatformFeeToCustomer",
    "menuCategories",
]

export async function getSettings(req, res) {
    try {
        // businessId is derived from the authenticated session only — never from
        // the request — to prevent cross-tenant reads and secret leakage.
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }

        const business = await Business.findOne({ businessId }).select(SAFE_BUSINESS_PROJECTION)

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        const bizObj = business.toObject()
        const canUseOfflinePayments = bizObj.billingStatus === "active" && !!bizObj.defaultPaymentMethodId
        bizObj.offlinePaymentsAvailable = canUseOfflinePayments
        bizObj.offlinePaymentsUnavailableReason = canUseOfflinePayments 
            ? null 
            : (bizObj.billingStatus === "past_due" ? "past_due" : "billing_not_setup")

        // Resolve platform fee rate from the plan
        const currentPlan = bizObj.currentPlan || "basic";
        bizObj.currentPlan = currentPlan
        const planDef = await Plan.findOne({ slug: currentPlan }).lean()
        const platformFeeRate = planDef ? planDef.offlineCommissionRate : 2.5
        bizObj.platformFeeRate = platformFeeRate

        // Branding Access & Downgrade Protection
        const canUseBranding = ["growth", "pro"].includes(currentPlan)
        const canRemoveQuickServeBranding = currentPlan === "pro"
        
        bizObj.brandingAccess = {
            canUseBranding,
            canRemoveQuickServeBranding
        }
        
        if (!canUseBranding) {
            bizObj.branding = null
        } else if (bizObj.branding) {
            if (!canRemoveQuickServeBranding) {
                bizObj.branding.removeQuickServeBranding = false
            }
        }

        return res.json(bizObj)
    } catch (err) {
        console.error("Get settings error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}


export async function updateSettings(req, res) {
    try {
        const { settings } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }

        // Only allow known, non-privileged profile fields to be updated.
        const updateObj = {}
        for (const field of ALLOWED_SETTINGS_UPDATE_FIELDS) {
            if (req.body[field] !== undefined) updateObj[field] = req.body[field]
        }

        // Sanitize countryCode if explicitly provided in request
        if (updateObj.countryCode !== undefined) {
            updateObj.countryCode = deriveCountryCode(updateObj.countryCode)
        }

        // Handle nested settings if provided (schema-enforced boolean flags only)
        if (settings && typeof settings === 'object') {
            for (const [key, value] of Object.entries(settings)) {
                updateObj[`settings.${key}`] = value
            }
        }

        // Slug validation if being updated explicitly
        if (updateObj.slug) {
            const slugRegex = /^[a-z0-9-]+$/
            if (!slugRegex.test(updateObj.slug)) {
                return res.status(400).json({ message: "Slug: lowercase, letters, numbers, hyphens only" })
            }
            if (updateObj.slug.length < 3 || updateObj.slug.length > 40) {
                return res.status(400).json({ message: "Slug must be between 3 and 40 characters" })
            }

            const existingBiz = await Business.findOne({ businessId })
            
            // If they are explicitly updating countryCode, use that. Otherwise use their existing countryCode.
            let resolvedCountryCode = updateObj.countryCode
            if (!resolvedCountryCode) {
                resolvedCountryCode = updateObj.country ? deriveCountryCode(updateObj.country) : (existingBiz?.countryCode || 'mt')
                updateObj.countryCode = resolvedCountryCode
            }

            const existing = await Business.findOne({ 
                slug: updateObj.slug, 
                countryCode: resolvedCountryCode,
                businessId: { $ne: businessId } 
            })
            if (existing) {
                return res.status(400).json({ message: "Slug already in use in this region" })
            }
        } else if (updateObj.displayName || updateObj.name) {
            // Auto-generate slug once if missing or still using the old rest_ format
            const existingBiz = await Business.findOne({ businessId });
            if (existingBiz && (!existingBiz.slug || existingBiz.slug.startsWith('rest_'))) {
                const baseSlug = generateSlugFromName(updateObj.displayName || updateObj.name);
                let newSlug = baseSlug;
                let counter = 1;
                
                let resolvedCountryCode = updateObj.countryCode
                if (!resolvedCountryCode) {
                    resolvedCountryCode = updateObj.country ? deriveCountryCode(updateObj.country) : (existingBiz.countryCode || 'mt')
                    updateObj.countryCode = resolvedCountryCode
                }

                while (await Business.exists({ slug: newSlug, countryCode: resolvedCountryCode, businessId: { $ne: businessId } })) {
                    newSlug = `${baseSlug}-${counter}`;
                    counter++;
                }
                updateObj.slug = newSlug;
            }
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $set: updateObj },
            { new: true, runValidators: true }
        ).select(SAFE_BUSINESS_PROJECTION)

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json(business)
    } catch (err) {
        console.error("Update settings error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateOperatingHours(req, res) {
    try {
        const { operatingHours } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!operatingHours) {
            return res.status(400).json({ message: "operatingHours is required" })
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $set: { operatingHours } },
            { new: true, runValidators: true }
        ).select(SAFE_BUSINESS_PROJECTION)

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json(business)
    } catch (err) {
        console.error("Update operating hours error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateOrderingPreferences(req, res) {
    try {
        const { orderingPreferences, settings } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!orderingPreferences) {
            return res.status(400).json({ message: "orderingPreferences is required" })
        }

        // Only allow the known boolean fields to be updated
        const { dineInEnabled, takeoutEnabled, callWaiterEnabled, hideOutOfStockItems, qrOrderingEnabled, enableWaiterOrdering } = orderingPreferences
        const safePrefs = {}
        if (typeof dineInEnabled === "boolean") safePrefs["orderingPreferences.dineInEnabled"] = dineInEnabled
        if (typeof takeoutEnabled === "boolean") safePrefs["orderingPreferences.takeoutEnabled"] = takeoutEnabled
        if (typeof callWaiterEnabled === "boolean") safePrefs["orderingPreferences.callWaiterEnabled"] = callWaiterEnabled
        if (typeof hideOutOfStockItems === "boolean") safePrefs["orderingPreferences.hideOutOfStockItems"] = hideOutOfStockItems
        if (typeof qrOrderingEnabled === "boolean") safePrefs["orderingPreferences.qrOrderingEnabled"] = qrOrderingEnabled
        if (typeof enableWaiterOrdering === "boolean") safePrefs["orderingPreferences.enableWaiterOrdering"] = enableWaiterOrdering

        if (settings && typeof settings.reservationsEnabled === "boolean") {
            safePrefs["settings.reservationsEnabled"] = settings.reservationsEnabled
        }
        if (settings && typeof settings.tipsEnabled === "boolean") {
            safePrefs["settings.tipsEnabled"] = settings.tipsEnabled
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $set: safePrefs },
            { new: true, runValidators: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json({ orderingPreferences: business.orderingPreferences })
    } catch (err) {
        console.error("Update ordering preferences error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updatePaymentPreferences(req, res) {
    try {
        const { paymentPreferences } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!paymentPreferences) {
            return res.status(400).json({ message: "paymentPreferences is required" })
        }

        const { acceptOnlinePayments, acceptOfflinePayments, acceptCash, acceptPosCard } = paymentPreferences
        const safePrefs = {}
        if (typeof acceptOnlinePayments === "boolean") safePrefs["paymentPreferences.acceptOnlinePayments"] = acceptOnlinePayments
        if (typeof acceptOfflinePayments === "boolean") safePrefs["paymentPreferences.acceptOfflinePayments"] = acceptOfflinePayments
        if (typeof acceptCash === "boolean") safePrefs["paymentPreferences.acceptCash"] = acceptCash
        if (typeof acceptPosCard === "boolean") safePrefs["paymentPreferences.acceptPosCard"] = acceptPosCard

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $set: safePrefs },
            { new: true, runValidators: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json({ paymentPreferences: business.paymentPreferences })
    } catch (err) {
        console.error("Update payment preferences error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

export async function updateTablePreferences(req, res) {
    try {
        const { tablePreferences } = req.body
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!tablePreferences) {
            return res.status(400).json({ message: "tablePreferences is required" })
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

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $set: safePrefs },
            { new: true, runValidators: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json({ tablePreferences: business.tablePreferences })
    } catch (err) {
        console.error("Update table preferences error:", err)
        return res.status(500).json({ message: "Server error" })
    }
}

const VALID_BUSINESS_TYPES = ["restaurant", "bar_lounge", "hotel_apartment"]
const VALID_PLANS = ["basic", "starter", "growth", "pro"]

export async function createBusiness(req, res) {
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

        const countryCode = deriveCountryCode(country)

        const existingSlug = await Business.findOne({ slug, countryCode })
        if (existingSlug) {
            return res.status(400).json({ message: "A business with this slug already exists in this region." })
        }

        const businessId = generateBusinessId()

        const business = await Business.create({
            businessId,
            restaurantId: businessId, // legacy alias stored in DB for existing integrations
            name,
            displayName,
            slug,
            contactEmail,
            phoneNumber: phone,
            address,
            country,
            countryCode,
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

        return res.status(201).json(sanitizeBusiness(business))
    } catch (err) {
        if (err.code === 11000) {
            const field = Object.keys(err.keyPattern || {})[0]
            if (field === "slug") {
                return res.status(400).json({ message: "A business with this slug already exists. Please choose a different slug." })
            }
            return res.status(400).json({ message: "Duplicate entry error" })
        }
        console.error("Create business error:", err)
        return res.status(500).json({ message: "Server error creating business" })
    }
}

export async function createAdminOwner(req, res) {
    try {
        const { ownerName, ownerEmail } = req.body
        const businessId = req.body.businessId || req.body.restaurantId

        if (!businessId || !ownerName || !ownerEmail) {
            return res.status(400).json({ message: "Missing required fields (businessId, ownerName, ownerEmail)" })
        }

        const business = await Business.findOne({ businessId })
        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        if (business.ownerEmail) {
            return res.status(400).json({ message: "This business already has an owner assigned" })
        }

        // Check for existing owner account across all businesses
        const normalizedOwnerEmail = ownerEmail.trim().toLowerCase()
        const existingOwner = await Business.findOne({ ownerEmail: normalizedOwnerEmail })
        if (existingOwner) {
            return res.status(409).json({ message: "An owner account with this email already exists." })
        }

        const inviteToken = crypto.randomBytes(32).toString("hex")
        const inviteTokenExpires = new Date(Date.now() + 48 * 60 * 60 * 1000) // 48 hours

        const updatedBusiness = await Business.findOneAndUpdate(
            { businessId },
            {
                $set: {
                    ownerName,
                    ownerEmail: normalizedOwnerEmail,
                    ownerStatus: "pending",
                    inviteToken: hashToken(inviteToken), // store hash; raw token only goes in the email
                    inviteTokenExpires
                }
            },
            { new: true }
        )

        // Send invitation email in background
        const inviteLink = `${process.env.FRONTEND_BASE_URL || 'http://localhost:3000'}/setup-account?token=${inviteToken}`
        
        sendOnboardingEmail({ to: ownerEmail, userName: ownerName, businessName: updatedBusiness.displayName, inviteLink, role: "owner" }).catch(err => {
            console.error(`[createAdminOwner] Failed to send invitation email to ${ownerEmail}:`, err)
        })

        return res.status(201).json(sanitizeBusiness(updatedBusiness))
    } catch (err) {
        console.error("Create admin owner error:", err)
        return res.status(500).json({ message: "Server error creating owner" })
    }
}

export async function getAdminBusinesses(req, res) {
    try {
        const businesses = await Business.find().select(SAFE_BUSINESS_PROJECTION).populate("planId").lean()

        const enrichedBusinesses = await Promise.all(businesses.map(async (biz) => {
            // Aggregate metrics from orders
            const stats = await Order.aggregate([
                { 
                    $match: { 
                        $or: [{ businessId: biz.businessId }, { restaurantId: biz.restaurantId }],
                        paymentStatus: "paid"
                    } 
                },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$tipAmount", 0] }] } },
                        lastOrderDate: { $max: "$createdAt" },
                        count: { $sum: 1 }
                    }
                }
            ])

            const metrics = stats[0] || { totalSales: 0, lastOrderDate: biz.createdAt, count: 0 }
            
            // Calculate commission based on assigned plan or default to 10%
            const commissionRate = biz.planId?.offlineCommissionRate ?? 0
            const commission = metrics.totalSales * (commissionRate / 100)

            return {
                ...biz,
                owner: {
                    id: biz._id,
                    name: biz.ownerName || "Unknown",
                    email: biz.ownerEmail || "Unknown",
                    status: "active",
                    createdAt: biz.createdAt
                },
                businessMetrics: {
                    totalSales: metrics.totalSales,
                    commission: commission,
                    lastOrderDate: metrics.lastOrderDate
                }
            }
        }))

        return res.json(enrichedBusinesses)
    } catch (err) {
        console.error("Get admin businesses error:", err)
        return res.status(500).json({ message: "Server error fetching businesses" })
    }
}

export async function getAdminOwners(req, res) {
    try {
        const businesses = await Business.find().lean()

        // Each business has one owner (ownerName, ownerEmail)
        const owners = businesses.map(biz => ({
            id: biz._id,
            name: biz.ownerName || "Unknown",
            email: biz.ownerEmail || "Unknown",
            status: "active",
            createdAt: biz.createdAt,
            businessId: biz.businessId,
            businessName: biz.displayName
        }))

        return res.json(owners)
    } catch (err) {
        console.error("Get admin owners error:", err)
        return res.status(500).json({ message: "Server error fetching owners" })
    }
}

export async function getAdminBusinessById(req, res) {
    try {
        const { businessId: paramId } = req.params
        const business = await Business.findOne({ $or: [{ businessId: paramId }, { restaurantId: paramId }] }).select(SAFE_BUSINESS_PROJECTION).populate("planId").lean()

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        // Aggregate metrics from orders
        const stats = await Order.aggregate([
            { 
                $match: { 
                    $or: [{ businessId: business.businessId }, { restaurantId: business.restaurantId }],
                    paymentStatus: "paid"
                } 
            },
            {
                $group: {
                    _id: null,
                    totalSales: { $sum: { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$tipAmount", 0] }] } },
                    lastOrderDate: { $max: "$createdAt" },
                    count: { $sum: 1 }
                }
            }
        ])

        const metrics = stats[0] || { totalSales: 0, lastOrderDate: business.createdAt, count: 0 }
        
        // Calculate commission based on assigned plan or default to 10%
        const commissionRate = business.planId?.offlineCommissionRate ?? 0
        const commission = metrics.totalSales * (commissionRate / 100)

        const enrichedBusiness = {
            ...business,
            owner: {
                id: business._id,
                name: business.ownerName || "Unknown",
                email: business.ownerEmail || "Unknown",
                status: "active",
                createdAt: business.createdAt
            },
            businessMetrics: {
                totalSales: metrics.totalSales,
                commission: commission,
                lastOrderDate: metrics.lastOrderDate
            }
        }

        return res.json(enrichedBusiness)
    } catch (err) {
        console.error("Get business by ID error:", err)
        return res.status(500).json({ message: "Server error fetching business" })
    }
}

export async function updateAdminBusiness(req, res) {
    try {
        const { businessId: paramId } = req.params
        const updateData = { ...req.body }

        // Never allow credential/secret fields to be set through the admin API.
        for (const field of SENSITIVE_BUSINESS_FIELDS) delete updateData[field]

        const business = await Business.findOneAndUpdate(
            { $or: [{ businessId: paramId }, { restaurantId: paramId }] },
            { $set: updateData },
            { new: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json(sanitizeBusiness(business))
    } catch (err) {
        console.error("Update business error:", err)
        return res.status(500).json({ message: "Server error updating business" })
    }
}

export async function getAdminDashboardStats(req, res) {
    try {
        // 1. Business Status & Plan Distribution
        const [businesses, plans] = await Promise.all([
            Business.find().lean(),
            Plan.find({ isActive: true }).lean()
        ])
        const totalBusinesses = businesses.length
        
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
        
        let newBusinesses = 0
        
        businesses.forEach(b => {
            if (statsByStatus.hasOwnProperty(b.status)) statsByStatus[b.status]++
            
            // Increment plan stat
            const planKey = b.plan?.toLowerCase() || "basic"
            if (statsByPlan.hasOwnProperty(planKey)) {
                statsByPlan[planKey]++
            } else if (!statsByPlan[planKey] && plans.length > 0) {
                // Fallback for custom or legacy plan names not in the current active plans list
                if (!statsByPlan["other"]) statsByPlan["other"] = 0
                statsByPlan["other"]++
            }
            
            if (new Date(b.createdAt) > thirtyDaysAgo) newBusinesses++
        })

        // 2. Executive KPIs & Platform Performance
        const orderStats = await Order.aggregate([
            { 
                $facet: {
                    totals: [
                        { $match: { paymentStatus: "paid" } },
                        {
                            $group: {
                                _id: null,
                                totalRevenue: { $sum: { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$tipAmount", 0] }] } },
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
                                revenue: { $sum: { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$tipAmount", 0] }] } },
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
        const topBusinessIds = topByRevenueData.map(item => item._id)
        const topBusinessDocs = await Business.find({ businessId: { $in: topBusinessIds } }).lean()
        
        const enrichedTopByRevenue = topByRevenueData.map(item => {
            const doc = topBusinessDocs.find(d => d.businessId === item._id)
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

        // Calculate businesses with zero orders in last 30 days
        const activeBusinessIdsWithOrders = new Set(orderStats[0].zeroOrders30d.map(item => item._id))
        const zeroOrders30dCount = businesses.filter(b => 
            b.status === "active" && !activeBusinessIdsWithOrders.has(b.businessId)
        ).length

        const dashboardData = {
            totalRevenue: totals.totalRevenue,
            totalOrders: totalOrders,
            totalTransactions: totals.totalTransactions,
            activeRestaurants: statsByStatus.active,   // kept for admin frontend compat
            newRestaurants: newBusinesses,              // kept for admin frontend compat
            totalRestaurants: totalBusinesses,          // kept for admin frontend compat
            draftRestaurants: statsByStatus.draft,
            suspendedRestaurants: statsByStatus.suspended,
            archivedRestaurants: statsByStatus.archived,
            // Also expose with businessId-canonical names
            activeBusinesses: statsByStatus.active,
            newBusinesses: newBusinesses,
            totalBusinesses: totalBusinesses,
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

        const business = await Business.findOne({ businessId })
        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        // Return menuCategories array or default if not set
        return res.json(business.menuCategories && business.menuCategories.length > 0 
            ? business.menuCategories 
            : ["appetizers", "mains", "desserts", "beverages"])
    } catch (err) {
        console.error("Get categories error:", err)
        return res.status(500).json({ message: "Server error fetching categories" })
    }
}

export async function addCategory(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        const { category } = req.body

        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!category) {
            return res.status(400).json({ message: "category is required" })
        }

        const trimmedCategory = category.trim().toLowerCase()
        if (!trimmedCategory) {
            return res.status(400).json({ message: "Invalid category" })
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $addToSet: { menuCategories: trimmedCategory } },
            { new: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json(business.menuCategories)
    } catch (err) {
        console.error("Add category error:", err)
        return res.status(500).json({ message: "Server error adding category" })
    }
}

export async function removeCategory(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        const category = req.query.category || req.body.category

        if (!businessId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (!category) {
            return res.status(400).json({ message: "category is required" })
        }

        const trimmedCategory = category.trim().toLowerCase()
        const defaultCategories = ["appetizers", "mains", "desserts", "beverages"]

        if (defaultCategories.includes(trimmedCategory)) {
            return res.status(400).json({ message: "Cannot delete default categories" })
        }

        const business = await Business.findOneAndUpdate(
            { businessId },
            { $pull: { menuCategories: trimmedCategory } },
            { new: true }
        )

        if (!business) {
            return res.status(404).json({ message: "Business not found" })
        }

        return res.json(business.menuCategories)
    } catch (err) {
        console.error("Remove category error:", err)
        return res.status(500).json({ message: "Server error removing category" })
    }
}

export async function deleteAdminBusiness(req, res) {
    try {
        const { businessId: paramId } = req.params;

        if (!paramId) {
            return res.status(400).json({ message: "Business ID is required" });
        }

        const deletedBusiness = await Business.findOneAndDelete({ $or: [{ businessId: paramId }, { restaurantId: paramId }] });

        if (!deletedBusiness) {
            return res.status(404).json({ message: "Business not found" });
        }

        return res.json({ message: "Business successfully deleted", businessId: paramId });
    } catch (err) {
        console.error("Delete business error:", err);
        return res.status(500).json({ message: "Server error deleting business" });
    }
}
