import Order from "../models/order.js"
import crypto from "node:crypto"
import GuestSession from "../models/GuestSession.js"
import PendingCheckout from "../models/PendingCheckout.js"
import { generateOrderId } from "../utils/orderId.js"
import MenuItem from "../models/menuItem.js"
import { toOrderDTO } from "../utils/orderDTO.js"
import {
  getOrderReceiptIdempotencyKey,
  sendReceiptEmail,
} from "../utils/emailService.js"
import ServicePoint from "../models/ServicePoint.js"
import Business from "../models/Business.js"
import Plan from "../models/Plan.js"
import { isBusinessOpen } from "../utils/operatingHours.js"
import { getCustomerProgressOptionsForBusiness } from "../utils/customerOrderTiming.js"
import { calculateOfflineCommission } from "../utils/platformFee.js"
import { normalizeTip } from "../utils/tips.js"
import CustomerConsent from "../models/CustomerConsent.js"
import {
  captureGuestLead,
  dispatchCrmOrder,
  getCrmOrderRevenueCents,
  recordCrmOrderIntent,
} from "../services/guestProfileService.js"
import {
  resolveOrStartCustomerJourney,
  recordOrderPlacementForJourney,
  recordOrderPaymentForJourney,
  linkJourneyToProfile,
} from "../services/customerJourneyService.js"
import { buildOrderEstimate, getItemPrepTimeMinutes } from "../utils/orderEstimate.js"
import {
  calculateOfflinePricing,
  getCustomerPricingBreakdown,
} from "../services/pricingService.js"
import { dispatchAutomaticOrderReceipt } from "../services/email/emailDispatchService.js"
import { invalidateSetupProgress } from "../services/cacheInvalidationService.js"
import { invalidateMenuItems } from "../services/cacheInvalidationService.js"
import { withCanonicalInventoryTransaction } from "../services/canonicalInventoryService.js"
import {
  buildInventoryRequestFingerprint,
  reserveInventoryForSource,
  validateInventoryRequirements,
} from "../services/inventoryReservationService.js"
import {
  INVENTORY_RESERVATION_SOURCE_TYPES,
  INVENTORY_RESERVATION_STATUSES,
} from "../constants/inventoryReservation.js"
import {
  completeOrderForWaitstaff,
  createOrderLineFulfillmentSnapshot,
} from "../services/orderFulfillmentService.js"
import { publishOrderRealtime } from "../services/orderRealtimeService.js"
// Restaurant-flow defect safeguards for direct/offline orders:
// validate and normalize the cart, enforce business ordering/payment settings,
// and derive currency from the business instead of accepting client values.
import {
  getBusinessCurrency,
  getOrderItemsValidationError,
  isBusinessServable,
  isOfflinePaymentMethodEnabled,
  isOrderTypeEnabled,
  isPaymentChannelEnabled,
  normalizeOrderItems,
} from "../utils/restaurantOrderValidation.js"

function canUseOfflinePayments(business) {
  return (
    business.billingStatus === "active" &&
    !!business.defaultPaymentMethodId &&
    isPaymentChannelEnabled(business, "offline")
  )
}

/** Resolve businessId from request — accepts businessId or legacy businessId */
function resolveBusinessId(req) {
  return (
    req.query.businessId ||
    req.body?.businessId ||
    req.params?.businessId
  )
}

function getRequestIdempotencyKey(req, fallback) {
  const supplied = req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"]
  const normalized = String(supplied || "").trim()
  if (normalized && normalized.length <= 160) return `order:${normalized}`
  return `order:${fallback || crypto.randomUUID()}`
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

    const [orders, business] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).lean(),
      Business.findOne({ businessId }).lean(),
    ])
    const customerProgressOptions = getCustomerProgressOptionsForBusiness(business)

    // Hydrate table labels for service points
    for (const order of orders) {
      if (order.servicePointLabel && order.servicePointLabel.startsWith("sp_")) {
        const sp = await ServicePoint.findOne({ servicePointId: order.servicePointLabel, businessId }).lean()
        if (sp) {
          order.tableLabel = sp.label || sp.code
        }
      }
    }

    return res.json(orders.map((order) => toOrderDTO(order, { customerProgressOptions })))
  } catch (err) {
    console.error("List orders error:", err)
    return res.status(500).json({ message: "Server error" })

  }
}

