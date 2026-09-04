import Order from "../models/order.js"
import MenuItem from "../models/menuItem.js"

/**
 * POST /orders/:orderId/reorder
 *
 * Validates the original order's items against the current live menu
 * and returns a reorder payload with current prices.
 *
 * Never creates a new order — only returns cart-ready item data
 * for the frontend to populate the cart.
 *
 * Body: { businessId, sessionId }
 */
export async function reorderFromOrder(req, res) {
  try {
    const { orderId } = req.params
    const { businessId, sessionId } = req.body
    const sessionBusinessId = req.session?.user?.businessId
    const isSameTenantStaff = Boolean(sessionBusinessId && sessionBusinessId === businessId)

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" })
    }

    if (!isSameTenantStaff && !sessionId) {
      return res.status(400).json({ error: "sessionId is required" })
    }

    // Staff may use only their authenticated tenant. Customer devices must
    // prove ownership with the original device session ID.
    const query = { orderId, businessId }
    if (!isSameTenantStaff) {
      query.sessionId = sessionId
    }

    const original = await Order.findOne(query).lean()

    if (!original) {
      return res.status(404).json({ error: "Order not found" })
    }

    if (!original.items || original.items.length === 0) {
      return res.status(400).json({ error: "Original order has no items" })
    }

    // 2. Collect unique item names from the original order
    const originalItemNames = [...new Set(original.items.map((i) => i.itemName))]

    // 3. Load matching live menu items by name + businessId
    const liveItems = await MenuItem.find({
      businessId,
      name: { $in: originalItemNames },
      archivedAt: null,
    }).lean()

    // Build a lookup map: itemName -> liveMenuItem
    const liveMap = {}
    for (const item of liveItems) {
      liveMap[item.name] = item
    }

    // 4. Validate & build reorder payload
    const availableItems = []
    const unavailableItems = []

    for (const ordered of original.items) {
      const live = liveMap[ordered.itemName]

      if (!live) {
        // Item no longer exists in menu
        unavailableItems.push(ordered.itemName)
        continue
      }

      if (!live.isAvailable) {
        // Item exists but is currently unavailable/disabled
        unavailableItems.push(ordered.itemName)
        continue
      }

      // Item is available — use CURRENT menu data (never historical price)
      availableItems.push({
        id: live._id.toString(),
        name: live.name,
        price: live.price,                          // ← always current price
        image: live.imageUrl || "",
        category: live.category || "mains",
        description: live.description || "",
        quantity: ordered.quantity,
        orderCategory: live.type || "food",
      })
    }

    return res.json({
      items: availableItems,
      unavailableItems,
      addedCount: availableItems.length,
    })
  } catch (err) {
    console.error("[reorderFromOrder]", err)
    return res.status(500).json({ error: "Failed to process reorder" })
  }
}
