import { DateTime } from "luxon"
import Order from "../models/order.js"

import Business from "../models/Business.js"
import { resolveBusinessDay, resolvePreviousBusinessDay } from "../utils/businessDate.js"

// ✅ NEW: waiter can fetch ANY status (ready/placed/in_progress/completed/all)
// GET /waitstaff?status=ready
export async function waiterOrders(req, res) {
    try {
        const businessId = req.query.businessId || req.query.businessId
        if (!businessId) {
            return res.status(400).json({ error: "businessId is required" })
        }

        const business = await Business.findOne({ businessId }).lean()
        if (!business) {
            return res.status(404).json({ error: "Business not found" })
        }

        const { startUtc, endUtcExclusive, businessDay, generatedAt } = resolveBusinessDay(business)
        const prev = resolvePreviousBusinessDay(business)

        const status = String(req.query.status || "ready")

        // Waitstaff active statuses (unresolved work)
        const ACTIVE_STATUSES = ["placed", "in_progress", "ready"]
        const WAITER_STATUSES = ["placed", "in_progress", "ready", "completed"]

        const filter = {
            businessId,
            $or: [
                { createdAt: { $gte: startUtc, $lt: endUtcExclusive }, status: { $in: WAITER_STATUSES } },
                {
                    createdAt: { $gte: prev.startUtc, $lt: prev.endUtcExclusive },
                    status: { $in: ACTIVE_STATUSES },
                },
            ]
        }

        const rawOrders = await Order.find(
            filter,
            {
                _id: 0,
                orderId: 1,
                servicePointLabel: 1,
                orderType: 1,
                status: 1,
                createdAt: 1,
                updatedAt: 1,
                readyAt: 1,
                items: 1,

                // ✅ totals only for waiter
                // subtotalCents: 1,
                // taxCents: 1,
                // totalCents: 1,
                total: 1,
                currency: 1,
            }
        )
            // ✅ show READY first if status=all, else normal ordering
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean()

        // ✅ counts for tabs (placed/in_progress/ready/completed)
        // Only count current day's activity
        const countsAgg = await Order.aggregate([
            { $match: { businessId, createdAt: { $gte: startUtc, $lt: endUtcExclusive } } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
        ])

        const counts = { placed: 0, in_progress: 0, ready: 0, completed: 0 }
        for (const row of countsAgg) {
            if (row?._id && counts[row._id] !== undefined) counts[row._id] = row.count
        }

        // ✅ shape for FE
        const orders = rawOrders.map((o) => {
            const allergiesSet = new Set()
            let specialRequest = ""

            for (const it of o.items || []) {
                if (Array.isArray(it.allergies)) {
                    for (const a of it.allergies) {
                        if (a && String(a).trim()) allergiesSet.add(String(a).trim())
                    }
                }
                // grab first non-empty note
                if (!specialRequest && it.notes && String(it.notes).trim()) {
                    specialRequest = String(it.notes).trim()
                }
            }

            return {
                orderId: o.orderId,
                servicePointLabel: o.servicePointLabel,
                orderType: o.orderType,
                status: o.status,
                createdAt: o.createdAt,
                readyAt: o.readyAt,
                updatedAt: o.updatedAt,
                items: (o.items || []).map((it) => ({
                    itemName: it.itemName,
                    quantity: it.quantity,
                    notes: it.notes,
                    allergies: it.allergies
                })),
                allergies: Array.from(allergiesSet),
                notes: specialRequest,
                total: o.total,
                // subtotalCents: o.subtotalCents || 0,
                // taxCents: o.taxCents || 0,
                // totalCents: o.totalCents || 0,
                currency: o.currency || "EUR",
            }
        })

        // ✅ optional: if status=all, prioritize ready -> in_progress -> placed -> completed
        if (status === "all") {
            const rank = { ready: 1, in_progress: 2, placed: 3, completed: 4 }
            orders.sort((a, b) => (rank[a.status] || 99) - (rank[b.status] || 99))
        }

        return res.json({ businessDay, generatedAt, counts, orders })
    } catch (err) {
        console.error("[waiterOrders]", err)
        return res.status(500).json({ error: "Failed to fetch waiter orders" })
    }
}

// keep your ready endpoint if you still want it
export async function waiterReadyOrders(req, res) {
    req.query.status = "ready"
    return waiterOrders(req, res)
}
