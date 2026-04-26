import { DateTime } from "luxon"
import Order from "../models/order.js"
import { toOrderDTO } from "../utils/orderDTO.js"

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

export async function barOrders(req, res) {
  try {
    const businessId = req.session?.user?.businessId || req.query.businessId || req.query.restaurantId
    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    const { startJS, endJS, businessDay, generatedAt } = getBusinessDayRange()

    // Bar cares about active orders to see drinks
    const ACTIVE_STATUSES = ["placed", "in_progress", "ready"]

    const rawOrders = await Order.find(
      {
        businessId,
        createdAt: { $gte: startJS, $lt: endJS },
        status: { $in: ACTIVE_STATUSES },
      },
      {
        __v: 0,
      },
    )
      .sort({ createdAt: 1 })
      .lean()

    const orders = rawOrders.map((o) => {
      const dto = toOrderDTO(o)
      // Filter items to show only drinks
      const drinkItems = dto.items.filter(item => item.type === "drinks")
      if (drinkItems.length === 0) return null // Skip if no drink items

      return {
        ...dto,
        items: drinkItems,
      }
    }).filter(Boolean)

    const counts = { placed: 0, in_progress: 0, ready: 0 }
    for (const o of rawOrders) {
      const hasDrinks = o.items.some(i => i.type === "drinks")
      if (hasDrinks) counts[o.status] = (counts[o.status] || 0) + 1
    }

    return res.json({
      businessDay,
      generatedAt,
      orders,
      counts,
    })
  } catch (err) {
    console.error("[barOrders]", err)
    return res.status(500).json({ error: "Failed to fetch bar orders" })
  }
}
