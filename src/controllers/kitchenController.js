import Business from "../models/Business.js"
import Order from "../models/order.js"
import {
  deriveStationStatus,
  transitionOrderFulfillment,
} from "../services/orderFulfillmentService.js"
import { publishOrderRealtime, toStationOrderDTO } from "../services/orderRealtimeService.js"
import { resolveBusinessDay, resolvePreviousBusinessDay } from "../utils/businessDate.js"
import { toOrderDTO } from "../utils/orderDTO.js"
import { invalidateMenuItems } from "../services/cacheInvalidationService.js"

export async function kitchenOrders(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    if (!businessId) return res.status(400).json({ error: "businessId is required" })

    const business = await Business.findOne({ businessId }).lean()
    if (!business) return res.status(404).json({ error: "Business not found" })

    const { startUtc, endUtcExclusive, businessDay, generatedAt } = resolveBusinessDay(business)
    const prev = resolvePreviousBusinessDay(business)
    const activeStatuses = ["placed", "in_progress", "ready"]
    const rawOrders = await Order.find({
      businessId,
      $or: [
        { createdAt: { $gte: startUtc, $lt: endUtcExclusive } },
        {
          createdAt: { $gte: prev.startUtc, $lt: prev.endUtcExclusive },
          status: { $in: activeStatuses },
        },
      ],
    }, { __v: 0 }).sort({ createdAt: 1 }).lean()

    const orders = rawOrders.map((order) => {
      const dto = toOrderDTO(order, { includeFulfillment: true })
      if (!activeStatuses.includes(dto.status)) return null
      const items = dto.items.filter((item) => item.fulfillmentStation === "kitchen")
      if (items.length === 0) return null
      return { ...dto, items, stationStatus: deriveStationStatus(items) }
    }).filter(Boolean)

    const counts = { placed: 0, in_progress: 0, ready: 0 }
    for (const order of orders) {
      const createdAt = new Date(order.createdAt)
      if (createdAt >= startUtc && createdAt < endUtcExclusive) {
        counts[order.stationStatus] = (counts[order.stationStatus] || 0) + 1
      }
    }

    return res.json({ businessDay, generatedAt, orders, counts })
  } catch (err) {
    console.error("[kitchenOrders]", err)
    return res.status(500).json({ error: "Failed to fetch kitchen orders" })
  }
}

export async function updateOrderStatus(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })

    const result = await transitionOrderFulfillment({
      businessId,
      orderId: req.params.orderId,
      station: "kitchen",
      action: req.body?.action,
      orderLineIds: req.body?.orderLineIds,
      actor: req.session.user,
    })
    if (result.inventoryChanged) await invalidateMenuItems(businessId)
    if (result.changed) {
      await publishOrderRealtime("order_updated", result.order, {
        action: `kitchen_${req.body.action}`,
        customerNotification: result.customerNotification,
      })
    }
    return res.json({
      success: true,
      orderId: result.order.orderId,
      status: result.order.status,
      stationStatus: deriveStationStatus(
        result.order.items.filter((item) => item.fulfillmentStation === "kitchen"),
      ),
      changed: result.changed,
      updatedAt: result.order.updatedAt,
      order: toStationOrderDTO(result.order, "kitchen"),
    })
  } catch (err) {
    console.error("[updateKitchenFulfillment]", err)
    if (Number.isInteger(err?.statusCode)) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code })
    }
    return res.status(500).json({ error: "Failed to update kitchen fulfilment" })
  }
}
