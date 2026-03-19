import { DateTime } from "luxon"
import Order from "../models/order.js"
import TableSession from "../models/TableSession.js"

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
        const { range = "today", from, to, status = "all", search = "", restaurantId } = req.query

        if (!restaurantId) {
            return res.status(400).json({ error: "restaurantId is required" })
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
            restaurantId,
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
        // Frontend search is generally fine for <1000 orders/day, but doing it backend scales better. (Regex on orderId/tableNumber).
        if (search) {
            const searchRegex = new RegExp(search, "i")
            filter.$or = [
                { orderId: { $regex: searchRegex } },
                { tableNumber: { $regex: searchRegex } }
            ]
        }


        // 3. Fetch Orders
        const rawOrders = await Order.find(
            filter,
            {
                _id: 0,
                orderId: 1,
                tableNumber: 1,
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
            }
        )
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean()

        // 4. Calculate Status Counts across the ACTIVE date range
        // Note: Counts ignore the current 'status' or 'search' filter so UI tabs show total accurate pool volume
        const countsFilter = {
            restaurantId,
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
                tableNumber: o.tableNumber,
                orderType: o.orderType,
                status: o.status,
                createdAt: o.createdAt,
                readyAt: o.readyAt,
                updatedAt: o.updatedAt,
                paymentChannel: o.paymentChannel,
                paymentStatus: o.paymentStatus,
                paidVia: o.paidVia,
                receiptEmail: o.receiptEmail,
                items: (o.items || []).map((it) => ({
                    itemName: it.itemName,
                    quantity: it.quantity,
                    lineTotal: it.lineTotal || 0,
                    notes: it.notes,
                    allergies: it.allergies
                })),
                allergies: Array.from(allergiesSet),
                notes: specialRequest,
                total: o.total,
                currency: o.currency || "EUR",
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
        const restaurantId = req.query.restaurantId || process.env.NEXT_PUBLIC_RESTAURANT_ID || "default-restaurant-id"

        const now = new Date()

        const sessions = await TableSession.aggregate([
            {
                $match: {
                    restaurantId,
                    expiresAt: { $gt: now }
                }
            },
            {
                $group: {
                    _id: "$tableId",
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

        const activeSessionsNow = sessions.reduce((acc, curr) => acc + curr.activeDevices, 0)
        const activeTablesNow = sessions.length
        
        const tables = sessions.map(s => ({
            tableNumber: s._id,
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

// GET /owner/analytics?range=today|yesterday|7days|thisMonth|custom&from=...&to=...
export async function ownerAnalytics(req, res) {
    try {
        const { range = "today", from, to, restaurantId } = req.query

        if (!restaurantId) {
            return res.status(400).json({ error: "restaurantId is required" })
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
                startDateJS = todayStart.minus({ days: 6 }).toJSDate()
                endDateJS = todayEnd.toJSDate()
                break
            case "thisMonth":
                const currentMonthStart = todayStart.startOf("month").set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })
                startDateJS = currentMonthStart.toJSDate()
                endDateJS = todayEnd.toJSDate()
                break
            case "custom":
                if (!from || !to) {
                    return res.status(400).json({ error: "Missing 'from' or 'to' for custom range" })
                }
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

        // 2. Fetch Base Orders
        const orders = await Order.find({
            restaurantId,
            createdAt: { $gte: startDateJS, $lt: endDateJS }
        }).lean()

        // 3. Setup core variables
        const stats = {
            todayRevenue: 0,
            yesterdayRevenue: 0,
            weekRevenue: 0,
            monthRevenue: 0,
            activeOrders: 0,
            completedToday: 0,
            averageOrderValue: 0,
            previousAverageOrderValue: 0, // Placeholder
            totalItemsSold: 0,
            peakHour: "N/A",
            averagePrepTime: 0,
            dineInCount: 0,
            takeoutCount: 0
        }

        const hourlyOrdersMap = new Map() // Hour string -> { orders, revenue }
        const revenueByDayMap = new Map() // Date string -> { revenue, orders }
        const itemsMap = new Map() // ItemName -> { quantity, revenue, category }
        let totalPrepTimeMinutes = 0
        let prepTimeCount = 0
        let totalPaidOrders = 0
        const categoryMap = new Map()

        // Fill empty hourly slots to ensure chart plots all hours natively across day bounds
        for (let i = 0; i < 24; i++) {
            const h = i > 12 ? i - 12 : (i === 0 ? 12 : i)
            const ampm = i >= 12 ? "PM" : "AM"
            hourlyOrdersMap.set(`${h}${ampm}`, { orders: 0, revenue: 0 })
        }

        // Initialize day map correctly depending on range to avoid empty gaps in UI
        const isSingleDay = (range === "today" || range === "yesterday" || (range === "custom" && from === to))

        if (!isSingleDay) {
            let current = DateTime.fromJSDate(startDateJS).setZone(BUSINESS_TZ)
            const end = DateTime.fromJSDate(endDateJS).setZone(BUSINESS_TZ)
            while (current < end) {
                const label = range === "7days"
                    ? current.toFormat("ccc") // e.g. Mon, Tue
                    : current.toFormat("MMM dd") // e.g. Oct 01
                revenueByDayMap.set(label, { revenue: 0, orders: 0, dateRaw: current.toISODate() })
                current = current.plus({ days: 1 })
            }
        }

        let totalRevenue = 0

        // 4. Process Orders Iteratively
        for (const order of orders) {
            const orderDateObj = DateTime.fromJSDate(order.createdAt).setZone(BUSINESS_TZ)

            // Time charts extraction
            const hourLabel = `${orderDateObj.toFormat("h")}${orderDateObj.toFormat("a")}`

            if (hourlyOrdersMap.has(hourLabel)) {
                hourlyOrdersMap.get(hourLabel).orders += 1
            }

            // Stats computations
            if (order.status !== "completed" && order.status !== "ready") {
                stats.activeOrders++
            }
            if (order.status === "completed") {
                stats.completedToday++
            }

            if (order.orderType === "dine-in") stats.dineInCount++
            if (order.orderType === "takeout") stats.takeoutCount++

            // Prep time calculations
            if (order.createdAt && order.readyAt) {
                const prepMinutes = DateTime.fromJSDate(order.readyAt).diff(DateTime.fromJSDate(order.createdAt), "minutes").minutes
                if (prepMinutes > 0 && prepMinutes < 300) { // arbitrary cleanup for weird old data
                    totalPrepTimeMinutes += prepMinutes
                    prepTimeCount++
                }
            }

            // Paid orders logic (Revenue, Items)
            if (order.paymentStatus === "paid") {
                totalRevenue += order.total || 0
                totalPaidOrders++

                if (hourlyOrdersMap.has(hourLabel)) {
                    hourlyOrdersMap.get(hourLabel).revenue += (order.total || 0)
                }

                // Map revenue by day if multi-day view
                if (!isSingleDay) {
                    const label = range === "7days" ? orderDateObj.toFormat("ccc") : orderDateObj.toFormat("MMM dd")
                    if (revenueByDayMap.has(label)) {
                        const dayStats = revenueByDayMap.get(label)
                        dayStats.revenue += (order.total || 0)
                        dayStats.orders += 1
                    }
                }

                for (const item of order.items || []) {
                    stats.totalItemsSold += item.quantity

                    // Top Items
                    if (!itemsMap.has(item.itemName)) {
                        itemsMap.set(item.itemName, { quantity: 0, revenue: 0, category: item.category || "food" })
                    }
                    const trackedItem = itemsMap.get(item.itemName)
                    trackedItem.quantity += item.quantity
                    trackedItem.revenue += (item.lineTotal || 0)

                    // Categories Breakdown
                    const cat = item.category || "food"
                    if (!categoryMap.has(cat)) categoryMap.set(cat, { revenue: 0, quantity: 0 })
                    categoryMap.get(cat).revenue += (item.lineTotal || 0)
                    categoryMap.get(cat).quantity += item.quantity
                }
            }
        }

        // 5. Build Final Shapes
        // For 'yesterday' card we simply bind these locally to avoid confusing the UI when looking at older dates
        stats.todayRevenue = totalRevenue
        // For UI compliance, fake yesterday calculation unless requested via a multi-query, or just drop it/zero it
        stats.yesterdayRevenue = 0
        stats.weekRevenue = totalRevenue // Binds exactly to viewed temporal bounds instead of forcing strict 7 days.
        stats.monthRevenue = totalRevenue

        stats.averageOrderValue = totalPaidOrders > 0 ? (totalRevenue / totalPaidOrders) : 0
        stats.averagePrepTime = prepTimeCount > 0 ? Math.round(totalPrepTimeMinutes / prepTimeCount) : 0

        // Calculate peak hour mathematically
        let maxOrders = 0
        for (const [hour, data] of hourlyOrdersMap.entries()) {
            if (data.orders > maxOrders) {
                maxOrders = data.orders
                stats.peakHour = hour
            }
        }

        const hourlyOrders = Array.from(hourlyOrdersMap.entries()).map(([hour, data]) => ({
            hour,
            orders: data.orders,
            revenue: data.revenue
        }))

        // Single Day defaults to breaking revenue trend down by hour too instead of 1 bar.
        const revenueByDay = isSingleDay ? hourlyOrders.map(h => ({
            date: h.hour,
            revenue: h.revenue,
            orders: h.orders
        })) : Array.from(revenueByDayMap.entries()).map(([date, data]) => ({
            date,
            revenue: data.revenue,
            orders: data.orders
        }))

        const topItems = Array.from(itemsMap.entries()).map(([itemName, data]) => ({
            itemName,
            quantity: data.quantity,
            revenue: data.revenue,
            category: data.category
        })).sort((a, b) => b.quantity - a.quantity).slice(0, 5)

        const categoryPerformance = Array.from(categoryMap.entries()).map(([category, data]) => ({
            category: category.charAt(0).toUpperCase() + category.slice(1),
            revenue: data.revenue,
            quantity: data.quantity,
            percentage: totalRevenue > 0 ? Math.round((data.revenue / totalRevenue) * 100) : 0
        })).sort((a, b) => b.percentage - a.percentage)

        // Calculate Order Type percentages natively ensuring valid boundaries
        const totalTypedOrders = stats.dineInCount + stats.takeoutCount

        let dineInRevenue = 0
        let takeoutRevenue = 0
        for (let order of orders) {
            if (order.paymentStatus === 'paid') {
                if (order.orderType === 'dine-in') dineInRevenue += order.total
                if (order.orderType === 'takeout') takeoutRevenue += order.total
            }
        }

        const orderTypeBreakdown = [
            {
                type: "dine-in",
                count: stats.dineInCount,
                revenue: dineInRevenue,
                percentage: totalTypedOrders > 0 ? Math.round((stats.dineInCount / totalTypedOrders) * 100) : 0
            },
            {
                type: "takeout",
                count: stats.takeoutCount,
                revenue: takeoutRevenue,
                percentage: totalTypedOrders > 0 ? Math.round((stats.takeoutCount / totalTypedOrders) * 100) : 0
            }
        ]

        return res.json({
            stats,
            revenueByDay,
            hourlyOrders,
            topItems,
            categoryPerformance,
            orderTypeBreakdown
        })

    } catch (err) {
        console.error("[ownerAnalytics]", err)
        return res.status(500).json({ error: "Failed to generate owner analytics" })
    }
}
