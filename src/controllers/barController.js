import { DateTime } from "luxon"
import Order from "../models/order.js"
import { toOrderDTO } from "../utils/orderDTO.js"

import Business from "../models/Business.js"
import { resolveBusinessDay, resolvePreviousBusinessDay } from "../utils/businessDate.js"

export async function barOrders(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const business = await Business.findOne({ businessId }).lean()
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    const { startUtc, endUtcExclusive, businessDay, generatedAt } = resolveBusinessDay(business)
    const prev = resolvePreviousBusinessDay(business)

    // Bar cares about active orders to see drinks
    const ACTIVE_STATUSES = ["placed", "in_progress", "ready"]

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
      if (o.createdAt >= startUtc && o.createdAt < endUtcExclusive) {
        const hasDrinks = o.items.some(i => i.type === "drinks")
        if (hasDrinks) counts[o.status] = (counts[o.status] || 0) + 1
      }
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
