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
import Plan from "../models/Plan.js"
import { isBusinessOpen } from "../utils/operatingHours.js"
import { calculateOfflineCommission } from "../utils/platformFee.js"

function canUseOfflinePayments(business) {
  return business.billingStatus === "active" && !!business.defaultPaymentMethodId
}

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

    // Staff of this business may browse by table; customers may only ever see
    // their own device's orders (scoped by their unguessable sessionId).
    const isStaff = !!req.session?.user?.businessId && req.session.user.businessId === businessId

    const filter = { businessId }
    if (isStaff) {
      if (sessionId) filter.sessionId = sessionId
      if (tableNumber) filter.tableNumber = tableNumber
      if (!sessionId && !tableNumber) {
        return res.status(400).json({ message: "Provide sessionId or tableNumber" })
      }
    } else {
      if (!sessionId) {
        return res.status(400).json({ message: "sessionId is required" })
      }
      filter.sessionId = sessionId
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

    return res.json(orders.map(toOrderDTO))
  } catch (err) {
    console.error("List orders error:", err)
    return res.status(500).json({ message: "Server error" })

  }
}

export async function createOrder(req, res) {
  try {
    const {
      tableNumber, items, sessionId, tableSessionToken, orderType, currency,
      receiptEmail
    } = req.body

    // Payment state is NEVER trusted from the client. Orders created here are
    // always offline + unpaid; payment is confirmed later by staff (markPaid)
    // or, for online payments, exclusively by the Stripe webhook.

    const isWaiter = req.session?.user?.role === "waiter" || req.session?.user?.role === "owner" || req.session?.user?.role === "manager"

    if (!isWaiter && !sessionId) {
      return res.status(400).json({ message: "sessionId is required" })
    }
    if (!isWaiter && !tableSessionToken) {
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

    let businessId;

    if (!isWaiter) {
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

      // Bind token to first device sessionId ATOMICALLY
      if (!ts.boundSessionId) {
        const updatedTs = await TableSession.findOneAndUpdate(
          { _id: ts._id, boundSessionId: null },
          { $set: { boundSessionId: sessionId } },
          { new: true }
        )
        if (!updatedTs) {
          return res.status(403).json({ message: "This table session was just claimed by another device." })
        }
        ts.boundSessionId = sessionId
      } else if (ts.boundSessionId !== sessionId) {
        return res.status(403).json({ message: "This table session is already in use on another device." })
      }

      //  STRICT SECURITY: Override businessId explicitly from the validated TableSession
      // This prevents an attacker with a valid session at Restaurant A from injecting orders into Restaurant B.
      businessId = ts.businessId
    } else {
      businessId = req.session.user.businessId
      if (!businessId) {
         return res.status(403).json({ message: "Unauthorized: Missing businessId in session" })
      }
    }

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

    // ✅ Guard: Offline payment setup (this endpoint only ever creates offline orders)
    if (!canUseOfflinePayments(business)) {
      return res.status(403).json({
        code: "OFFLINE_BILLING_NOT_SETUP",
        message: "Offline payments are not available. This business has not completed billing setup."
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
        if (!menuItem) {
          throw new Error(`Menu item '${item.itemName}' is no longer available.`)
        }
        // Authoritative from DB, strictly ignoring client price
        const unitPrice = menuItem.price || 0
        const itemType = menuItem.type || (item.orderCategory === "drinks" ? "drinks" : "food")
        const displayCategory = menuItem.category || "mains"
        const itemImage = menuItem.imageUrl || item.image || ""

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

    // ✅ Backend-authoritative total calculation
    const subtotal = Number(calculatedTotal.toFixed(2))
    const taxRate = business.taxRate || 0
    const taxAmount = Number((subtotal * (taxRate / 100)).toFixed(2))

    // Platform fee: only when the owner has opted to pass it to the customer
    const totalInCentsForFee = Math.round(subtotal * 100)
    const { commissionAmountCents, commissionRateApplied, planApplied } = await calculateOfflineCommission(totalInCentsForFee, business.currentPlan || "basic")
    
    let platformFeeTotal = 0
    if (business.passPlatformFeeToCustomer) {
      platformFeeTotal = Number((subtotal * (commissionRateApplied / 100)).toFixed(2))
    }

    let finalCommissionAmountCents = commissionAmountCents
    if (business.passPlatformFeeToCustomer && platformFeeTotal > 0) {
      finalCommissionAmountCents = Math.round(platformFeeTotal * 100)
    }

    const finalTotal = Number((subtotal + taxAmount + platformFeeTotal).toFixed(2))

    const saved = await Order.create({
      orderId,
      businessId,
      tableNumber,
      tableLabel,
      orderType: finalOrderType,
      sessionId,
      items: enrichedItems,
      status: initialStatus,
      subtotal,
      taxAmount,
      platformFeeTotal,
      total: finalTotal,
      currency: currency || "EUR",
      paymentChannel: "offline",
      paymentStatus: "unpaid",
      paidVia: null,
      receiptEmail: receiptEmail || null,
      planApplied,
      commissionRateApplied,
      commissionAmountCents: finalCommissionAmountCents,
      orderSource: isWaiter ? "waitstaff" : "self",
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
    if (err.message && err.message.includes("is no longer available")) {
      return res.status(400).json({ error: err.message })
    }
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

    // Authorization: staff of this business, or the customer device that placed
    // the order (matched by its unguessable sessionId). Prevents IDOR on orderId.
    const isStaff = !!req.session?.user?.businessId && req.session.user.businessId === order.businessId
    const requesterSessionId = req.query.sessionId || req.body?.sessionId
    const isOwnerDevice = !!requesterSessionId && !!order.sessionId && requesterSessionId === order.sessionId
    if (!isStaff && !isOwnerDevice) {
      return res.status(403).json({ message: "Forbidden" })
    }

    // Hydrate display name (fallback for legacy orders missing tableLabel)
    if (order.tableNumber && order.tableNumber.startsWith("sp_")) {
      const sp = await ServicePoint.findOne({ servicePointId: order.tableNumber, businessId }).lean()
      if (sp) {
        order.tableLabel = sp.label || sp.code
      }
    }

    return res.json(toOrderDTO(order))
  } catch (err) {
    console.error("Get order error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}

export async function deleteOrdersBySession(req, res) {
  try {
    // Manager-only, destructive: businessId from session so one business can't
    // delete another's order records.
    const businessId = req.session?.user?.businessId
    const { sessionId } = req.body

    if (!businessId) {
      return res.status(401).json({ message: "Unauthorized" })
    }
    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" })
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
    // Staff-only action: businessId is taken from the authenticated session,
    // never from the request, so a staffer can't touch another business's orders.
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const VALID_STATUSES = ["placed", "in_progress", "ready", "completed"]
    if (!VALID_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    const order = await Order.findOne({ orderId, businessId }).lean()
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

    const updateObj = { status: nextStatus }
    if (nextStatus === "ready" && !order.readyAt) updateObj.readyAt = new Date()
    if (nextStatus === "completed" && !order.completedAt) updateObj.completedAt = new Date()

    // ✅ ATOMIC UPDATE: Prevent race conditions if two waiters click the button simultaneously
    const updatedOrder = await Order.findOneAndUpdate(
      { orderId, businessId, status: order.status },
      { $set: updateObj },
      { new: true }
    )

    if (!updatedOrder) {
      return res.status(409).json({ error: "Order status was updated by another request. Please refresh and try again." })
    }

    const orderDTO = toOrderDTO(updatedOrder)
    await publishEvent("order_updated", updatedOrder.businessId, null, { order: orderDTO })

    return res.json({
      success: true,
      orderId: updatedOrder.orderId,
      status: updatedOrder.status,
      updatedAt: updatedOrder.updatedAt,
      readyAt: updatedOrder.readyAt,
      completedAt: updatedOrder.completedAt,
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
    // Staff-only action: businessId is taken from the authenticated session,
    // never from the request, so a staffer can't mark another business's orders paid.
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    const ALLOWED_PAID_VIA = ["pos_card", "cash"]
    if (!ALLOWED_PAID_VIA.includes(paidVia)) {
      return res.status(400).json({ message: "Invalid paidVia method" })
    }

    const order = await Order.findOne({ orderId, businessId }).lean()
    if (!order) return res.status(404).json({ message: "Order not found" })

    if (order.paymentStatus === "paid") {
      return res.status(400).json({ message: "Order is already paid" })
    }

    const business = await Business.findOne({ $or: [{ businessId }, { restaurantId: businessId }] }).lean()
    if (!business || !canUseOfflinePayments(business)) {
      return res.status(403).json({
        code: "OFFLINE_BILLING_NOT_SETUP",
        message: "Offline payment confirmation is unavailable until billing setup is complete."
      })
    }

    // ✅ ATOMIC UPDATE: Prevent double mark-paid race condition
    const updateObj = {
      paymentStatus: "paid",
      paidVia
    }
    // Stamp which staff member confirmed this payment (waiter analytics)
    if (req.session?.user?.staffId) updateObj.paidByStaffId = req.session.user.staffId
    if (req.session?.user?.name) updateObj.paidByName = req.session.user.name

    // Lock commission rate if not already set (legacy order backfill)
    if (order.commissionRateApplied == null) {
      const totalInCentsForFee = Math.round((order.subtotal || 0) * 100)
      const { commissionAmountCents, commissionRateApplied, planApplied } = await calculateOfflineCommission(totalInCentsForFee, business.currentPlan || "basic")

      let finalCommissionAmountCents = commissionAmountCents
      if (order.platformFeeTotal > 0) {
        finalCommissionAmountCents = Math.round(order.platformFeeTotal * 100)
      }

      updateObj.planApplied = planApplied
      updateObj.commissionRateApplied = commissionRateApplied
      updateObj.commissionAmountCents = finalCommissionAmountCents
    }

    const updatedOrder = await Order.findOneAndUpdate(
      { orderId, businessId, paymentStatus: { $ne: "paid" } },
      { $set: updateObj },
      { new: true }
    )

    if (!updatedOrder) {
      return res.status(409).json({ message: "Order was already marked paid by another request." })
    }

    const orderDTO = toOrderDTO(updatedOrder)

    // Broadcast via Redis — kitchen gets food-only, bar gets drinks-only, waiters get full order
    const foodItems2 = updatedOrder.items.filter(i => i.type === "food")
    const drinkItems2 = updatedOrder.items.filter(i => i.type === "drinks")

    if (foodItems2.length > 0) {
      const kitchenDTO = { ...orderDTO, items: foodItems2 }
      await publishEvent("order_updated", updatedOrder.businessId, ["kitchen"], { order: kitchenDTO })
    }

    if (drinkItems2.length > 0) {
      const barDTO = { ...orderDTO, items: drinkItems2 }
      await publishEvent("order_updated", updatedOrder.businessId, ["bar"], { order: barDTO })
    }

    await publishEvent("order_updated", updatedOrder.businessId, ["waiter", "table", "anon"], { order: orderDTO, action: "payment_confirmed" })

    // ✅ Step 3: Respond immediately — do NOT wait for email

    if (updatedOrder.receiptEmail && !updatedOrder.receiptSent) {
      ; (async () => {
        try {
          const emailSent = await sendReceiptEmail(updatedOrder, updatedOrder.receiptEmail)
          if (emailSent) {
            await Order.findOneAndUpdate({ _id: updatedOrder._id }, { $set: { receiptSent: true } })
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

    // Staff-only action: scope the order to the authenticated staffer's business
    // so a receipt can't be triggered for another business's order, and the
    // order lookup can't be used to email arbitrary recipients across tenants.
    const businessId = req.session?.user?.businessId;
    if (!businessId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const order = await Order.findOne({ orderId, businessId }).lean();
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.receiptSent && order.receiptEmail === email) {
      return res.status(200).json({ message: "Receipt already sent to this email" });
    }

    const emailSent = await sendReceiptEmail(order, email);

    if (emailSent) {
      await Order.findOneAndUpdate(
        { orderId, businessId },
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
    const { email, sessionId } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }
    // Bind to the customer device that placed the order (or a staff session).
    // Prevents an attacker from setting a victim's receipt email on any order.
    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      // If the webhook hasn't fired yet, save the email to PendingCheckout
      const pending = await PendingCheckout.findOne({ orderId });
      if (pending) {
        if (pending.sessionId !== sessionId) {
          return res.status(403).json({ message: "Forbidden" });
        }
        pending.receiptEmail = email;
        await pending.save();
        return res.status(200).json({ success: true, message: "Receipt email saved for pending checkout successfully" });
      }
      return res.status(404).json({ message: "Order not found" });
    }

    const isStaff = !!req.session?.user?.businessId && req.session.user.businessId === order.businessId;
    if (!isStaff && order.sessionId !== sessionId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    order.receiptEmail = email;
    await order.save();

    return res.status(200).json({ success: true, message: "Receipt email saved successfully" });
  } catch (err) {
    console.error("Save receipt email error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}

