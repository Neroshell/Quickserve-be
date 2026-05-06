import Order from "../models/order.js"
import Business from "../models/Business.js"
import { toOrderDTO } from "../utils/orderDTO.js"
import { getBusinessDayRange } from "../utils/businessDay.js"



export async function barOrders(req, res) {
  try {
    const businessId = req.session?.user?.businessId || req.query.businessId || req.query.restaurantId
    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    const business = await Business.findOne({ businessId }, "timezone operatingHours").lean()
    const { startJS, endJS, businessDay, generatedAt } = getBusinessDayRange(business)

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
