import { DateTime } from "luxon"
import Order from "../models/order.js"
import TableSession from "../models/TableSession.js"
import ServicePoint from "../models/ServicePoint.js"
import WaiterCall from "../models/WaiterCall.js"
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
        // Frontend search is generally fine for <1000 orders/day, but doing it backend scales better. (Regex on orderId/tableNumber).
        if (search) {
            const escapeRegex = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const searchRegex = new RegExp(escapeRegex(search), "i")
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
                tableLabel: 1,
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

        // // Batch-hydrate tableLabel for any order that is missing it.
        // // This covers online orders created before the fix was deployed.
        // const unlabelled = rawOrders.filter(o => !o.tableLabel && o.tableNumber?.startsWith("sp_"));
        // if (unlabelled.length > 0) {
        //     const uniqueSpIds = [...new Set(unlabelled.map(o => o.tableNumber))];
        //     const sps = await ServicePoint.find(
        //         { servicePointId: { $in: uniqueSpIds }, businessId },
        //         "servicePointId label code"
        //     ).lean();
        //     const spMap = {};
        //     for (const sp of sps) {
        //         spMap[sp.servicePointId] = sp.label || sp.code || sp.servicePointId;
        //     }
        //     for (const o of unlabelled) {
        //         o.tableLabel = spMap[o.tableNumber] || o.tableNumber;
        //     }
        // }

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
                tableNumber: o.tableNumber,
                tableLabel: o.tableLabel || o.tableNumber || "",
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

        const sessions = await TableSession.aggregate([
            {
                $match: {
                    businessId,
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
            tableNumber: s._id,
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

// GET /owner/analytics?range=today|yesterday|7days|thisMonth|custom&from=...&to=...
export async function ownerAnalytics(req, res) {
    try {
        const { range = "today", from, to } = req.query
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

        // 2. Fetch orders, service call analytics, table performance,
        //    and per-staff waitstaff metrics in parallel
        const [orders, serviceCallsAgg, tableAgg, waiterCallStaffAgg, paymentStaffAgg, servedStaffAgg] = await Promise.all([
            Order.find({
                businessId,
                createdAt: { $gte: startDateJS, $lt: endDateJS }
            }).lean(),

            WaiterCall.aggregate([
                {
                    $match: {
                        businessId,
                        createdAt: { $gte: startDateJS, $lt: endDateJS }
                    }
                },
                {
                    $facet: {
                        byStatus: [
                            { $group: { _id: "$status", count: { $sum: 1 } } }
                        ],
                        byReason: [
                            { $group: { _id: "$reason", count: { $sum: 1 } } }
                        ],
                        responseTimes: [
                            { $match: { acknowledgedAt: { $ne: null } } },
                            {
                                $project: {
                                    responseTimeSeconds: {
                                        $divide: [
                                            { $subtract: ["$acknowledgedAt", "$createdAt"] },
                                            1000
                                        ]
                                    }
                                }
                            },
                            { $group: { _id: null, avg: { $avg: "$responseTimeSeconds" } } }
                        ],
                        resolutionTimes: [
                            { $match: { resolvedAt: { $ne: null }, status: "resolved" } },
                            {
                                $project: {
                                    resolutionTimeSeconds: {
                                        $divide: [
                                            { $subtract: ["$resolvedAt", "$createdAt"] },
                                            1000
                                        ]
                                    }
                                }
                            },
                            { $group: { _id: null, avg: { $avg: "$resolutionTimeSeconds" } } }
                        ]
                    }
                }
            ]),

            // Table performance â€” uses the same owner reporting range as all other analytics
            Order.aggregate([
                {
                    $match: {
                        businessId,
                        createdAt: { $gte: startDateJS, $lt: endDateJS },
                        status: { $in: ["placed", "in_progress", "ready", "completed"] }
                    }
                },
                {
                    $group: {
                        _id: "$tableNumber",
                        label:       { $first: "$tableLabel" },
                        orderCount:  { $sum: 1 },
                        totalRevenue:{ $sum: { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$tipAmount", 0] }] } },
                        paidOrders:  { $sum: { $cond: [{ $eq: ["$paymentStatus", "paid"] }, 1, 0] } },
                        unpaidOrders:{ $sum: { $cond: [{ $ne: ["$paymentStatus", "paid"] }, 1, 0] } }
                    }
                },
                { $sort: { orderCount: -1, totalRevenue: -1 } }
            ]),

            // Per-staff waiter call metrics (acknowledged + resolved, with timing)
            WaiterCall.aggregate([
                {
                    $match: {
                        businessId,
                        createdAt: { $gte: startDateJS, $lt: endDateJS }
                    }
                },
                {
                    $facet: {
                        acknowledged: [
                            { $match: { acknowledgedByStaffId: { $ne: null } } },
                            {
                                $group: {
                                    _id: "$acknowledgedByStaffId",
                                    name:          { $first: "$acknowledgedByName" },
                                    count:         { $sum: 1 },
                                    totalRespMs: {
                                        $sum: {
                                            $cond: [
                                                { $and: [{ $ne: ["$acknowledgedAt", null] }, { $ne: ["$createdAt", null] }] },
                                                { $subtract: ["$acknowledgedAt", "$createdAt"] },
                                                0
                                            ]
                                        }
                                    },
                                    respCount: { $sum: { $cond: [{ $ne: ["$acknowledgedAt", null] }, 1, 0] } }
                                }
                            }
                        ],
                        resolved: [
                            { $match: { resolvedByStaffId: { $ne: null } } },
                            {
                                $group: {
                                    _id: "$resolvedByStaffId",
                                    name:          { $first: "$resolvedByName" },
                                    count:         { $sum: 1 },
                                    totalResolMs: {
                                        $sum: {
                                            $cond: [
                                                { $and: [{ $ne: ["$resolvedAt", null] }, { $ne: ["$createdAt", null] }] },
                                                { $subtract: ["$resolvedAt", "$createdAt"] },
                                                0
                                            ]
                                        }
                                    },
                                    resolCount: { $sum: { $cond: [{ $ne: ["$resolvedAt", null] }, 1, 0] } }
                                }
                            }
                        ]
                    }
                }
            ]),

            // Per-staff payment confirmation metrics (offline payment focus)
            Order.aggregate([
                {
                    $match: {
                        businessId,
                        createdAt: { $gte: startDateJS, $lt: endDateJS },
                        paidByStaffId: { $ne: null },
                        paymentStatus: "paid"
                    }
                },
                {
                    $group: {
                        _id: "$paidByStaffId",
                        name:                        { $first: "$paidByName" },
                        paymentsConfirmed:           { $sum: 1 },
                        totalOfflinePaymentsConfirmed: {
                            $sum: {
                                $cond: [
                                    { $eq: ["$paymentChannel", "offline"] },
                                    { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$tipAmount", 0] }] },
                                    0
                                ]
                            }
                        }
                    }
                }
            ]),

            // Per-staff orders served (waiter clicked Mark Served â†’ completed)
            Order.aggregate([
                {
                    $match: {
                        businessId,
                        createdAt: { $gte: startDateJS, $lt: endDateJS },
                        servedByStaffId: { $ne: null },
                        status: "completed"
                    }
                },
                {
                    $group: {
                        _id: "$servedByStaffId",
                        name: { $first: "$servedByName" },
                        ordersServed: { $sum: 1 }
                    }
                }
            ])
        ])

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
            takeoutCount: 0,
            customerOrderCount: 0,
            staffOrderCount: 0,
            customerRevenue: 0,
            staffRevenue: 0,
            totalTipsCollected: 0,
            averageTip: 0,
            highestTip: 0,
            ordersWithTips: 0,
            tipRate: 0
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
        let totalTipsCollected = 0
        let highestTip = 0
        let ordersWithTips = 0

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

            // Channel calculations
            if (order.orderSource === "waitstaff") {
                stats.staffOrderCount++
            } else {
                stats.customerOrderCount++
            }
            
            // Prep time calculations: use readyAt if set, fall back to completedAt
            // Some orders skip the "ready" step and go straight to "completed"
            const prepEndTime = order.readyAt || order.completedAt
            if (order.createdAt && prepEndTime) {
                const prepMinutes = DateTime.fromJSDate(prepEndTime).diff(DateTime.fromJSDate(order.createdAt), "minutes").minutes
                if (prepMinutes > 0 && prepMinutes < 300) { // filter out bogus data (>5h)
                    totalPrepTimeMinutes += prepMinutes
                    prepTimeCount++
                }
            }

            // Paid orders logic (Revenue, Items)
            if (order.paymentStatus === "paid") {
                const tipValue = Number(order.tipAmount || 0)
                const revenueValue = Number(((order.total || 0) - tipValue).toFixed(2))
                totalRevenue += revenueValue
                totalTipsCollected += tipValue
                if (tipValue > 0) {
                    ordersWithTips++
                    highestTip = Math.max(highestTip, tipValue)
                }
                totalPaidOrders++

                if (hourlyOrdersMap.has(hourLabel)) {
                    hourlyOrdersMap.get(hourLabel).revenue += revenueValue
                }

                // Channel Revenue calculations
                if (order.orderSource === "waitstaff") {
                    stats.staffRevenue += revenueValue
                } else {
                    stats.customerRevenue += revenueValue
                }

                // Map revenue by day if multi-day view
                if (!isSingleDay) {
                    const label = range === "7days" ? orderDateObj.toFormat("ccc") : orderDateObj.toFormat("MMM dd")
                    if (revenueByDayMap.has(label)) {
                        const dayStats = revenueByDayMap.get(label)
                        dayStats.revenue += revenueValue
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
        stats.totalTipsCollected = +totalTipsCollected.toFixed(2)
        stats.averageTip = ordersWithTips > 0 ? +(totalTipsCollected / ordersWithTips).toFixed(2) : 0
        stats.highestTip = +highestTip.toFixed(2)
        stats.ordersWithTips = ordersWithTips
        stats.tipRate = totalPaidOrders > 0 ? Math.round((ordersWithTips / totalPaidOrders) * 100) : 0
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
                const revenueValue = Number(((order.total || 0) - Number(order.tipAmount || 0)).toFixed(2))
                if (order.orderType === 'dine-in') dineInRevenue += revenueValue
                if (order.orderType === 'takeout') takeoutRevenue += revenueValue
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

        const totalChannelOrders = stats.customerOrderCount + stats.staffOrderCount
        const totalChannelRevenue = stats.customerRevenue + stats.staffRevenue

        const channelBreakdown = [
            {
                channel: "self",
                label: "Self Ordering",
                count: stats.customerOrderCount,
                revenue: stats.customerRevenue,
                orderPercentage: totalChannelOrders > 0 ? Math.round((stats.customerOrderCount / totalChannelOrders) * 100) : 0,
                revenuePercentage: totalChannelRevenue > 0 ? Math.round((stats.customerRevenue / totalChannelRevenue) * 100) : 0
            },
            {
                channel: "waitstaff",
                label: "Staff-Assisted Ordering",
                count: stats.staffOrderCount,
                revenue: stats.staffRevenue,
                orderPercentage: totalChannelOrders > 0 ? Math.round((stats.staffOrderCount / totalChannelOrders) * 100) : 0,
                revenuePercentage: totalChannelRevenue > 0 ? Math.round((stats.staffRevenue / totalChannelRevenue) * 100) : 0
            }
        ]

        // â”€â”€â”€ Shape serviceCalls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const scFacet = serviceCallsAgg?.[0] || {}

        const scByStatus = {}
        for (const row of scFacet.byStatus || []) {
            if (row._id) scByStatus[row._id] = row.count
        }

        const KNOWN_REASONS = ["request_bill", "assistance", "emergency"]
        const scByReason = { request_bill: 0, assistance: 0, emergency: 0, other: 0 }
        for (const row of scFacet.byReason || []) {
            const key = (row._id || "").toLowerCase().trim().replace(/\s+/g, "_")
            if (KNOWN_REASONS.includes(key)) {
                scByReason[key] += row.count
            } else {
                scByReason.other += row.count
            }
        }

        const serviceCalls = {
            total: (scByStatus.pending || 0) + (scByStatus.acknowledged || 0) + (scByStatus.resolved || 0) + (scByStatus.missed || 0),
            pending: scByStatus.pending || 0,
            acknowledged: scByStatus.acknowledged || 0,
            resolved: scByStatus.resolved || 0,
            missed: scByStatus.missed || 0,
            byReason: scByReason,
            avgResponseTimeSeconds: Math.round(scFacet.responseTimes?.[0]?.avg || 0),
            avgResolutionTimeSeconds: Math.round(scFacet.resolutionTimes?.[0]?.avg || 0)
        }

        // â”€â”€â”€ Shape tablePerformance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Enrich aggregated rows with ServicePoint metadata (label, code, type)
        const spIds = tableAgg
            .map(t => t._id)
            .filter(id => typeof id === "string" && id.startsWith("sp_"))

        const servicePoints = spIds.length > 0
            ? await ServicePoint.find(
                { servicePointId: { $in: spIds }, businessId },
                "servicePointId label code servicePointType"
              ).lean()
            : []

        const spMap = {}
        for (const sp of servicePoints) {
            spMap[sp.servicePointId] = sp
        }

        const tablePerformance = tableAgg.map(t => {
            const sp = spMap[t._id]
            const rev = t.totalRevenue || 0
            const cnt = t.orderCount  || 0
            return {
                servicePointId:   t._id || "",
                label:            sp?.label || t.label || t._id || "Unknown",
                code:             sp?.code  || "",
                servicePointType: sp?.servicePointType || "table",
                orderCount:       cnt,
                totalRevenue:     +rev.toFixed(2),
                averageOrderValue: cnt > 0 ? +(rev / cnt).toFixed(2) : 0,
                paidOrders:       t.paidOrders   || 0,
                unpaidOrders:     t.unpaidOrders || 0,
            }
        })

        // â”€â”€â”€ Shape waitstaffPerformance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const staffMap = {}

        function ensureStaff(id, name) {
            if (!id) return
            if (!staffMap[id]) {
                staffMap[id] = {
                    staffId: id,
                    name: name || "Unknown Staff",
                    callsAcknowledged: 0,
                    callsResolved: 0,
                    totalRespMs: 0,    respCount: 0,
                    totalResolMs: 0,   resolCount: 0,
                    ordersServed: 0,
                    paymentsConfirmed: 0,
                    totalOfflinePaymentsConfirmed: 0,
                }
            }
            // update name if we now have a better value
            if (name && staffMap[id].name === "Unknown Staff") staffMap[id].name = name
        }

        const wcsAgg = waiterCallStaffAgg?.[0] || {}

        for (const row of wcsAgg.acknowledged || []) {
            ensureStaff(row._id, row.name)
            const s = staffMap[row._id]
            s.callsAcknowledged += row.count     || 0
            s.totalRespMs       += row.totalRespMs || 0
            s.respCount         += row.respCount  || 0
        }
        for (const row of wcsAgg.resolved || []) {
            ensureStaff(row._id, row.name)
            const s = staffMap[row._id]
            s.callsResolved  += row.count        || 0
            s.totalResolMs   += row.totalResolMs || 0
            s.resolCount     += row.resolCount   || 0
        }
        for (const row of paymentStaffAgg || []) {
            ensureStaff(row._id, row.name)
            const s = staffMap[row._id]
            s.paymentsConfirmed             += row.paymentsConfirmed             || 0
            s.totalOfflinePaymentsConfirmed += row.totalOfflinePaymentsConfirmed || 0
        }
        for (const row of servedStaffAgg || []) {
            ensureStaff(row._id, row.name)
            staffMap[row._id].ordersServed += row.ordersServed || 0
        }

        const waitstaffPerformance = Object.values(staffMap)
            .map(s => ({
                staffId:                      s.staffId,
                name:                         s.name,
                callsAcknowledged:            s.callsAcknowledged,
                callsResolved:                s.callsResolved,
                avgResponseTimeSeconds:       s.respCount  > 0 ? Math.round(s.totalRespMs  / s.respCount  / 1000) : 0,
                avgResolutionTimeSeconds:     s.resolCount > 0 ? Math.round(s.totalResolMs / s.resolCount / 1000) : 0,
                ordersServed:                 s.ordersServed,
                paymentsConfirmed:            s.paymentsConfirmed,
                totalOfflinePaymentsConfirmed: +s.totalOfflinePaymentsConfirmed.toFixed(2),
            }))
            .sort((a, b) =>
                b.callsResolved - a.callsResolved ||
                b.paymentsConfirmed - a.paymentsConfirmed
            )

        return res.json({
            stats,
            revenueByDay,
            hourlyOrders,
            topItems,
            categoryPerformance,
            orderTypeBreakdown,
            channelBreakdown,
            serviceCalls,
            tablePerformance,
            waitstaffPerformance
        })

    } catch (err) {
        console.error("[ownerAnalytics]", err)
        return res.status(500).json({ error: "Failed to generate owner analytics" })
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /owner/dashboard  â€” Command Center: single aggregated payload
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import Business from "../models/Business.js"
import Feedback from "../models/Feedback.js"
import Staff from "../models/Staff.js"
import MenuItem from "../models/menuItem.js"

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
        await WaiterCall.updateMany(
            { businessId, status: "pending", pendingExpiresAt: { $lte: now } },
            { $set: { status: "missed", missedAt: now } }
        )

        // â”€â”€ Run all queries in parallel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const [
            todayOrdersRaw,
            business,
            recentFeedback,
            activeStaff,
            pendingWaiterCalls,
            missedWaiterCalls,
            totalMenuItems,
            reconciliationCount,
        ] = await Promise.all([
            Order.find({
                ...dateFilter,
                status: { $in: ["placed", "in_progress", "ready", "completed"] }
            }, { total: 1, status: 1, paymentStatus: 1, createdAt: 1, orderId: 1, tableLabel: 1, tableNumber: 1, orderType: 1, paymentChannel: 1, tipAmount: 1 }).lean(),

            Business.findOne({ businessId }).lean(),

            Feedback.find({ businessId })
                .sort({ createdAt: -1 })
                .limit(5)
                .lean(),

            Staff.find({ businessId, $or: [{ presenceStatus: "active" }, { status: "active" }] }).lean(),

            WaiterCall.find({ businessId, status: "pending", createdAt: { $gte: startDateJS, $lt: endDateJS } }).lean(),

            WaiterCall.find({ businessId, status: "missed", createdAt: { $gte: startDateJS, $lt: endDateJS } }).lean(),

            MenuItem.countDocuments({ businessId }),

            Order.countDocuments({
                businessId,
                createdAt: { $lt: startDateJS },
                $or: [
                    { status: { $in: ["placed", "in_progress", "ready"] } },
                    { paymentChannel: "offline", paymentStatus: { $ne: "paid" }, status: { $ne: "cancelled" } }
                ]
            })
        ])

        // â”€â”€ Today's KPIs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const completedOrders = todayOrdersRaw.filter(o => o.status === "completed")
        const paidOrders      = todayOrdersRaw.filter(o => o.paymentStatus === "paid")
        const todayRevenue    = paidOrders.reduce((sum, o) => sum + Number(((o.total || 0) - Number(o.tipAmount || 0)).toFixed(2)), 0)
        const todayOrders     = todayOrdersRaw.length
        const tablesServed    = completedOrders.length
        const activeOrders    = todayOrdersRaw.filter(o => ["placed","in_progress","ready"].includes(o.status)).length

        // â”€â”€ Hourly Revenue (today) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // â”€â”€ Business Health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const onlinePaymentsOk  = business?.stripeChargesEnabled === true
        const billingStatus     = business?.billingStatus || "incomplete"
        const hasMenu           = true // Placeholder â€” could query MenuItem count
        const staffOnlineCount  = activeStaff.length

        // â”€â”€ Action Items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
            actionItems.push({ type: "staff", severity: "info", message: "No staff members are currently active.", href: "/owner/waiters" })
        }

        // â”€â”€ Recent Activity (latest orders + feedback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const recentActivity = []

        // Latest 10 orders as activity events
        const latestOrders = [...todayOrdersRaw]
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 8)

        for (const o of latestOrders) {
            const label = o.tableLabel || o.tableNumber || ""
            if (o.paymentStatus === "paid") {
                recentActivity.push({ type: "payment", icon: "ðŸ’³", message: `Order ${o.orderId} paid`, sub: label, time: o.createdAt })
            } else {
                const statusEmoji = { placed: "ðŸ†•", in_progress: "ðŸ³", ready: "âœ…", completed: "ðŸŽ‰" }
                recentActivity.push({ type: "order", icon: statusEmoji[o.status] || "ðŸ“‹", message: `Order ${o.orderId} ${o.status.replace("_", " ")}`, sub: label ? `${label} Â· ${o.orderType}` : o.orderType, time: o.createdAt })
            }
        }

        // Recent feedback as activity events
        for (const f of recentFeedback.slice(0, 3)) {
            recentActivity.push({ type: "feedback", icon: "â­", message: `New feedback received (${f.overallRating}â˜…)`, sub: f.comment ? f.comment.slice(0, 60) : "No comment", time: f.createdAt })
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

        return res.json({ message: "Branding updated successfully", branding: business.branding })
    } catch (err) {
        console.error("[updateBranding]", err)
        return res.status(500).json({ error: "Failed to update branding" })
    }
}

// ─── Post-Signup Setup Checklist ───────────────────────────────────────────────

export async function getSetupChecklist(req, res) {
    try {
        const businessId = req.session?.user?.businessId;
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const business = await Business.findOne({ businessId }).select('setupChecklist onboardingCompleted onboardingStep').lean();
        if (!business) {
            return res.status(404).json({ error: "Business not found" });
        }

        return res.json({
            setupChecklist: business.setupChecklist || {},
            onboardingCompleted: business.onboardingCompleted || false,
            onboardingStep: business.onboardingStep || null
        });
    } catch (err) {
        console.error("[getSetupChecklist]", err);
        return res.status(500).json({ error: "Server error fetching checklist" });
    }
}

export async function updateSetupChecklist(req, res) {
    try {
        const businessId = req.session?.user?.businessId;
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const { updates, onboardingCompleted, onboardingStep } = req.body;

        const business = await Business.findOne({ businessId });
        if (!business) {
            return res.status(404).json({ error: "Business not found" });
        }

        if (updates && typeof updates === 'object') {
            business.setupChecklist = {
                ...business.setupChecklist,
                ...updates
            };
        }

        if (onboardingCompleted !== undefined) {
            business.onboardingCompleted = onboardingCompleted;
            if (onboardingCompleted && !business.onboardingCompletedAt) {
                business.onboardingCompletedAt = new Date();
            }
        }

        if (onboardingStep !== undefined) {
            business.onboardingStep = onboardingStep;
        }

        await business.save();

        return res.json({
            message: "Setup checklist updated",
            setupChecklist: business.setupChecklist,
            onboardingCompleted: business.onboardingCompleted,
            onboardingStep: business.onboardingStep
        });
    } catch (err) {
        console.error("[updateSetupChecklist]", err);
        return res.status(500).json({ error: "Server error updating checklist" });
    }
}