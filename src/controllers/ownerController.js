import { DateTime } from "luxon"
import Order from "../models/order.js"
import GuestSession from "../models/GuestSession.js"
import ServicePoint from "../models/ServicePoint.js"
import ServiceRequest from "../models/ServiceRequest.js"
import Business from "../models/Business.js"
import Feedback from "../models/Feedback.js"
import Staff from "../models/Staff.js"
import MenuItem from "../models/menuItem.js"
import { readOwnerTransactions } from "../services/transactionReadService.js"
import {
    invalidatePublicBusinessConfig,
    invalidatePublicBusinessRoute,
} from "../services/cacheInvalidationService.js"
const BUSINESS_TZ = process.env.BUSINESS_TZ || "Europe/Malta"
const ROLLOVER_HOUR = Number(process.env.BUSINESS_DAY_ROLLOVER_HOUR || 2)

function getBusinessDayRange() {
    const now = DateTime.now().setZone(BUSINESS_TZ)
    const isBeforeRollover = now.hour < ROLLOVER_HOUR
    const baseDay = isBeforeRollover ? now.minus({ days: 1 }) : now

    const start = baseDay
        .startOf("day")
        .set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })

    const end = start.plus({ days: 1 })

    return {
        start,
        end,
    }
}

// GET /owner/orders?range=today|yesterday|7days|thisMonth|custom&from=...&to=...&status=all|placed|in_progress|ready|completed&search=...
export async function ownerOrders(req, res) {
    try {
        const { range = "today", from, to, status = "all", search = "" } = req.query
        const businessId = req.session?.user?.businessId

        if (!businessId) {
            return res.status(400).json({ error: "businessId is required" })
        }

        let startDateJS, endDateJS

        // 1. Determine Date Range Base
        const { start: todayStart, end: todayEnd } = getBusinessDayRange()

        switch (range) {
            case "today":
                startDateJS = todayStart.toJSDate()
                endDateJS = todayEnd.toJSDate()
                break
            case "yesterday":
                startDateJS = todayStart.minus({ days: 1 }).toJSDate()
                endDateJS = todayEnd.minus({ days: 1 }).toJSDate()
                break
            case "7days":
                startDateJS = todayStart.minus({ days: 6 }).toJSDate() // 6 days + today = 7 days
                endDateJS = todayEnd.toJSDate()
                break
            case "thisMonth":
                // Start of the calendar month, aligned to ROLLOVER_HOUR
                const currentMonthStart = todayStart.startOf("month").set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })
                startDateJS = currentMonthStart.toJSDate()
                endDateJS = todayEnd.toJSDate()
                break
            case "custom":
                if (!from || !to) {
                    return res.status(400).json({ error: "Missing 'from' or 'to' for custom range" })
                }
                // Parse the "YYYY-MM-DD" keeping business TZ logic
                const customStart = DateTime.fromISO(from, { zone: BUSINESS_TZ }).set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })
                const customEnd = DateTime.fromISO(to, { zone: BUSINESS_TZ }).set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 }).plus({ days: 1 })

                if (!customStart.isValid || !customEnd.isValid) {
                    return res.status(400).json({ error: "Invalid date format for custom range" })
                }

                startDateJS = customStart.toJSDate()
                endDateJS = customEnd.toJSDate()
                break
            default:
                startDateJS = todayStart.toJSDate()
                endDateJS = todayEnd.toJSDate()
        }

        // 2. Build MongoDB Query
        const filter = {
            businessId,
            createdAt: { $gte: startDateJS, $lt: endDateJS },
        }

        const WAITER_STATUSES = ["placed", "in_progress", "ready", "completed"]

        // Status filtering internally applies to counts visually in FE but API dictates exact dataset
        if (status !== "all" && WAITER_STATUSES.includes(status)) {
            filter.status = status
        } else {
            filter.status = { $in: WAITER_STATUSES }
        }

        // If we strictly want search DB-side we can implement it, OR we fetch the array and the frontend trims. 
        // Frontend search is generally fine for <1000 orders/day, but doing it backend scales better. (Regex on orderId/servicePointLabel).
        if (search) {
            const escapeRegex = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const searchRegex = new RegExp(escapeRegex(search), "i")
            filter.$or = [
                { orderId: { $regex: searchRegex } },
                { servicePointLabel: { $regex: searchRegex } }
            ]
        }


        // 3. Fetch Orders
        const rawOrders = await Order.find(
            filter,
            {
                _id: 0,
                orderId: 1,
                servicePointId: 1,
                servicePointLabel: 1,
                displayLabel: 1,
                orderType: 1,
                status: 1,
                createdAt: 1,
                updatedAt: 1,
                readyAt: 1,
                items: 1,
                total: 1,
                currency: 1,
                paymentChannel: 1,
                paymentStatus: 1,
                paidVia: 1,
                receiptEmail: 1,
                receiptSent: 1,
                receiptSentAt: 1,
                completedBy: 1,
                subtotal: 1,
                taxAmount: 1,
                platformFeeTotal: 1,
                tipAmount: 1,
                tipType: 1,
                tipPercentage: 1,
                platformFeeCents: 1,
                customerPlatformFeeCents: 1,
                businessAbsorbedPlatformFeeCents: 1,
            }
        )
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean()

        // 4. Calculate Status Counts across the ACTIVE date range
        // Note: Counts ignore the current 'status' or 'search' filter so UI tabs show total accurate pool volume
        const countsFilter = {
            businessId,
            createdAt: { $gte: startDateJS, $lt: endDateJS },
            status: { $in: WAITER_STATUSES }
        }

        const countsAgg = await Order.aggregate([
            { $match: countsFilter },
            { $group: { _id: "$status", count: { $sum: 1 } } },
        ])

        const counts = { placed: 0, in_progress: 0, ready: 0, completed: 0 }
        for (const row of countsAgg) {
            if (row?._id && counts[row._id] !== undefined) counts[row._id] = row.count
        }

        // 5. Shape output equivalent to Waiter formatting
        const orders = rawOrders.map((o) => {
            const allergiesSet = new Set()
            let specialRequest = ""

            for (const it of o.items || []) {
                if (Array.isArray(it.allergies)) {
                    for (const a of it.allergies) {
                        if (a && String(a).trim()) allergiesSet.add(String(a).trim())
                    }
                }
                if (!specialRequest && it.notes && String(it.notes).trim()) {
                    specialRequest = String(it.notes).trim()
                }
            }

            return {
                orderId: o.orderId,
                servicePointId: o.servicePointId || o.servicePointLabel || "",
                servicePointLabel: o.displayLabel || o.servicePointLabel || "",
                orderType: o.orderType,
                status: o.status,
                createdAt: o.createdAt,
                readyAt: o.readyAt,
                updatedAt: o.updatedAt,
                paymentChannel: o.paymentChannel,
                paymentStatus: o.paymentStatus,
                paidVia: o.paidVia,
                receiptEmail: o.receiptEmail,
                receiptSent: o.receiptSent,
                receiptSentAt: o.receiptSentAt,
                items: (o.items || []).map((it) => ({
                    itemName: it.itemName,
                    quantity: it.quantity,
                    lineTotal: it.lineTotal || 0,
                    notes: it.notes,
                    allergies: it.allergies
                })),
                allergies: Array.from(allergiesSet),
                notes: specialRequest,
                subtotal: o.subtotal || 0,
                taxAmount: o.taxAmount || 0,
                platformFeeTotal: o.platformFeeTotal || 0,
                tipAmount: o.tipAmount || 0,
                tipType: o.tipType || null,
                tipPercentage: o.tipPercentage ?? null,
                total: o.total,
                currency: o.currency || "EUR",
                completedBy: o.completedBy || null,
                platformFeeCents: o.platformFeeCents || 0,
                customerPlatformFeeCents: o.customerPlatformFeeCents || 0,
                businessAbsorbedPlatformFeeCents: o.businessAbsorbedPlatformFeeCents || 0,
            }
        })

        return res.json({
            range,
            counts,
            orders
        })

    } catch (err) {
        console.error("[ownerOrders]", err)
        return res.status(500).json({ error: "Failed to fetch owner orders" })
    }
}

