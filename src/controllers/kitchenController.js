import { DateTime } from "luxon"
import Order from "../models/order.js"
import { toOrderDTO } from "../utils/orderDTO.js"
import { broadcast } from "../utils/sseManager.js"

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

export async function kitchenOrders(req, res) {
  try {
    const { startJS, endJS, businessDay, generatedAt } = getBusinessDayRange()

    const ACTIVE_STATUSES = ["placed", "in_progress", "ready"]

    // Pull all fields needed for DTO
    const rawOrders = await Order.find(
      {
        createdAt: { $gte: startJS, $lt: endJS },
        status: { $in: ACTIVE_STATUSES },
      },
      {
        __v: 0,
      },
    )
      .sort({ createdAt: 1 })
      .lean()

    // Transform to unified DTO
    const orders = rawOrders.map((o) => toOrderDTO(o))

    // Counts for your top cards (optional, but nice)
    const counts = { placed: 0, in_progress: 0, ready: 0 }
    for (const o of rawOrders) counts[o.status] = (counts[o.status] || 0) + 1

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

    const VALID_STATUSES = ["placed", "in_progress", "ready", "completed"]
    if (!VALID_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    const order = await Order.findOne({ orderId })
    if (!order) return res.status(404).json({ error: "Order not found" })

    const allowedNext = {
      placed: ["in_progress"],
      in_progress: ["ready"],
      ready: ["completed"],
      completed: [],
    }

    if (!allowedNext[order.status].includes(nextStatus)) {
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

    order.status = nextStatus
    await order.save()

    const orderDTO = toOrderDTO(order)
    broadcast("order_updated", { order: orderDTO })

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