export async function createOrder(req, res) {
  try {
    const {
      servicePointLabel, items, sessionId, tableSessionToken, orderType,
      receiptEmail, tipAmount, tipType, tipPercentage, journeyId
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
    const itemValidationError = getOrderItemsValidationError(items)
    if (itemValidationError) {
      return res.status(400).json({ message: itemValidationError })
    }
    const normalizedItems = normalizeOrderItems(items)

    // ✅ Minimal validation for orderType
    const allowedTypes = ["dine-in", "takeout"]
    const finalOrderType = orderType || "dine-in"

    if (!allowedTypes.includes(finalOrderType)) {
      return res.status(400).json({ message: `Invalid orderType. Use: ${allowedTypes.join(", ")}` })
    }

    let businessId;

    if (!isWaiter) {
      // Validate token
      const ts = await GuestSession.findOne({ token: tableSessionToken })
      if (!ts) {
        return res.status(403).json({ message: "Invalid or expired table session. Please rescan the QR code." })
      }

      // Expiry check
      if (ts.expiresAt.getTime() < Date.now()) {
        return res.status(403).json({ message: "Session expired. Please rescan the QR code." })
      }

      // Table must match
      if (ts.servicePointId !== servicePointLabel) {
        return res.status(403).json({ message: "Table session mismatch. Please rescan the correct table QR." })
      }

      // Bind token to first device sessionId ATOMICALLY
      if (!ts.boundSessionId) {
        const updatedTs = await GuestSession.findOneAndUpdate(
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

      // STRICT SECURITY: derive businessId from the validated GuestSession.
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
    if (!isBusinessServable(business)) {
      return res.status(404).json({ message: "Business not found or inactive" })
    }

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
    if (!isOrderTypeEnabled(business, finalOrderType)) {
      return res.status(403).json({
        message: `${finalOrderType === "takeout" ? "Takeout" : "Dine-in"} ordering is disabled for this business.`,
      })
    }

    // Resolve human-friendly label for display (stored once, no need to look up later)
    const sp = await ServicePoint.findOne({ servicePointId: servicePointLabel, businessId }).lean()
    if (!sp || sp.isActive === false) {
      return res.status(400).json({
        message: "This ServicePoint is not active for the selected business.",
      })
    }
    const displayLabel = sp?.label || sp?.code || servicePointLabel
    const tableCode = sp?.code || sp?.label || servicePointLabel

    const now = new Date()
    const orderId = generateOrderId(tableCode, now)

    // Enrich items with category and unitPrice from DB (authoritative)
    let calculatedTotal = 0
    const enrichedItems = []
    for (const item of normalizedItems) {
      const menuItem = await MenuItem.findOne({ name: item.itemName, businessId, archivedAt: null }).lean()
      if (!menuItem) {
        return res.status(400).json({
          message: `Menu item '${item.itemName}' was not found.`,
        })
      }

      // Authoritative from DB, strictly ignoring client price
      const unitPrice = menuItem.price || 0
      const itemType = menuItem.type || (item.orderCategory === "drinks" ? "drinks" : "food")
      const displayCategory = menuItem.category || "mains"
      const itemImage = menuItem.imageUrl || item.image || ""

      const itemLineTotal = Number((unitPrice * item.quantity).toFixed(2))
      calculatedTotal += itemLineTotal

      enrichedItems.push({
        ...createOrderLineFulfillmentSnapshot(menuItem),
        menuItemId: menuItem._id,
        itemName: item.itemName,
        quantity: item.quantity,
        lineTotal: itemLineTotal,
        prepTimeMinutes: getItemPrepTimeMinutes(menuItem),
        type: itemType,
        category: displayCategory,
        notes: item.notes || "",
        allergies: item.allergies || [],
        image: itemImage
      })
    }

    const stockFailures = await validateInventoryRequirements({
      businessId,
      items: enrichedItems,
    })
    if (stockFailures.length > 0) {
      return res.status(409).json({
        code: "INSUFFICIENT_STOCK",
        message: "One or more items in your order are no longer available. Please review your cart.",
        items: stockFailures,
      })
    }

    // ✅ Backend-authoritative total calculation
    const subtotal = Number(calculatedTotal.toFixed(2))
    const totalInCentsForFee = Math.round(subtotal * 100)
    const tip = normalizeTip({
      tipsEnabled: business.settings?.tipsEnabled === true || business.tipsEnabled === true,
      subtotal,
      tipAmount,
      tipType,
      tipPercentage,
    })
    const pricing = await calculateOfflinePricing({
      subtotalCents: totalInCentsForFee,
      business,
      tipAmountCents: Math.round(tip.tipAmount * 100),
    })
    const {
      taxAmount,
      platformFeeMode: mode,
      customerPlatformFeePercent: percent,
      platformFeeCents: fullPlatformFeeCents,
      customerPlatformFeeCents,
      customerPlatformFeeAmount: customerPlatformFeeFloat,
      businessAbsorbedPlatformFeeCents,
      commissionRateApplied,
      planApplied,
      commissionAmountCents: finalCommissionAmountCents,
    } = pricing

    const finalTotal = pricing.total

    const estimate = buildOrderEstimate(enrichedItems, now)

    // Resolve or start canonical CustomerJourney
    const journey = await resolveOrStartCustomerJourney({
      businessId,
      journeyId: journeyId || null,
      tableSessionToken,
      sessionId,
      servicePointId: sp.servicePointId,
      orderType: finalOrderType,
      now,
    })
    const resolvedJourneyId = journey?.journeyId || null

    const creationIdempotencyKey = getRequestIdempotencyKey(req, orderId)
    const creationRequestFingerprint = buildInventoryRequestFingerprint({
      businessId,
      servicePointLabel,
      orderType: finalOrderType,
      sessionId,
      items: enrichedItems.map(({ menuItemId, quantity, notes, allergies }) => ({
        menuItemId: String(menuItemId),
        quantity,
        notes,
        allergies,
      })),
      subtotal,
      taxAmount,
      total: finalTotal,
      tip,
      paymentChannel: "offline",
    })
    const orderInput = {
      orderId,
      businessId,
      servicePointLabel,
      displayLabel,
      orderType: finalOrderType,
      sessionId,
      items: enrichedItems,
      status: "placed",
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
      currency: getBusinessCurrency(business),
      paymentChannel: "offline",
      paymentStatus: "unpaid",
      paidVia: null,
      receiptEmail: receiptEmail || null,
      journeyId: resolvedJourneyId,
      planApplied,
      commissionRateApplied,
      commissionAmountCents: finalCommissionAmountCents,
      planAtOrder: planApplied,
      commissionRateAtOrder: commissionRateApplied,
      platformFeeRateAtOrder: commissionRateApplied,
      orderSource: isWaiter ? "waitstaff" : "self",
      creationIdempotencyKey,
      creationRequestFingerprint,
    }

    // The order record, every stock mutation, every movement, and the immutable
    // restoration linkage commit together. A losing stock race creates no order.
    let replayed = false
    let saved
    try {
      saved = await withCanonicalInventoryTransaction(async (session) => {
        const existing = await Order.findOne({
          businessId,
          creationIdempotencyKey,
        }, null, { session })
        if (existing) {
          if (existing.creationRequestFingerprint !== creationRequestFingerprint) {
            const error = new Error("Idempotency-Key was already used for another order")
            error.code = "ORDER_IDEMPOTENCY_CONFLICT"
            error.statusCode = 409
            throw error
          }
          replayed = true
          return existing
        }

        const [created] = await Order.create([orderInput], { session })
        await reserveInventoryForSource({
          businessId,
          items: enrichedItems,
          sourceType: isWaiter
            ? INVENTORY_RESERVATION_SOURCE_TYPES.WAITSTAFF_ORDER
            : INVENTORY_RESERVATION_SOURCE_TYPES.OFFLINE_ORDER,
          sourceId: orderId,
          order: created,
          orderId,
          status: INVENTORY_RESERVATION_STATUSES.COMMITTED,
          idempotencyKey: `inventory:${creationIdempotencyKey}`,
          requestFingerprint: creationRequestFingerprint,
          actor: (() => {
            if (!isWaiter) return null
            const staffId = req.session?.user?.staffId || req.session?.user?.id
            if (!staffId) return null  // fall back to SYSTEM_INVENTORY_ACTOR in the service
            return {
              staffId,
              role: req.session?.user?.role || "staff",
              name: req.session?.user?.name || "Staff",
            }
          })(),
          session,
        })
        return Order.findOne({ businessId, orderId }, null, { session })
      })
    } catch (error) {
      if (error?.code !== 11000) throw error
      const existing = await Order.findOne({ businessId, creationIdempotencyKey })
      if (!existing || existing.creationRequestFingerprint !== creationRequestFingerprint) throw error
      replayed = true
      saved = existing
    }
    if (!replayed && (saved.inventoryReservationId || saved.inventoryDeducted)) {
      await invalidateMenuItems(businessId)
    }

    if (!replayed && saved.journeyId) {
      await recordOrderPlacementForJourney({
        businessId: saved.businessId,
        journeyId: saved.journeyId,
        orderId: saved.orderId,
        createdAt: saved.createdAt,
      })
    }

    if (!replayed) await invalidateSetupProgress(businessId)

    if (!replayed) await publishOrderRealtime("order_created", saved)

    return res.status(replayed ? 200 : 201).json({
      orderId: saved.orderId,
      businessId: saved.businessId,
      status: saved.status,
      journeyId: saved.journeyId || null,
      replayed,
      pricing: {
        ...getCustomerPricingBreakdown(pricing),
        tipAmount: tip.tipAmount,
        tipAmountCents: Math.round(tip.tipAmount * 100),
        currency: getBusinessCurrency(business),
      },
    })
  } catch (err) {
    console.error("Create order error:", err)
    if (err?.statusCode) {
      return res.status(err.statusCode).json({
        message: err.message,
        code: err.code,
        ...(Array.isArray(err.failures) && err.failures.length > 0
          ? { items: err.failures }
          : {}),
      })
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

    // Hydrate display name (fallback for legacy orders missing displayLabel)
    if (order.servicePointLabel && order.servicePointLabel.startsWith("sp_")) {
      const sp = await ServicePoint.findOne({ servicePointId: order.servicePointLabel, businessId }).lean()
      if (sp) {
        order.displayLabel = sp.label || sp.code
      }
    }

    const business = await Business.findOne({ businessId }).lean()
    return res.json(toOrderDTO(order, {
      customerProgressOptions: getCustomerProgressOptionsForBusiness(business),
    }))
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

    if (result.deletedCount > 0) {
      await invalidateSetupProgress(businessId)
    }

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

    if (nextStatus !== "completed") {
      return res.status(400).json({
        error: "Kitchen and Bar actions derive order progress; waitstaff may only mark a ready order served.",
      })
    }
    {
      const completion = await completeOrderForWaitstaff({
        businessId,
        orderId,
        actor: req.session.user,
      })
      const completedOrder = completion.order
      if (completion.changed) {
        await publishOrderRealtime("order_updated", completedOrder, {
          action: "served",
          customerNotification: completion.customerNotification,
        })
      }
      return res.json({
        success: true,
        orderId: completedOrder.orderId,
        status: completedOrder.status,
        updatedAt: completedOrder.updatedAt,
        readyAt: completedOrder.readyAt,
        completedAt: completedOrder.completedAt,
        replayed: completion.replayed,
      })
    }

  } catch (err) {
    console.error("[updateOrderStatus]", err)
    if (Number.isInteger(err?.statusCode)) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code })
    }
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
      return res.json({
        success: true,
        alreadyPaid: true,
        orderId: order.orderId,
        paymentStatus: order.paymentStatus,
        paidVia: order.paidVia,
      })
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
    if (!isOfflinePaymentMethodEnabled(business, paidVia)) {
      return res.status(403).json({
        message: `${paidVia === "cash" ? "Cash" : "POS card"} payments are disabled for this business.`,
      })
    }

    // ✅ ATOMIC UPDATE: Prevent double mark-paid race condition
    const updateObj = {
      paymentStatus: "paid",
      paidVia,
      paidAt: new Date()
    }
    if (order.receiptEmail) {
      updateObj.crmEmail = order.receiptEmail.toLowerCase().trim()
      updateObj.crmProcessingStatus = "pending"
      updateObj.crmProcessingRetryable = true
      updateObj.crmProcessingLastError = null
      updateObj.crmProcessingFailedAt = null
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

    if (updatedOrder.journeyId) {
      await recordOrderPaymentForJourney({
        businessId: updatedOrder.businessId,
        journeyId: updatedOrder.journeyId,
        orderId: updatedOrder.orderId,
        spendCents: getCrmOrderRevenueCents(updatedOrder),
        paidAt: updatedOrder.paidAt || new Date(),
      })
    }

    await publishOrderRealtime("order_updated", updatedOrder, { action: "payment_confirmed" })

    // ✅ Step 3: Respond immediately — do NOT wait for email

    if (updatedOrder.receiptEmail && !updatedOrder.receiptSent) {
      await dispatchAutomaticOrderReceipt({
        businessId: updatedOrder.businessId,
        orderId: updatedOrder.orderId,
        waitForDirect: false,
        directSend: async () => {
          const emailSent = await sendReceiptEmail(
            updatedOrder,
            updatedOrder.receiptEmail,
            { idempotencyKey: getOrderReceiptIdempotencyKey(updatedOrder) },
          )
          if (emailSent) {
            await Order.findOneAndUpdate(
              { _id: updatedOrder._id, businessId: updatedOrder.businessId },
              { $set: { receiptSent: true, receiptSentAt: new Date() } },
            )
          } else {
            console.error(`[markPaid] Receipt provider did not accept order ${orderId}`)
          }
          return emailSent
        },
      })
    }

    if (updatedOrder.receiptEmail) {
      void dispatchCrmOrder({
        businessId: updatedOrder.businessId,
        orderId: updatedOrder.orderId,
      })
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

        await captureGuestLead({
          businessId: pending.businessId,
          email,
          marketingConsent,
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

    let receiptAttempted = false;
    let receiptDelivered = Boolean(order.receiptSentAt || order.receiptSent);
    if (
      order.paymentChannel === "online" &&
      order.paymentStatus === "paid" &&
      !receiptDelivered
    ) {
      receiptAttempted = true;
      receiptDelivered = await sendReceiptEmail(order, email, {
        idempotencyKey: getOrderReceiptIdempotencyKey(order),
      });
      if (receiptDelivered) {
        order.receiptSent = true;
        order.receiptSentAt = new Date();
        await order.save();
      }
    }

    if (marketingConsent !== undefined) {
      await CustomerConsent.findOneAndUpdate(
        { businessId: order.businessId, email },
        { marketingConsent, orderId },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const lead = await captureGuestLead({
      businessId: order.businessId,
      email,
      marketingConsent,
    })

    if (order.journeyId && lead?._id) {
      await linkJourneyToProfile({
        businessId: order.businessId,
        journeyId: order.journeyId,
        guestProfileId: lead._id,
      })
    }

    if (order.paymentStatus === "paid") {
      try {
        const intent = await recordCrmOrderIntent({
          businessId: order.businessId,
          orderId: order.orderId,
          email,
        })
        if (intent.recorded) {
          void dispatchCrmOrder({
            businessId: order.businessId,
            orderId: order.orderId,
          })
        }
      } catch (crmError) {
        console.error("[saveReceiptEmail] CRM intent recording failed", {
          businessId: order.businessId,
          orderId: order.orderId,
          reason: crmError?.code || crmError?.name || "crm_intent_failed",
        })
      }
    }

    if (receiptAttempted && !receiptDelivered) {
      return res.status(502).json({
        success: false,
        message: "Receipt email was saved, but the provider did not accept the message. Please try again.",
      });
    }

    return res.status(200).json({
      success: true,
      receiptSent: receiptDelivered,
      message: receiptDelivered
        ? "Receipt email saved and receipt sent successfully"
        : "Receipt email saved successfully",
    });
  } catch (err) {
    console.error("Save receipt email error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}

/**
 * PATCH /orders/:orderId/reconcile-complete
 *
 * Operational recovery for a ready order whose final waitstaff handoff was
 * missed. It cannot bypass canonical Kitchen/Bar line readiness.
 *
 * Rules:
 *   - Scoped to the authenticated user's business (session-derived).
 *   - Cancelled orders cannot be moved forward.
 *   - Already-completed retries are idempotent.
 *   - Every frozen order line must already be ready.
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

    {
      const completion = await completeOrderForWaitstaff({
        businessId,
        orderId,
        actor: req.session.user,
      })
      if (completion.changed) {
        await publishOrderRealtime("order_updated", completion.order, {
          action: "reconcile_completed",
          customerNotification: completion.customerNotification,
        })
      }
      return res.json({
        success: true,
        orderId: completion.order.orderId,
        status: completion.order.status,
        completedAt: completion.order.completedAt,
        replayed: completion.replayed,
      })
    }

  } catch (err) {
    console.error("[reconcileComplete] Error:", err)
    if (Number.isInteger(err?.statusCode)) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code })
    }
    return res.status(500).json({ error: "Failed to reconcile order" })
  }
}