export async function getTableSessionsOverview(req, res) {
    try {
        const businessId = req.session?.user?.businessId

        const now = new Date()

        const sessions = await GuestSession.aggregate([
            {
                $match: {
                    businessId,
                    expiresAt: { $gt: now }
                }
            },
            {
                $group: {
                    _id: "$servicePointId",
                    activeDevices: { $sum: 1 }
                }
            },
            {
                $sort: {
                    activeDevices: -1,
                    _id: 1
                }
            }
        ])

        const tableIds = sessions.map(s => s._id)
        
        const servicePoints = await ServicePoint.find(
            { servicePointId: { $in: tableIds } }, 
            "servicePointId label"
        ).lean()

        const labelMap = {}
        for (const sp of servicePoints) {
            labelMap[sp.servicePointId] = sp.label
        }

        const activeSessionsNow = sessions.reduce((acc, curr) => acc + curr.activeDevices, 0)
        const activeTablesNow = sessions.length
        
        const tables = sessions.map(s => ({
            servicePointLabel: s._id,
            label: labelMap[s._id] || s._id,
            activeDevices: s.activeDevices
        }))

        return res.json({
            activeSessionsNow,
            activeTablesNow,
            tables
        })
    } catch (err) {
        console.error("Get table sessions overview error:", err)
        return res.status(500).json({ message: "Server error retrieving session overview" })
    }
}

