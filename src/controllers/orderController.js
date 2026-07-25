import Order from "../models/order.js"
import GuestSession from "../models/GuestSession.js"
import PendingCheckout from "../models/PendingCheckout.js"
import { generateOrderId } from "../utils/orderId.js"
import MenuItem from "../models/menuItem.js"
import { validateTrackedStock, deductTrackedStock } from "../services/inventoryService.js"
import { toOrderDTO } from "../utils/orderDTO.js"
import { publishEvent } from "../utils/sseManager.js"
import { sendReceiptEmail } from "../utils/emailService.js"
import ServicePoint from "../models/ServicePoint.js"
import Business from "../models/Business.js"
import Plan from "../models/Plan.js"
import { isBusinessOpen } from "../utils/operatingHours.js"
import { calculateOfflineCommission } from "../utils/platformFee.js"
import { normalizeTip } from "../utils/tips.js"
import CustomerConsent from "../models/CustomerConsent.js"
import { upsertGuestProfileFromOrder } from "../services/guestProfileService.js"
import { buildOrderEstimate, getItemPrepTimeMinutes } from "../utils/orderEstimate.js"

function canUseOfflinePayments(business) {
  return business.billingStatus === "active" && !!business.defaultPaymentMethodId
}

/** Resolve businessId from request — accepts businessId or legacy businessId */
function resolveBusinessId(req) {
  return (
    req.query.businessId ||
    req.body?.businessId ||
    req.params?.businessId
  )
}

