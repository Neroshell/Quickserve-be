import Order from "../models/order.js"
import TableSession from "../models/TableSession.js"
import PendingCheckout from "../models/PendingCheckout.js"
import { generateOrderId } from "../utils/orderId.js"
import MenuItem from "../models/menuItem.js"
import { toOrderDTO } from "../utils/orderDTO.js"
import { broadcast } from "../utils/sseManager.js"
import { sendReceiptEmail } from "../utils/emailService.js"


export async function listOrders(req, res) {
  try {
    const { sessionId, tableNumber, restaurantId } = req.query

    if (!restaurantId) {
      return res.status(400).json({ message: "restaurantId is required" })
    }

    const filter = { restaurantId }
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
    const {
      tableNumber, items, sessionId, tableSessionToken, orderType, total, currency,
      paymentChannel, paymentStatus, paidVia, receiptEmail
    } = req.body

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

    // // Enrich items with category
    // const enrichedItems = await Promise.all(
    //   items.map(async (item) => {
    //     const menuItem = await MenuItem.findOne({ name: item.itemName }).lean()
    //     return {
    //       itemName: item.itemName,
    //       quantity: item.quantity,
    //       category: menuItem?.category || "food", // Fallback to food
    //       notes: item.notes || "",
    //       allergies: item.allergies || []
    //     }
    //   })
    // )

    // Enrich items with category and unitPrice from DB (authoritative)
    let calculatedTotal = 0
    // Get restaurantId from req body (fallback to env/default while Auth is built)
    const restaurantId = req.body.restaurantId || process.env.NEXT_PUBLIC_RESTAURANT_ID || "default-restaurant-id"

    const enrichedItems = await Promise.all(
      items.map(async (item) => {
        const menuItem = await MenuItem.findOne({ name: item.itemName, restaurantId }).lean()
        // Authoritative from DB, fallback to provided price, else 0
        const unitPrice = menuItem?.price || item.unitPrice || 0
        const itemType = menuItem?.type || (item.orderCategory === "drinks" ? "drinks" : "food")
        const displayCategory = menuItem?.category || "mains"

        const itemLineTotal = Number((unitPrice * item.quantity).toFixed(2))
        calculatedTotal += itemLineTotal

        return {
          itemName: item.itemName,
          quantity: item.quantity,
          lineTotal: itemLineTotal,
          type: itemType,
          category: displayCategory,
          notes: item.notes || "",
          allergies: item.allergies || []
        }
      })
    )

    // Detect drinks-only order
    const hasFood = enrichedItems.some(i => i.type === "food")
    const initialStatus = hasFood ? "placed" : "ready"

    // Use calculated total if possible, fallback to frontend total
    const finalTotal = calculatedTotal > 0 ? Number(calculatedTotal.toFixed(2)) : (Number(total) || 0)

    const saved = await Order.create({
      orderId,
      restaurantId,
      tableNumber,
      orderType: finalOrderType, // ✅ always valid + always present
      sessionId,
      items: enrichedItems,
      status: initialStatus, // ✅ Skip kitchen workflow for drinks
      total: finalTotal,
      currency: currency || "EUR",
      paymentChannel: paymentChannel || "offline",
      paymentStatus: paymentStatus || "unpaid",
      paidVia: paidVia || null,
      receiptEmail: receiptEmail || null,
    })

    const orderDTO = toOrderDTO(saved)

    // --- SSE SPLIT ---
    const foodItems = saved.items.filter(i => i.type === "food")

    // Dynamic import to avoid circular dependency issues if any
    const { broadcast, broadcastToRole } = await import("../utils/sseManager.js")

    // 1. Send to Kitchen: Food Only
    if (foodItems.length > 0) {
      const kitchenDTO = { ...orderDTO, items: foodItems }
      // Send only to kitchen role
      broadcastToRole("kitchen", "order_created", { order: kitchenDTO })
    }

    // 2. Send to Waiters & Tables: Full Order
    // We exclude 'kitchen' role from this broadcast to avoid duplicates/wrong data
    broadcast("order_created", { order: orderDTO }, (client) => client.role !== "kitchen")

    return res.status(201).json({ orderId: saved.orderId, restaurantId: saved.restaurantId, status: saved.status })
  } catch (err) {
    console.error("Create order error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}


export async function getOrderById(req, res) {
  try {
    const { orderId } = req.params
    const restaurantId = req.query.restaurantId || req.params.restaurantId

    if (!restaurantId) {
      return res.status(400).json({ message: "restaurantId is required" })
    }

    const order = await Order.findOne({ orderId, restaurantId }).lean()
    if (!order) return res.status(404).json({ message: "Order not found" })

    return res.json(order)
  } catch (err) {
    console.error("Get order error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}

// export async function updateOrderStatus(req, res) {
//   try {
//     const { orderId } = req.params
//     const { status } = req.body

//     const allowed = ["placed", "in_progress", "ready", "completed"]
//     if (!allowed.includes(status)) {
//       return res.status(400).json({ message: `Invalid status. Use: ${allowed.join(", ")}` })
//     }

//     const updated = await Order.findOneAndUpdate({ orderId }, { status }, { new: true }).lean()
//     if (!updated) return res.status(404).json({ message: "Order not found" })

//     return res.json({ orderId: updated.orderId, status: updated.status })
//   } catch (err) {
//     console.error("Update status error:", err)
//     return res.status(500).json({ message: "Server error" })
//   }
// }

export async function deleteOrdersBySession(req, res) {
  try {
    const { sessionId, restaurantId } = req.body

    if (!sessionId || !restaurantId) {
      return res.status(400).json({ message: "sessionId and restaurantId are required" })
    }

    const result = await Order.deleteMany({ sessionId, restaurantId })

    return res.json({
      message: "Order history cleared",
      deletedCount: result.deletedCount,
    })
  } catch (err) {
    console.error("Delete session orders error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}

export async function updateOrderStatus(req, res) {
  try {
    const { orderId } = req.params
    const { status: nextStatus, restaurantId } = req.body

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" })
    }

    const VALID_STATUSES = ["placed", "in_progress", "ready", "completed"]
    if (!VALID_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    const order = await Order.findOne({ orderId, restaurantId })
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

    // ✅ add timestamps when certain statuses happen
    if (nextStatus === "ready" && !order.readyAt) order.readyAt = new Date()
    if (nextStatus === "completed" && !order.completedAt) order.completedAt = new Date()

    await order.save()

    const orderDTO = toOrderDTO(order)
    broadcast("order_updated", { order: orderDTO })

    return res.json({
      success: true,
      orderId: order.orderId,
      status: order.status,
      updatedAt: order.updatedAt,
      readyAt: order.readyAt,
      completedAt: order.completedAt,
    })
  } catch (err) {
    console.error("[updateOrderStatus]", err)
    return res.status(500).json({ error: "Failed to update order status" })
  }
}

export async function markPaid(req, res) {
  try {
    const { orderId } = req.params
    const { paidVia, restaurantId } = req.body

    if (!restaurantId) {
      return res.status(400).json({ message: "restaurantId is required" })
    }

    const ALLOWED_PAID_VIA = ["pos_card", "cash"]
    if (!ALLOWED_PAID_VIA.includes(paidVia)) {
      return res.status(400).json({ message: "Invalid paidVia method" })
    }

    const order = await Order.findOne({ orderId, restaurantId })
    if (!order) return res.status(404).json({ message: "Order not found" })

    if (order.paymentStatus === "paid") {
      return res.status(400).json({ message: "Order is already paid" })
    }

    order.paymentStatus = "paid"
    order.paidVia = paidVia

    await order.save()

    const orderDTO = toOrderDTO(order)

    // Automatically send receipt if email is present and not sent yet
    // Do it asynchronously so we don't block the waiter frontend popup!
    if (order.receiptEmail && !order.receiptSent) {
      sendReceiptEmail(order, order.receiptEmail)
        .then(async (emailSent) => {
          if (emailSent) {
            order.receiptSent = true;
            await order.save();
          }
        })
        .catch((err) => {
          console.error("[markPaid] ❌ Error sending receipt in background:", err);
        });
    }

    // --- SSE SPLIT for Payment ---
    const foodItems = order.items.filter(i => i.type === "food")

    // Dynamic import to avoid circular dependency issues
    const { broadcast, broadcastToRole } = await import("../utils/sseManager.js")

    // 1. Send to Kitchen: Food Only
    if (foodItems.length > 0) {
      const kitchenDTO = { ...orderDTO, items: foodItems }
      // Send only to kitchen role
      broadcastToRole("kitchen", "order_updated", { order: kitchenDTO })
    }

    // 2. Send to Waiters & Tables: Full Order
    // We exclude 'kitchen' role from this broadcast to avoid duplicates/wrong data
    broadcast("order_updated", { order: orderDTO }, (client) => client.role !== "kitchen")

    return res.json({
      success: true,
      orderId: order.orderId,
      paymentStatus: order.paymentStatus,
      paidVia: order.paidVia,
    })
  } catch (err) {
    console.error("[markPaid] Error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}

export async function sendReceipt(req, res) {
  try {
    const { orderId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const order = await Order.findOne({ orderId }).lean();
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.receiptSent && order.receiptEmail === email) {
      return res.status(200).json({ message: "Receipt already sent to this email" });
    }

    const emailSent = await sendReceiptEmail(order, email);

    if (emailSent) {
      await Order.findOneAndUpdate(
        { orderId },
        { receiptSent: true, receiptEmail: email }
      );
      return res.status(200).json({ success: true, message: "Receipt sent successfully" });
    } else {
      return res.status(500).json({ success: false, message: "Failed to send receipt email" });
    }
  } catch (err) {
    console.error("Send receipt error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}

export async function saveReceiptEmail(req, res) {
  try {
    const { orderId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      // If the webhook hasn't fired yet, save the email to PendingCheckout
      const pending = await PendingCheckout.findOne({ orderId });
      if (pending) {
        pending.receiptEmail = email;
        await pending.save();
        return res.status(200).json({ success: true, message: "Receipt email saved for pending checkout successfully" });
      }
      return res.status(404).json({ message: "Order not found" });
    }

    order.receiptEmail = email;
    await order.save();

    return res.status(200).json({ success: true, message: "Receipt email saved successfully" });
  } catch (err) {
    console.error("Save receipt email error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}