export async function getDashboardData(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) return res.status(400).json({ error: "businessId is required" })

        const { start: todayStart, end: todayEnd } = getBusinessDayRange()
        const startDateJS = todayStart.toJSDate()
        const endDateJS   = todayEnd.toJSDate()
        const dateFilter  = { businessId, createdAt: { $gte: startDateJS, $lt: endDateJS } }

        // Expire stale waiter calls before querying
        const now = new Date()
        await ServiceRequest.updateMany(
            { businessId, status: "pending", pendingExpiresAt: { $lte: now } },
            { $set: { status: "missed", missedAt: now } }
        )

        // ─── Run all queries in parallel ─────────────────────────────────────────
        const [
            todayOrdersRaw,
            business,
            recentFeedback,
            activeStaff,
            pendingWaiterCalls,
            missedWaiterCalls,
            totalMenuItems,
            reconciliationCount,
            sessions,
        ] = await Promise.all([
            Order.find({
                ...dateFilter,
                status: { $in: ["placed", "in_progress", "ready", "completed"] }
            }, { total: 1, status: 1, paymentStatus: 1, createdAt: 1, orderId: 1, servicePointLabel: 1, orderType: 1, paymentChannel: 1, tipAmount: 1 }).lean(),

            Business.findOne({ businessId }).select('stripeChargesEnabled billingStatus currency timezone').lean(),

            Feedback.find({ businessId })
                .sort({ createdAt: -1 })
                .limit(5)
                .lean(),

            Staff.find({ businessId, $or: [{ presenceStatus: "active" }, { status: "active" }] }).lean(),

            ServiceRequest.find({ businessId, status: "pending", createdAt: { $gte: startDateJS, $lt: endDateJS } }).lean(),

            ServiceRequest.find({ businessId, status: "missed", createdAt: { $gte: startDateJS, $lt: endDateJS } }).lean(),

            MenuItem.countDocuments({ businessId }),

            Order.countDocuments({
                businessId,
                createdAt: { $lt: startDateJS },
                $or: [
                    { status: { $in: ["placed", "in_progress", "ready"] } },
                    { paymentChannel: "offline", paymentStatus: { $ne: "paid" }, status: { $ne: "cancelled" } }
                ]
            }),

            GuestSession.aggregate([
                { $match: { businessId, expiresAt: { $gt: now } } },
                { $group: { _id: "$servicePointId", activeDevices: { $sum: 1 } } },
                { $sort: { activeDevices: -1, _id: 1 } }
            ])
        ])

        const tableIds = sessions.map(s => s._id)
        // Also collect service point IDs from today's orders so the activity feed can resolve labels
        const orderSpIds = [...new Set(todayOrdersRaw.map(o => o.servicePointLabel).filter(Boolean))]
        const allSpIds = [...new Set([...tableIds, ...orderSpIds])]
        const servicePoints = await ServicePoint.find({ servicePointId: { $in: allSpIds } }, "servicePointId label").lean()
        const labelMap = {}
        for (const sp of servicePoints) {
            labelMap[sp.servicePointId] = sp.label
        }

        const activeSessionsNow = sessions.reduce((acc, curr) => acc + curr.activeDevices, 0)
        const activeTablesNow = sessions.length
        const tables = sessions.map(s => ({
            servicePointLabel: s._id,
            label: labelMap[s._id] || s._id,
            activeDevices: s.activeDevices
        }))

        const sessionOverview = { activeSessionsNow, activeTablesNow, tables }

        // ─── Today's KPIs ───────────────────────────────────────────────────────────
        const completedOrders = todayOrdersRaw.filter(o => o.status === "completed")
        const paidOrders      = todayOrdersRaw.filter(o => o.paymentStatus === "paid")
        const todayRevenue    = paidOrders.reduce((sum, o) => sum + Number(((o.total || 0) - Number(o.tipAmount || 0)).toFixed(2)), 0)
        const todayOrders     = todayOrdersRaw.length
        const tablesServed    = completedOrders.length
        const activeOrders    = todayOrdersRaw.filter(o => ["placed","in_progress","ready"].includes(o.status)).length

        // ─── Hourly Revenue (today) ─────────────────────────────────────────────────
        const hourlyMap = new Map()
        for (let i = 0; i < 24; i++) {
            const h = i > 12 ? i - 12 : (i === 0 ? 12 : i)
            const ampm = i >= 12 ? "PM" : "AM"
            hourlyMap.set(`${h}${ampm}`, 0)
        }
        for (const o of paidOrders) {
            const dt = DateTime.fromJSDate(o.createdAt).setZone(BUSINESS_TZ)
            const label = `${dt.toFormat("h")}${dt.toFormat("a")}`
            if (hourlyMap.has(label)) hourlyMap.set(label, hourlyMap.get(label) + Number(((o.total || 0) - Number(o.tipAmount || 0)).toFixed(2)))
        }
        const hourlyRevenue = Array.from(hourlyMap.entries()).map(([hour, revenue]) => ({ hour, revenue }))

        // ─── Business Health ────────────────────────────────────────────────────────
        const onlinePaymentsOk  = business?.stripeChargesEnabled === true
        const billingStatus     = business?.billingStatus || "incomplete"
        const hasMenu           = true // Placeholder — could query MenuItem count
        const staffOnlineCount  = activeStaff.length

        // ─── Action Items ───────────────────────────────────────────────────────────
        const actionItems = []

        if (billingStatus === "incomplete") {
            actionItems.push({ type: "billing", severity: "error", message: "Billing setup is incomplete. Set up billing to accept payments.", href: "/owner/billing" })
        } else if (billingStatus === "past_due") {
            actionItems.push({ type: "billing", severity: "error", message: "Your billing is past due. Please update your payment method.", href: "/owner/billing" })
        }

        if (!onlinePaymentsOk) {
            actionItems.push({ type: "payments", severity: "warning", message: "Online payments are not configured. Connect Stripe to accept card payments.", href: "/owner/billing" })
        }

        if (pendingWaiterCalls.length > 0) {
            actionItems.push({ type: "service", severity: "warning", message: `${pendingWaiterCalls.length} unanswered waiter call${pendingWaiterCalls.length > 1 ? "s" : ""} pending.`, href: "/owner/orders" })
        }

        if (missedWaiterCalls.length > 0) {
            actionItems.push({ type: "service", severity: "error", message: `${missedWaiterCalls.length} waiter call${missedWaiterCalls.length > 1 ? "s were" : " was"} missed today.`, href: "/owner/orders" })
        }

        // Orders waiting >15 minutes
        const now15 = new Date(Date.now() - 15 * 60 * 1000)
        const longWaitOrders = todayOrdersRaw.filter(o => ["placed","in_progress"].includes(o.status) && new Date(o.createdAt) < now15)
        if (longWaitOrders.length > 0) {
            actionItems.push({ type: "orders", severity: "warning", message: `${longWaitOrders.length} order${longWaitOrders.length > 1 ? "s" : ""} waiting over 15 minutes.`, href: "/owner/orders" })
        }

        // Unpaid offline orders (today only)
        const unpaidOfflineOrders = todayOrdersRaw.filter(o => o.paymentChannel === "offline" && o.paymentStatus !== "paid" && o.status !== "cancelled")
        if (unpaidOfflineOrders.length > 0) {
            actionItems.push({ type: "payments", severity: "warning", message: `${unpaidOfflineOrders.length} offline order${unpaidOfflineOrders.length > 1 ? "s" : ""} awaiting payment.`, href: "/owner/orders" })
        }

        // Uncompleted orders (today only)
        const uncompletedOrders = todayOrdersRaw.filter(o => ["placed", "in_progress", "ready"].includes(o.status))
        if (uncompletedOrders.length > 0) {
            actionItems.push({ type: "orders", severity: "info", message: `${uncompletedOrders.length} order${uncompletedOrders.length > 1 ? "s" : ""} not yet completed.`, href: "/owner/orders" })
        }

        if (staffOnlineCount === 0) {
            actionItems.push({ type: "staff", severity: "info", message: "No staff members are currently active.", href: "/owner/staff" })
        }

        // ─── Recent Activity (latest orders + feedback) ──────────────────────────
        const recentActivity = []

        // Latest 10 orders as activity events
        const latestOrders = [...todayOrdersRaw]
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 8)

        for (const o of latestOrders) {
            const rawSpId = o.servicePointLabel || ""
            const label = labelMap[rawSpId] || rawSpId
            if (o.paymentStatus === "paid") {
                recentActivity.push({ type: "payment", icon: "💳", message: `Order ${o.orderId} paid`, sub: label, time: o.createdAt })
            } else {
                const statusEmoji = { placed: "🆕", in_progress: "🍳", ready: "✅", completed: "🎉" }
                recentActivity.push({ type: "order", icon: statusEmoji[o.status] || "📋", message: `Order ${o.orderId} ${o.status.replace("_", " ")}`, sub: label ? `${label} · ${o.orderType}` : o.orderType, time: o.createdAt })
            }
        }

        // Recent feedback as activity events
        for (const f of recentFeedback.slice(0, 3)) {
            recentActivity.push({ type: "feedback", icon: "⭐", message: `New feedback received (${f.overallRating}★)`, sub: f.comment ? f.comment.slice(0, 60) : "No comment", time: f.createdAt })
        }

        // Sort and cap at 10
        recentActivity.sort((a, b) => new Date(b.time) - new Date(a.time))
        const activityFeed = recentActivity.slice(0, 10)

        // â”€â”€ Shape recentFeedback for preview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const feedbackPreview = recentFeedback.map(f => ({
            id: f._id,
            rating: f.overallRating,
            comment: f.comment || "",
            sentiment: f.sentiment,
            createdAt: f.createdAt
        }))

        return res.json({
            snapshot: {
                todayOrders,
                todayRevenue: +todayRevenue.toFixed(2),
                tablesServed,
                totalMenuItems,
                activeOrders,
            },
            businessHealth: {
                onlinePayments: onlinePaymentsOk ? "active" : "not_configured",
                billing: billingStatus,
                staffOnline: staffOnlineCount,
            },
            actionItems,
            activityFeed,
            feedbackPreview,
            hourlyRevenue,
            reconciliationCount,
            sessionOverview,
        })

    } catch (err) {
        console.error("[getDashboardData]", err)
        return res.status(500).json({ error: "Failed to fetch dashboard data" })
    }
}