export async function listOrders(req, res) {
  try {
    const { sessionId, servicePointLabel } = req.query
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
      if (servicePointLabel) filter.servicePointLabel = servicePointLabel
      if (!sessionId && !servicePointLabel) {
        return res.status(400).json({ message: "Provide sessionId or servicePointLabel" })
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
      if (order.servicePointLabel && order.servicePointLabel.startsWith("sp_")) {
        const sp = await ServicePoint.findOne({ servicePointId: order.servicePointLabel, businessId }).lean()
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
      servicePointLabel, items, sessionId, tableSessionToken, orderType, currency,
      receiptEmail, tipAmount, tipType, tipPercentage
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
    if (!servicePointLabel || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "servicePointLabel and items are required" })
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
      if (ts.tableId !== servicePointLabel) {
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
    const business = await Business.findOne({ businessId }).lean()

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
    const sp = await ServicePoint.findOne({ servicePointId: servicePointLabel, businessId }).lean()
    const displayLabel = sp?.label || sp?.code || servicePointLabel
    const tableCode = sp?.code || sp?.label || servicePointLabel

    const now = new Date()
    const orderId = generateOrderId(tableCode, now)

    // Pre-validate stock before calculating prices
    const stockFailures = await validateTrackedStock(items, businessId)
    if (stockFailures.length > 0) {
      return res.status(400).json({
        message: "Some items are no longer available in the requested quantity.",
        items: stockFailures,
      })
    }

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
          prepTimeMinutes: getItemPrepTimeMinutes(menuItem),
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

    // Platform fee calculation with split logic
    const totalInCentsForFee = Math.round(subtotal * 100)
    const { commissionAmountCents, commissionRateApplied, planApplied } = await calculateOfflineCommission(totalInCentsForFee, business.currentPlan || "basic")
    
    let mode = business.platformFeeMode || (business.passPlatformFeeToCustomer ? "customer_pays" : "business_absorbs");
    let percent = mode === "split" ? (business.customerPlatformFeePercent || 0) : (mode === "customer_pays" ? 100 : 0);

    const fullPlatformFeeFloat = Number((subtotal * (commissionRateApplied / 100)).toFixed(2));
    const fullPlatformFeeCents = Math.round(fullPlatformFeeFloat * 100);

    const customerPlatformFeeCents = Math.round(fullPlatformFeeCents * percent / 100);
    const customerPlatformFeeFloat = Number((customerPlatformFeeCents / 100).toFixed(2));
    const businessAbsorbedPlatformFeeCents = fullPlatformFeeCents - customerPlatformFeeCents;

    // We store the full fee as the commission amount
    const finalCommissionAmountCents = fullPlatformFeeCents;

    const tip = normalizeTip({
      tipsEnabled: business.settings?.tipsEnabled === true || business.tipsEnabled === true,
      subtotal,
      tipAmount,
      tipType,
      tipPercentage,
    })

    const finalTotal = Number((subtotal + taxAmount + customerPlatformFeeFloat + tip.tipAmount).toFixed(2))

    const estimate = buildOrderEstimate(enrichedItems, now)

    const saved = await Order.create({
      orderId,
      businessId,
      servicePointLabel,
      displayLabel,
      orderType: finalOrderType,
      sessionId,
      items: enrichedItems,
      status: initialStatus,
      estimatedPrepMinutes: estimate.estimatedPrepMinutes,
      estimatedReadyAt: estimate.estimatedReadyAt,
      subtotal,
      taxAmount,
      platformFeeTotal: customerPlatformFeeFloat,
      tipAmount: tip.tipAmount,
      tipType: tip.tipType,
      tipPercentage: tip.tipPercentage,
      platformFeeCents: fullPlatformFeeCents,
      customerPlatformFeeCents,
      businessAbsorbedPlatformFeeCents,
      platformFeeMode: mode,
      customerPlatformFeePercent: percent,
      total: finalTotal,
      currency: currency || "EUR",
      paymentChannel: "offline",
      paymentStatus: "unpaid",
      paidVia: null,
      receiptEmail: receiptEmail || null,
      planApplied,
      commissionRateApplied,
      commissionAmountCents: finalCommissionAmountCents,
      planAtOrder: planApplied,
      commissionRateAtOrder: commissionRateApplied,
      platformFeeRateAtOrder: commissionRateApplied,
      orderSource: isWaiter ? "waitstaff" : "self",
    })

    // --- Offline Inventory Deduction ---
    try {
      await deductTrackedStock(saved)
      saved.inventoryDeducted = true
      await saved.save()
    } catch (err) {
      console.error("[createOrder] Failed to deduct stock:", err)
      // We don't fail the order if deduction fails, we just don't mark it deducted.
    }

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

    // Authorization: staff of this business, or the customer device that placed
    // the order (matched by its unguessable sessionId). Prevents IDOR on orderId.
    const isStaff = !!req.session?.user?.businessId && req.session.user.businessId === order.businessId
    const requesterSessionId = req.query.sessionId || req.body?.sessionId
    const isOwnerDevice = !!requesterSessionId && !!order.sessionId && requesterSessionId === order.sessionId
    if (!isStaff && !isOwnerDevice) {
      return res.status(403).json({ message: "Forbidden" })
    }

    // Hydrate display name (fallback for legacy orders missing displayLabel)
    if (order.servicePointLabel && order.servicePointLabel.startsWith("sp_")) {
      const sp = await ServicePoint.findOne({ servicePointId: order.servicePointLabel, businessId }).lean()
      if (sp) {
        order.displayLabel = sp.label || sp.code
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

    if (order.paymentChannel !== "offline") {
      return res.status(400).json({ message: "Only offline orders can be marked paid by staff" })
    }

    if (order.status === "cancelled") {
      return res.status(400).json({ message: "Cancelled orders cannot be marked paid" })
    }

    if (!["pending", "unpaid"].includes(order.paymentStatus)) {
      return res.status(400).json({ message: "Only pending offline orders can be marked paid" })
    }

    const business = await Business.findOne({ $or: [{ businessId }, { businessId: businessId }] }).lean()
    if (!business || !canUseOfflinePayments(business)) {
      return res.status(403).json({
        code: "OFFLINE_BILLING_NOT_SETUP",
        message: "Offline payment confirmation is unavailable until billing setup is complete."
      })
    }

    // ✅ ATOMIC UPDATE: Prevent double mark-paid race condition
    const updateObj = {
      paymentStatus: "paid",
      paidVia,
      paidAt: new Date()
    }
    // Stamp which staff member confirmed this payment (waiter analytics)
    if (req.session?.user?.staffId) updateObj.paidByStaffId = req.session.user.staffId
    if (req.session?.user?.name) updateObj.paidByName = req.session.user.name

    // Lock commission rate if not already set (legacy order backfill)
    if (order.commissionRateApplied == null) {
      const totalInCentsForFee = Math.round((order.subtotal || 0) * 100)
      const { commissionAmountCents, commissionRateApplied, planApplied } = await calculateOfflineCommission(totalInCentsForFee, business.currentPlan || "basic")

      let finalCommissionAmountCents = commissionAmountCents
      if (order.platformFeeCents != null && order.platformFeeCents > 0) {
        finalCommissionAmountCents = order.platformFeeCents
      } else if (order.platformFeeTotal > 0) {
        finalCommissionAmountCents = Math.round(order.platformFeeTotal * 100)
      }

      updateObj.planApplied = planApplied
      updateObj.commissionRateApplied = commissionRateApplied
      updateObj.commissionAmountCents = finalCommissionAmountCents
    }

    const lockedPlan = updateObj.planApplied || order.planApplied || business.currentPlan || "basic"
    const lockedRate = updateObj.commissionRateApplied ?? order.commissionRateApplied ?? null
    if (!order.planAtOrder) updateObj.planAtOrder = lockedPlan
    if (order.commissionRateAtOrder == null) updateObj.commissionRateAtOrder = lockedRate
    if (order.platformFeeRateAtOrder == null) updateObj.platformFeeRateAtOrder = lockedRate

    const updatedOrder = await Order.findOneAndUpdate(
      { orderId, businessId, paymentChannel: "offline", status: { $ne: "cancelled" }, paymentStatus: { $ne: "paid" } },
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
          await sendReceiptEmail(updatedOrder, updatedOrder.receiptEmail)
          await Order.findOneAndUpdate({ _id: updatedOrder._id }, { $set: { receiptSent: true, receiptSentAt: new Date() } })
        } catch (emailErr) {
          console.error(`[markPaid] ❌ Background receipt email failed for order ${orderId}:`, emailErr)
        }
      })()
    }

    if (updatedOrder.receiptEmail) {
      upsertGuestProfileFromOrder({
        businessId: updatedOrder.businessId,
        order: updatedOrder,
        email: updatedOrder.receiptEmail
      });
    }

    res.json({
      success: true,
      orderId: order.orderId,
      paymentStatus: updatedOrder.paymentStatus,
      paidVia: updatedOrder.paidVia,
    })

    // ✅ Step 4: Fire-and-forget receipt email — runs AFTER response is sent
    // This will not block the HTTP response, even if SMTP hangs in production

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

    if (order.status === "cancelled") {
      return res.status(400).json({ message: "Cannot send receipt for a cancelled order." });
    }

    const emailSent = await sendReceiptEmail(order, email);

    if (emailSent) {
      await Order.updateOne(
        { businessId, orderId },
        { receiptSent: true, receiptSentAt: new Date(), receiptEmail: email }
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
    const { email, sessionId, marketingConsent } = req.body;

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

        if (marketingConsent !== undefined) {
          await CustomerConsent.findOneAndUpdate(
            { businessId: pending.businessId, email },
            { marketingConsent, orderId },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
        }

        upsertGuestProfileFromOrder({
          businessId: pending.businessId,
          order: pending,
          email,
          marketingConsent,
          trackVisit: false
        });

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

    if (marketingConsent !== undefined) {
      await CustomerConsent.findOneAndUpdate(
        { businessId: order.businessId, email },
        { marketingConsent, orderId },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    upsertGuestProfileFromOrder({
      businessId: order.businessId,
      order,
      email,
      marketingConsent,
      trackVisit: order.paymentStatus === "paid"
    });

    return res.status(200).json({ success: true, message: "Receipt email saved successfully" });
  } catch (err) {
    console.error("Save receipt email error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}

/**
 * PATCH /orders/:orderId/reconcile-complete
 *
 * Operational recovery - mark an order as completed without running through
 * the normal kitchen/bar workflow.  Intended for after-shift reconciliation
 * when a waiter forgot to tap "Complete" before ending their session.
 *
 * Rules:
 *   - Scoped to the authenticated user's business (session-derived).
 *   - Cancelled orders cannot be moved forward.
 *   - Already-completed orders are idempotent (returns 400 with a clear message).
 *   - Allowed source statuses: placed, in_progress, ready.
 *   - Sets completedAt if not already present.
 *   - Publishes SSE update so dashboards refresh.
 */
export async function reconcileComplete(req, res) {
  try {
    const { orderId } = req.params
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const ALLOWED_SOURCE_STATUSES = ["placed", "in_progress", "ready"]

    const order = await Order.findOne({ orderId, businessId }).lean()
    if (!order) {
      return res.status(404).json({ error: "Order not found" })
    }

    if (order.status === "cancelled") {
      return res.status(400).json({ error: "Cancelled orders cannot be marked as completed." })
    }

    if (order.status === "completed") {
      return res.status(400).json({ error: "Order is already completed." })
    }

    if (!ALLOWED_SOURCE_STATUSES.includes(order.status)) {
      return res.status(400).json({
        error: `Cannot complete an order with status '${order.status}'. Allowed: ${ALLOWED_SOURCE_STATUSES.join(", ")}.`,
      })
    }

    const completedAt = new Date()
    const updateObj = {
      status: "completed",
    }
    if (!order.completedAt) updateObj.completedAt = completedAt
    if (!order.servedAt) updateObj.servedAt = completedAt

    const staffId = req.session?.user?.staffId || req.session?.user?.id
    if (staffId) updateObj.servedByStaffId = staffId
    if (req.session?.user?.name) {
      updateObj.completedBy = req.session.user.name
      updateObj.servedByName = req.session.user.name
    }

    // ATOMIC UPDATE: guard against concurrent reconciliation attempts
    const updatedOrder = await Order.findOneAndUpdate(
      { orderId, businessId, status: { $in: ALLOWED_SOURCE_STATUSES } },
      { $set: updateObj },
      { new: true }
    )

    if (!updatedOrder) {
      return res.status(409).json({
        error: "Order status was changed by another request. Please refresh and try again.",
      })
    }

    const orderDTO = toOrderDTO(updatedOrder)

    // Broadcast to all relevant staff channels so dashboards update in real-time
    await publishEvent("order_updated", updatedOrder.businessId, ["waiter", "kitchen", "bar", "table", "anon"], {
      order: orderDTO,
      action: "reconcile_completed",
    })

    return res.json({
      success: true,
      orderId: updatedOrder.orderId,
      status: updatedOrder.status,
      completedAt: updatedOrder.completedAt,
    })
  } catch (err) {
    console.error("[reconcileComplete] Error:", err)
    return res.status(500).json({ error: "Failed to reconcile order" })
  }
}
