import express from "express"
import crypto from "crypto"
import Order from "../models/Order.js"

const router = express.Router()

function pad2(n) {
  return String(n).padStart(2, "0")
}
function ddmmyy(date = new Date()) {
  const dd = pad2(date.getDate())
  const mm = pad2(date.getMonth() + 1)
  const yy = String(date.getFullYear()).slice(2)
  return `${dd}${mm}${yy}`
}
function hhmmss(date = new Date()) {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}
function rand4() {
  const num = crypto.randomInt(0, 10000)
  return String(num).padStart(4, "0")
}

// GET /orders?sessionId=... OR /orders?tableNumber=...
router.get("/", async (req, res) => {
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
})

// POST /orders
router.post("/", async (req, res) => {
  try {
    const { tableNumber, items, sessionId } = req.body

    if (!tableNumber || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "tableNumber and items are required" })
    }

    const now = new Date()
    const orderId = `QS-${ddmmyy(now)}-T${tableNumber}-${hhmmss(now)}-${rand4()}`

    const saved = await Order.create({
      orderId,
      tableNumber,
      sessionId, // optional
      items,
      status: "placed",
    })

    return res.status(201).json({ orderId: saved.orderId, status: saved.status })
  } catch (err) {
    console.error("Create order error:", err)
    return res.status(500).json({ message: "Server error" })
  }
})

// GET /orders/:orderId
router.get("/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params

    const order = await Order.findOne({ orderId }).lean()
    if (!order) return res.status(404).json({ message: "Order not found" })

    return res.json(order)
  } catch (err) {
    console.error("Get order error:", err)
    return res.status(500).json({ message: "Server error" })
  }
})

// PATCH /orders/:orderId/status
router.patch("/:orderId/status", async (req, res) => {
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
})

export default router
