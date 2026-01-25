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

export async function waiterOrders(req, res) {
  try {
    const { startJS, endJS, businessDay, generatedAt } = getBusinessDayRange()
    const status = String(req.query.status || "ready")

    const allowed = ["placed", "in_progress", "ready", "all"]
    const final = allowed.includes(status) ? status : "ready"

    const statusFilter =
      final === "all" ? { $in: ["placed", "in_progress", "ready", "completed"] } : final

    const rawOrders = await Order.find(
      {
        createdAt: { $gte: startJS, $lt: endJS },
        status: statusFilter,
      },
      {
        _id: 0,
        orderId: 1,
        tableNumber: 1,
        orderType: 1,
        status: 1,
        createdAt: 1,
        updatedAt: 1,
        readyAt: 1,
        completedAt: 1,
        items: 1,
        totalCents: 1,
        currency: 1,
      },
    )
      .sort({ createdAt: -1 })
      .lean()

    const orders = rawOrders.map((o) => ({
      orderId: o.orderId,
      tableNumber: o.tableNumber,
      orderType: o.orderType,
      status: o.status,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      readyAt: o.readyAt,
      completedAt: o.completedAt,
      items: (o.items || []).map((it) => ({
        itemName: it.itemName,
        quantity: it.quantity,
      })),
      totalCents: typeof o.totalCents === "number" ? o.totalCents : 0,
      currency: o.currency || "EUR",
      // If you’re keeping order-level notes/allergies elsewhere, add them here too
      notes: o.notes,
      allergies: o.allergies,
    }))

    return res.json({ businessDay, generatedAt, orders })
  } catch (err) {
    console.error("[waiterOrders]", err)
    return res.status(500).json({ error: "Failed to fetch waiter orders" })
  }
}
