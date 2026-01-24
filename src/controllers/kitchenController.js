import { DateTime } from "luxon"
import Order from "../models/order.js"

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

    // Pull only what the kitchen needs; "lean" gives plain JS objects
    const rawOrders = await Order.find(
      {
        createdAt: { $gte: startJS, $lt: endJS },
        status: { $in: ACTIVE_STATUSES },
      },
      {
        _id: 0,
        orderId: 1,
        tableNumber: 1,
        orderType: 1,
        status: 1,
        createdAt: 1,
        updatedAt: 1,
        items: 1,
      },
    )
      .sort({ createdAt: 1 })
      .lean()

    // Sort by status priority (placed -> in_progress -> ready) + createdAt
    const statusRank = { placed: 1, in_progress: 2, ready: 3 }
    rawOrders.sort((a, b) => {
      const rankDiff = (statusRank[a.status] || 99) - (statusRank[b.status] || 99)
      if (rankDiff !== 0) return rankDiff
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })

    // Transform to match your FE shape: add order-level notes/allergies
    const orders = rawOrders.map((o) => {
      const allergiesSet = new Set()

      // ✅ CHANGE: take ONE special request note (standalone), not "itemName: note"
      let specialRequest = ""

      for (const it of o.items || []) {
        if (Array.isArray(it.allergies)) {
          for (const a of it.allergies) {
            if (a && String(a).trim()) allergiesSet.add(String(a).trim())
          }
        }

        // grab first non-empty note (you mapped same note to all items)
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
        items: (o.items || []).map((it) => ({
          itemName: it.itemName,
          quantity: it.quantity,
          // you can include per-item notes/allergies too if you want later
        })),
        allergies: Array.from(allergiesSet),
        notes: specialRequest, // ✅ standalone note
      }
    })

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

    order.status = nextStatus
    await order.save()

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