// â”€â”€â”€ Branding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function getBranding(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) return res.status(401).json({ error: "Unauthorized" })

        const business = await Business.findOne({ businessId }).lean()
        if (!business) return res.status(404).json({ error: "Business not found" })

        return res.json({
            branding: business.branding || {
                enabled: false,
                logoUrl: null,
                coverImageUrl: null,
                primaryColor: "#EA601A",
                accentColor: "#FB923C",
                removeQuickServeBranding: false
            },
            currentPlan: business.currentPlan || "basic"
        })
    } catch (err) {
        console.error("[getBranding]", err)
        return res.status(500).json({ error: "Failed to fetch branding" })
    }
}

export async function updateBranding(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) return res.status(401).json({ error: "Unauthorized" })

        const business = await Business.findOne({ businessId })
        if (!business) return res.status(404).json({ error: "Business not found" })

        const { enabled, logoUrl, coverImageUrl, primaryColor, secondaryColor, accentColor, backgroundColor, removeQuickServeBranding } = req.body

        // Validation
        const hexRegex = /^#([0-9A-F]{3}){1,2}$/i
        if (primaryColor && !hexRegex.test(primaryColor)) {
            return res.status(400).json({ error: "Invalid primary color hex code" })
        }
        if (secondaryColor && !hexRegex.test(secondaryColor)) {
            return res.status(400).json({ error: "Invalid secondary color hex code" })
        }
        if (accentColor && !hexRegex.test(accentColor)) {
            return res.status(400).json({ error: "Invalid accent color hex code" })
        }
        if (backgroundColor && !hexRegex.test(backgroundColor)) {
            return res.status(400).json({ error: "Invalid background color hex code" })
        }

        const urlRegex = /^(https?:\/\/)/i
        if (logoUrl && !urlRegex.test(logoUrl)) {
            return res.status(400).json({ error: "Invalid logo URL" })
        }
        if (coverImageUrl && !urlRegex.test(coverImageUrl)) {
            return res.status(400).json({ error: "Invalid cover image URL" })
        }

        const currentPlan = business.currentPlan || "basic";
        const canUseBranding = ["growth", "pro"].includes(currentPlan)

        if (!canUseBranding) {
            return res.status(403).json({ error: "Branding is available on Growth and Pro plans." })
        }

        business.branding = {
            enabled: typeof enabled === "boolean" ? enabled : business.branding?.enabled || false,
            logoUrl: logoUrl || null,
            coverImageUrl: coverImageUrl || null,
            primaryColor: primaryColor || "#EA601A",
            secondaryColor: secondaryColor || "#2B304C",
            accentColor: accentColor || "#FB923C",
            backgroundColor: backgroundColor || "#F8F9FA",
            removeQuickServeBranding: currentPlan === "pro" && removeQuickServeBranding === true
        }

        await business.save()

        await Promise.all([
            invalidatePublicBusinessConfig(businessId),
            invalidatePublicBusinessRoute(business.countryCode, business.slug),
        ])

        return res.json({ message: "Branding updated successfully", branding: business.branding })
    } catch (err) {
        console.error("[updateBranding]", err)
        return res.status(500).json({ error: "Failed to update branding" })
    }
}

