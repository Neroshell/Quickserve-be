import Order from "../models/order.js"
import TableSession from "../models/TableSession.js"
import PendingCheckout from "../models/PendingCheckout.js"
import { generateOrderId } from "../utils/orderId.js"
import MenuItem from "../models/menuItem.js"
import { toOrderDTO } from "../utils/orderDTO.js"
import { publishEvent } from "../utils/sseManager.js"
import { sendReceiptEmail } from "../utils/emailService.js"
import ServicePoint from "../models/ServicePoint.js"
import Business from "../models/Business.js"
import { isBusinessOpen } from "../utils/operatingHours.js"

/** Resolve businessId from request — accepts businessId or legacy restaurantId */
function resolveBusinessId(req) {
  return (
    req.query.businessId ||
    req.query.restaurantId ||
    req.body?.businessId ||
    req.body?.restaurantId ||
    req.params?.businessId ||
    req.params?.restaurantId
  )
}

export async function listOrders(req, res) {
  try {
    const { sessionId, tableNumber } = req.query
    const businessId = resolveBusinessId(req)

    if (!businessId) {
      return res.status(400).json({ message: "businessId is required" })
    }

    const filter = { businessId }
    if (sessionId) filter.sessionId = sessionId
    if (tableNumber) filter.tableNumber = tableNumber

    if (!sessionId && !tableNumber) {
      return res.status(400).json({ message: "Provide sessionId or tableNumber" })
    }

    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean()
    
    // Hydrate table labels for service points
    for (const order of orders) {
      if (order.tableNumber && order.tableNumber.startsWith("sp_")) {
        const sp = await ServicePoint.findOne({ servicePointId: order.tableNumber, businessId }).lean()
        if (sp) {
          order.tableLabel = sp.label || sp.code
        }
      }
    }

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

    // Get businessId from req body — accept businessId or legacy restaurantId
    const businessId = resolveBusinessId(req) || process.env.NEXT_PUBLIC_RESTAURANT_ID || "default-restaurant-id"

    // ✅ CRITICAL GATE: Business Open/Closed logic
    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    }).lean()

    const openStatus = isBusinessOpen(business)
    if (!openStatus.isOpen) {
      return res.status(403).json({
        error: `We are closed now. You can't place orders. We will open ${openStatus.nextOpeningTime}.`
      })
    }

    // Resolve human-friendly label for display (stored once, no need to look up later)
    const sp = await ServicePoint.findOne({ servicePointId: tableNumber, businessId }).lean()
    const tableLabel = sp?.label || sp?.code || tableNumber
    const tableCode = sp?.code || sp?.label || tableNumber

    const now = new Date()
    const orderId = generateOrderId(tableCode, now)

    // Enrich items with category and unitPrice from DB (authoritative)
    let calculatedTotal = 0
    const enrichedItems = await Promise.all(
      items.map(async (item) => {
        const menuItem = await MenuItem.findOne({ name: item.itemName, businessId }).lean()
        // Authoritative from DB, fallback to provided price, else 0
        const unitPrice = menuItem?.price || item.unitPrice || 0
        const itemType = menuItem?.type || (item.orderCategory === "drinks" ? "drinks" : "food")
        const displayCategory = menuItem?.category || "mains"
        const itemImage = menuItem?.imageUrl || item.image || ""

        const itemLineTotal = Number((unitPrice * item.quantity).toFixed(2))
        calculatedTotal += itemLineTotal

        return {
          itemName: item.itemName,
          quantity: item.quantity,
          lineTotal: itemLineTotal,
          type: itemType,
          category: displayCategory,
          notes: item.notes || "",
          allergies: item.allergies || [],
          image: itemImage
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
      businessId,
      tableNumber,
      tableLabel,
      orderType: finalOrderType,
      sessionId,
      items: enrichedItems,
      status: initialStatus,
      total: finalTotal,
      currency: currency || "EUR",
      paymentChannel: paymentChannel || "offline",
      paymentStatus: paymentStatus || "unpaid",
      paidVia: paidVia || null,
      receiptEmail: receiptEmail || null,
    })

    const orderDTO = toOrderDTO(saved)

    // --- SSE via Redis pub/sub ---
    const foodItems = saved.items.filter(i => i.type === "food")
    const drinkItems = saved.items.filter(i => i.type === "drinks")

    // 1. Kitchen: food items only
    if (foodItems.length > 0) {
      const kitchenDTO = { ...orderDTO, items: foodItems }
      await publishEvent("order_created", businessId, ["kitchen"], { order: kitchenDTO })
    }

    // 2. Bar: drink items only
    if (drinkItems.length > 0) {
      const barDTO = { ...orderDTO, items: drinkItems }
      await publishEvent("order_created", businessId, ["bar"], { order: barDTO })
    }

    // 3. Waiter + table: full order
    await publishEvent("order_created", businessId, ["waiter", "table", "anon"], { order: orderDTO })

    return res.status(201).json({ orderId: saved.orderId, businessId: saved.businessId, status: saved.status })
  } catch (err) {
    console.error("Create order error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}


export async function getOrderById(req, res) {
  try {
    const { orderId } = req.params
    const businessId = resolveBusinessId(req)

    if (!businessId) {
      return res.status(400).json({ message: "businessId is required" })
    }

    const order = await Order.findOne({ orderId, businessId }).lean()
    if (!order) return res.status(404).json({ message: "Order not found" })

    // Hydrate display name
    if (order.tableNumber && order.tableNumber.startsWith("sp_")) {
      const sp = await ServicePoint.findOne({ servicePointId: order.tableNumber, businessId }).lean()
      if (sp) {
        order.tableLabel = sp.label || sp.code
      }
    }

    return res.json(order)
  } catch (err) {
    console.error("Get order error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}

export async function deleteOrdersBySession(req, res) {
  try {
    const businessId = req.body.businessId || req.body.restaurantId
    const { sessionId } = req.body

    if (!sessionId || !businessId) {
      return res.status(400).json({ message: "sessionId and businessId are required" })
    }

    const result = await Order.deleteMany({ sessionId, businessId })

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
    const { status: nextStatus } = req.body
    const businessId = resolveBusinessId(req)

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    const VALID_STATUSES = ["placed", "in_progress", "ready", "completed"]
    if (!VALID_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    const order = await Order.findOne({ orderId, businessId })
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
    await publishEvent("order_updated", order.businessId, null, { order: orderDTO })

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
    const { paidVia } = req.body
    const businessId = resolveBusinessId(req)

    if (!businessId) {
      return res.status(400).json({ message: "businessId is required" })
    }

    const ALLOWED_PAID_VIA = ["pos_card", "cash"]
    if (!ALLOWED_PAID_VIA.includes(paidVia)) {
      return res.status(400).json({ message: "Invalid paidVia method" })
    }

    const order = await Order.findOne({ orderId, businessId })
    if (!order) return res.status(404).json({ message: "Order not found" })

    if (order.paymentStatus === "paid") {
      return res.status(400).json({ message: "Order is already paid" })
    }

    // ✅ Step 1: Save payment — this must always succeed
    order.paymentStatus = "paid"
    order.paidVia = paidVia
    // Stamp which staff member confirmed this payment (waiter analytics)
    if (req.session?.user?.staffId) order.paidByStaffId = req.session.user.staffId
    if (req.session?.user?.name)    order.paidByName    = req.session.user.name
    await order.save()

    const orderDTO = toOrderDTO(order)

    // Broadcast via Redis — kitchen gets food-only, bar gets drinks-only, waiters get full order
    const foodItems2 = order.items.filter(i => i.type === "food")
    const drinkItems2 = order.items.filter(i => i.type === "drinks")
    
    if (foodItems2.length > 0) {
        const kitchenDTO = { ...orderDTO, items: foodItems2 }
        await publishEvent("order_updated", order.businessId, ["kitchen"], { order: kitchenDTO })
    }
    
    if (drinkItems2.length > 0) {
        const barDTO = { ...orderDTO, items: drinkItems2 }
        await publishEvent("order_updated", order.businessId, ["bar"], { order: barDTO })
    }

    await publishEvent("order_updated", order.businessId, ["waiter", "table", "anon"], { order: orderDTO, action: "payment_confirmed" })

    // ✅ Step 3: Respond immediately — do NOT wait for email

 if (order.receiptEmail && !order.receiptSent) {
      ;(async () => {
        try {
          const emailSent = await sendReceiptEmail(order, order.receiptEmail)
          if (emailSent) {
            order.receiptSent = true
            await order.save()
          } else {
            console.warn(`[markPaid] ⚠️ sendReceiptEmail returned false for order ${orderId} — email not sent`)
          }
        } catch (emailErr) {
          console.error(`[markPaid] ❌ Background receipt email failed for order ${orderId}:`, emailErr)
        }
      })()
    }

    res.json({
      success: true,
      orderId: order.orderId,
      paymentStatus: order.paymentStatus,
      paidVia: order.paidVia,
    })

    // ✅ Step 4: Fire-and-forget receipt email — runs AFTER response is sent
    // This will never block the HTTP response, even if SMTP hangs in production
   
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

