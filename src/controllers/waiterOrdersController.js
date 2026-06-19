import { DateTime } from "luxon"
import Order from "../models/order.js"
import MenuItem from "../models/menuItem.js"
import Business from "../models/Business.js"
import Plan from "../models/Plan.js"
import ServicePoint from "../models/ServicePoint.js"
import { generateOrderId } from "../utils/orderId.js"
import { toOrderDTO } from "../utils/orderDTO.js"
import { publishEvent } from "../utils/sseManager.js"
import { isBusinessOpen } from "../utils/operatingHours.js"
import { calculateOfflineCommission } from "../utils/platformFee.js"

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
        startJS: start.toJSDate(),
        endJS: end.toJSDate(),
        businessDay: start.toISODate(),
        generatedAt: now.toISO(),
    }
}

// ✅ NEW: waiter can fetch ANY status (ready/placed/in_progress/completed/all)
// GET /waiter?status=ready
export async function waiterOrders(req, res) {
    try {
        const { startJS, endJS, businessDay, generatedAt } = getBusinessDayRange()

        const status = String(req.query.status || "ready")
        const businessId = req.session?.user?.businessId

        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        // Surface the waiter-ordering setting so the dashboard can show/hide the
        // "+ Take Order" button. Defaults to enabled when unset.
        const bizPrefs = await Business.findOne(
            { $or: [{ businessId }, { restaurantId: businessId }] },
            { "orderingPreferences.enableWaiterOrdering": 1 }
        ).lean()
        const enableWaiterOrdering = bizPrefs?.orderingPreferences?.enableWaiterOrdering !== false

        // ✅ Fetch all relevant statuses so FE can calculate counts for tabs
        // The FE sends ?status=... but relies on receiving ALL data to show badge counts
        const WAITER_STATUSES = ["placed", "in_progress", "ready", "completed"]

        const filter = {
            businessId,
            createdAt: { $gte: startJS, $lt: endJS },
            status: { $in: WAITER_STATUSES },
        }

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
            }
        )
            // ✅ show READY first if status=all, else normal ordering
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean()

        // ✅ counts for tabs (placed/in_progress/ready/completed)
        const countsAgg = await Order.aggregate([
            { $match: { businessId, createdAt: { $gte: startJS, $lt: endJS } } },
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
                businessId: o.businessId,
                restaurantId: o.businessId, // legacy alias
                orderId: o.orderId,
                tableNumber: o.tableNumber,
                tableLabel: o.tableLabel || o.tableNumber,
                orderType: o.orderType,
                status: o.status,
                createdAt: o.createdAt,
                readyAt: o.readyAt,
                updatedAt: o.updatedAt,
                paymentChannel: o.paymentChannel,
                paymentStatus: o.paymentStatus,
                paidVia: o.paidVia,
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

        return res.json({ businessDay, generatedAt, counts, orders, settings: { enableWaiterOrdering } })
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

export async function createWaiterOrder(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    const staffId = req.session?.user?.staffId || req.session?.user?.id
    
    if (!businessId) {
      return res.status(403).json({ message: "Unauthorized: Missing businessId in session" })
    }

    const { tableNumber, items, orderType, currency } = req.body

    if (!tableNumber || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "tableNumber and items are required" })
    }

    const allowedTypes = ["dine-in", "takeout"]
    const finalOrderType = orderType || "dine-in"

    if (!allowedTypes.includes(finalOrderType)) {
      return res.status(400).json({ message: `Invalid orderType. Use: ${allowedTypes.join(", ")}` })
    }

    // Verify service point belongs to this business
    const sp = await ServicePoint.findOne({ servicePointId: tableNumber, businessId }).lean()
    if (!sp) {
      return res.status(403).json({ message: "Invalid service point for this business." })
    }

    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    }).lean()

    if (!business) {
      return res.status(404).json({ success: false, message: "Business not found." })
    }

    // Enforce the waiter-assisted ordering setting on the server — hiding the
    // button on the client is not sufficient. Defaults to enabled when unset.
    if (business.orderingPreferences?.enableWaiterOrdering === false) {
      return res.status(403).json({
        success: false,
        message: "Waiter-assisted ordering is disabled for this business.",
      })
    }

    const openStatus = isBusinessOpen(business)
    if (!openStatus.isOpen) {
      return res.status(403).json({
        error: `Business is closed. Will open ${openStatus.nextOpeningTime}.`
      })
    }

    const tableLabel = sp.label || sp.code || tableNumber
    const tableCode = sp.code || sp.label || tableNumber

    const now = new Date()
    const orderId = generateOrderId(tableCode, now)

    let calculatedTotal = 0
    const enrichedItems = await Promise.all(
      items.map(async (item) => {
        const menuItem = await MenuItem.findOne({ name: item.itemName, businessId }).lean()
        if (!menuItem) {
          throw new Error(`Menu item '${item.itemName}' is no longer available.`)
        }
        
        const unitPrice = menuItem.price || 0
        const itemType = menuItem.type || (item.orderCategory === "drinks" ? "drinks" : "food")
        const displayCategory = menuItem.category || "mains"
        const itemImage = menuItem.imageUrl || item.image || ""

        const itemLineTotal = Number((unitPrice * item.quantity).toFixed(2))
        calculatedTotal += itemLineTotal

        return {
          itemName: item.itemName,
          quantity: item.quantity,
          lineTotal: itemLineTotal,
          type: itemType,
          category: displayCategory,
          notes: item.notes || "",
          allergies: item.allergies || [],
          image: itemImage
        }
      })
    )

    const hasFood = enrichedItems.some(i => i.type === "food")
    const initialStatus = hasFood ? "placed" : "ready"

    const subtotal = Number(calculatedTotal.toFixed(2))
    const taxRate = business.taxRate || 0
    const taxAmount = Number((subtotal * (taxRate / 100)).toFixed(2))

    const totalInCentsForFee = Math.round(subtotal * 100)
    const { commissionAmountCents, commissionRateApplied, planApplied } = await calculateOfflineCommission(totalInCentsForFee, business.currentPlan || "basic")
    
    let platformFeeTotal = 0
    if (business.passPlatformFeeToCustomer) {
      platformFeeTotal = Number((subtotal * (commissionRateApplied / 100)).toFixed(2))
    }

    let finalCommissionAmountCents = commissionAmountCents
    if (business.passPlatformFeeToCustomer && platformFeeTotal > 0) {
      finalCommissionAmountCents = Math.round(platformFeeTotal * 100)
    }

    const finalTotal = Number((subtotal + taxAmount + platformFeeTotal).toFixed(2))

    const saved = await Order.create({
      orderId,
      businessId,
      tableNumber,
      tableLabel,
      orderType: finalOrderType,
      sessionId: `waiter_${staffId}_${Date.now()}`,
      items: enrichedItems,
      status: initialStatus,
      subtotal,
      taxAmount,
      platformFeeTotal,
      total: finalTotal,
      currency: currency || business.currency || "EUR",
      paymentChannel: "offline",
      paymentStatus: "unpaid",
      paidVia: null,
      planApplied,
      commissionRateApplied,
      commissionAmountCents: finalCommissionAmountCents,
      orderSource: "waitstaff",
      createdBy: "staff",
      createdByStaffId: staffId
    })

    const orderDTO = toOrderDTO(saved)

    const foodItems = saved.items.filter(i => i.type === "food")
    const drinkItems = saved.items.filter(i => i.type === "drinks")

    if (foodItems.length > 0) {
      const kitchenDTO = { ...orderDTO, items: foodItems }
      await publishEvent("order_created", businessId, ["kitchen"], { order: kitchenDTO })
    }

    if (drinkItems.length > 0) {
      const barDTO = { ...orderDTO, items: drinkItems }
      await publishEvent("order_created", businessId, ["bar"], { order: barDTO })
    }

    await publishEvent("order_created", businessId, ["waiter", "table", "anon"], { order: orderDTO })

    return res.status(201).json({ orderId: saved.orderId, businessId: saved.businessId, status: saved.status })
  } catch (err) {
    console.error("Create waiter order error:", err)
    if (err.message && err.message.includes("is no longer available")) {
      return res.status(400).json({ error: err.message })
    }
    return res.status(500).json({ message: "Server error" })
  }
}