// GET /owner/transactions
// Unified transaction read model for food-service orders and hotel reservations.
export async function ownerTransactions(req, res) {
    try {
        const { range = "today", from, to, search = "" } = req.query
        const businessId = req.session?.user?.businessId

        if (!businessId) {
            return res.status(400).json({ error: "businessId is required" })
        }

        const { start: todayStart, end: todayEnd } = getBusinessDayRange()
        let startDateJS
        let endDateJS

        switch (range) {
            case "yesterday":
                startDateJS = todayStart.minus({ days: 1 }).toJSDate()
                endDateJS = todayEnd.minus({ days: 1 }).toJSDate()
                break
            case "7days":
                startDateJS = todayStart.minus({ days: 6 }).toJSDate()
                endDateJS = todayEnd.toJSDate()
                break
            case "thisMonth":
                startDateJS = todayStart
                    .startOf("month")
                    .set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })
                    .toJSDate()
                endDateJS = todayEnd.toJSDate()
                break
            case "custom": {
                if (!from || !to) {
                    return res.status(400).json({ error: "Missing 'from' or 'to' for custom range" })
                }
                const customStart = DateTime.fromISO(from, { zone: BUSINESS_TZ })
                    .set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })
                const customEnd = DateTime.fromISO(to, { zone: BUSINESS_TZ })
                    .set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })
                    .plus({ days: 1 })
                if (!customStart.isValid || !customEnd.isValid) {
                    return res.status(400).json({ error: "Invalid date format for custom range" })
                }
                startDateJS = customStart.toJSDate()
                endDateJS = customEnd.toJSDate()
                break
            }
            case "today":
            default:
                startDateJS = todayStart.toJSDate()
                endDateJS = todayEnd.toJSDate()
                break
        }

        const transactions = await readOwnerTransactions({
            businessId,
            createdAt: { $gte: startDateJS, $lt: endDateJS },
            search,
        })

        const displayTransactions = transactions.map((transaction) => {
            if (transaction.sourceType === "reservation") return transaction

            return {
                ...transaction,
                
                servicePointLabel:
                    transaction.displayLabel ||
                    transaction.servicePointLabel ||
                    "",
            }
        })

        return res.json({ range, transactions: displayTransactions })
    } catch (err) {
        console.error("[ownerTransactions]", err)
        return res.status(500).json({ error: "Failed to fetch owner transactions" })
    }
}
