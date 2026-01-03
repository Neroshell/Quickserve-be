import Order from "../models/order.js"
import TableSession from "../models/TableSession.js"
import { generateOrderId } from "../utils/orderId.js"

export async function listOrders(req, res) {
  try {
    const { sessionId, tableNumber } = req.query

    const filter = {}
    if (sessionId) filter.sessionId = sessionId
    if (tableNumber) filter.tableNumber = tableNumber

    if (!sessionId && !tableNumber) {
      return res.status(400).json({ message: "Provide sessionId or tableNumber" })
    }

    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean()
    return res.json(orders)
  } catch (err) {
    console.error("List orders error:", err)
    return res.status(500).json({ message: "Server error" })
   
  }
}

export async function createOrder(req, res) {
  try {
    const { tableNumber, items, sessionId, tableSessionToken, orderType } = req.body

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" })
    }
    if (!tableSessionToken) {
      return res.status(400).json({ message: "tableSessionToken is required" })
    }
    if (!tableNumber || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "tableNumber and items are required" })
    }

    // ✅ Minimal validation for orderType
    const allowedTypes = ["dine-in", "takeout"]
    const finalOrderType = orderType || "dine-in"

    if (!allowedTypes.includes(finalOrderType)) {
      return res.status(400).json({ message: `Invalid orderType. Use: ${allowedTypes.join(", ")}` })
    }

    // Validate token
    const ts = await TableSession.findOne({ token: tableSessionToken })
    if (!ts) {
      return res.status(403).json({ message: "Invalid or expired table session. Please rescan the QR code." })
    }

    // Expiry check
    if (ts.expiresAt.getTime() < Date.now()) {
      return res.status(403).json({ message: "Session expired. Please rescan the QR code." })
    }

    // Table must match
    if (ts.tableId !== tableNumber) {
      return res.status(403).json({ message: "Table session mismatch. Please rescan the correct table QR." })
    }

    // Bind token to first device sessionId
    if (!ts.boundSessionId) {
      ts.boundSessionId = sessionId
      await ts.save()
    } else if (ts.boundSessionId !== sessionId) {
      return res.status(403).json({ message: "This table session is already in use on another device." })
    }

    const now = new Date()
    const orderId = generateOrderId(tableNumber, now)

    const saved = await Order.create({
      orderId,
      tableNumber,
      orderType: finalOrderType, // ✅ always valid + always present
      sessionId,
      items,
      status: "placed",
    })

    return res.status(201).json({ orderId: saved.orderId, status: saved.status })
  } catch (err) {
    console.error("Create order error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}


export async function getOrderById(req, res) {
  try {
    const { orderId } = req.params

    const order = await Order.findOne({ orderId }).lean()
    if (!order) return res.status(404).json({ message: "Order not found" })

    return res.json(order)
  } catch (err) {
    console.error("Get order error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}

export async function updateOrderStatus(req, res) {
  try {
    const { orderId } = req.params
    const { status } = req.body

    const allowed = ["placed", "in_progress", "ready", "completed"]
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: `Invalid status. Use: ${allowed.join(", ")}` })
    }

    const updated = await Order.findOneAndUpdate({ orderId }, { status }, { new: true }).lean()
    if (!updated) return res.status(404).json({ message: "Order not found" })

    return res.json({ orderId: updated.orderId, status: updated.status })
  } catch (err) {
    console.error("Update status error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}
