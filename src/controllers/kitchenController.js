import { DateTime } from "luxon"
import Order from "../models/order.js"
import Staff from "../models/Staff.js"
import { toOrderDTO } from "../utils/orderDTO.js"
import { publishEvent } from "../utils/sseManager.js"

import Business from "../models/Business.js"
import { resolveBusinessDay, resolvePreviousBusinessDay } from "../utils/businessDate.js"

export async function kitchenOrders(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    const business = await Business.findOne({ businessId }).lean()
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    const { startUtc, endUtcExclusive, businessDay, generatedAt } = resolveBusinessDay(business)
    const prev = resolvePreviousBusinessDay(business)

    const ACTIVE_STATUSES = ["placed", "in_progress", "ready"]

    // Pull all fields needed for DTO
    const rawOrders = await Order.find(
      {
        businessId,
        $or: [
          { createdAt: { $gte: startUtc, $lt: endUtcExclusive } },
          {
            createdAt: { $gte: prev.startUtc, $lt: prev.endUtcExclusive },
            status: { $in: ACTIVE_STATUSES },
          },
        ],
      },
      {
        __v: 0,
      },
    )
      .sort({ createdAt: 1 })
      .lean()

    // Transform to unified DTO and filter for food items
    const orders = rawOrders.map((o) => {
      const dto = toOrderDTO(o)
      // Filter items to show only food
      const foodItems = dto.items.filter(item => item.type === "food")
      if (foodItems.length === 0) return null // Skip if no food items

      return {
        ...dto,
        items: foodItems,
        // Recalculate allergies/notes based on filtered items if needed?
        // The prompt says: "allergies: [...new Set(foodItems.flatMap(i => i.allergies || []))]" 
        // asking to update kitchenController logic specifically.
      }
    }).filter(Boolean)

    // Counts for your top cards (strictly current business day activity)
    const counts = { placed: 0, in_progress: 0, ready: 0 }
    for (const o of rawOrders) {
      if (o.createdAt >= startUtc && o.createdAt < endUtcExclusive) {
        counts[o.status] = (counts[o.status] || 0) + 1
      }
    }

    return res.json({
      businessDay,
      generatedAt,
      orders,
      counts,
    })
  } catch (err) {
    console.error("[kitchenOrders]", err)
    return res.status(500).json({ error: "Failed to fetch kitchen orders" })
  }
}

export async function updateOrderStatus(req, res) {
  try {
    const { orderId } = req.params
    const { status: nextStatus } = req.body
    const businessId = req.session?.user?.businessId

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    const VALID_STATUSES = ["placed", "in_progress", "ready", "completed"]
    if (!VALID_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    const order = await Order.findOne({ orderId, businessId })
    if (!order) return res.status(404).json({ error: "Order not found" })

    const allowedNext = {
      placed: ["in_progress"],
      in_progress: ["ready"],
      ready: ["completed"],
      completed: [],
    }

    if (!(allowedNext[order.status] || []).includes(nextStatus)) {
      return res.status(400).json({
        error: `Invalid transition ${order.status} -> ${nextStatus}`,
      })
    }

    // ✅ Guard: Offline orders must be paid before being marked as completed (served)
    if (nextStatus === "completed" && order.paymentChannel === "offline" && order.paymentStatus !== "paid") {
      return res.status(400).json({
        error: "Offline orders must be paid before being served",
      })
    }

    if (nextStatus === "completed") {
      const staffName = req.session?.user?.name
      const staffId = req.session?.user?.staffId || req.session?.user?.id

      if (staffName) {
        order.completedBy = staffName
      } else if (staffId) {
        // Fallback: look up name from DB using staffId
        const staff = await Staff.findOne({ 
          businessId, 
          staffId
        })
        if (staff) order.completedBy = staff.name
      }

      // Waiter attribution for analytics (servedByStaffId is only set on waiter route)
      if (staffId) order.servedByStaffId = staffId
      if (staffName) order.servedByName   = staffName
      order.servedAt    = new Date()
      order.completedAt = new Date()
    }

    order.status = nextStatus
    await order.save()

    const orderDTO = toOrderDTO(order)

    // --- SSE via Redis pub/sub ---
    const foodItems = order.items.filter(i => i.category === "food" || i.type === "food")
    const drinkItems = order.items.filter(i => i.type === "drinks")

    // Kitchen: food items only
    if (foodItems.length > 0) {
      const kitchenDTO = { ...orderDTO, items: foodItems }
      await publishEvent("order_updated", order.businessId, ["kitchen"], { order: kitchenDTO })
    }

    // Bar: drink items only
    if (drinkItems.length > 0) {
      const barDTO = { ...orderDTO, items: drinkItems }
      await publishEvent("order_updated", order.businessId, ["bar"], { order: barDTO })
    }

    // Waiter + table: full order
    await publishEvent("order_updated", order.businessId, ["waiter", "table", "anon"], { order: orderDTO })

    return res.json({
      success: true,
      orderId: order.orderId,
      status: order.status,
      updatedAt: order.updatedAt,
    })
  } catch (err) {
    console.error("[updateOrderStatus]", err)
    return res.status(500).json({ error: "Failed to update order status" })
  }
}
