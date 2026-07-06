import { DateTime } from "luxon"
import Order from "../models/order.js"
import MenuItem from "../models/menuItem.js"
import Business from "../models/Business.js"
import Plan from "../models/Plan.js"
import ServicePoint from "../models/ServicePoint.js"
import Staff from "../models/Staff.js"
import { generateOrderId } from "../utils/orderId.js"
import { toOrderDTO } from "../utils/orderDTO.js"
import { publishEvent } from "../utils/sseManager.js"
import { isBusinessOpen } from "../utils/operatingHours.js"
import { calculateOfflineCommission } from "../utils/platformFee.js"
import { validateTrackedStock, deductTrackedStock, restoreTrackedStock } from "../services/inventoryService.js"
import { buildOrderEstimate, getItemPrepTimeMinutes } from "../utils/orderEstimate.js"
import { normalizeTip } from "../utils/tips.js"

const BUSINESS_TZ = process.env.BUSINESS_TZ || "Europe/Malta"
const ROLLOVER_HOUR = Number(process.env.BUSINESS_DAY_ROLLOVER_HOUR || 2)

function getBusinessDayRange() {
    const now = DateTime.now().setZone(BUSINESS_TZ)
    const isBeforeRollover = now.hour < ROLLOVER_HOUR
    const baseDay = isBeforeRollover ? now.minus({ days: 1 }) : now

    const start = baseDay
        .startOf("day")
        .set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })

    const end = start.plus({ days: 1 })

    return {
        start,
        end,
        startJS: start.toJSDate(),
        endJS: end.toJSDate(),
        businessDay: start.toISODate(),
        generatedAt: now.toISO(),
    }
}

function escapeRegex(value = "") {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function getHistoryDateRange(range = "yesterday", from, to) {
    const { start: todayStart, end: todayEnd } = getBusinessDayRange()

    // Enforce upper bound: Past orders cannot include today's orders
    const maxEndJS = todayStart.toJSDate()

    switch (range) {
        case "today": // Fallback if someone manually passes 'today'
            return { startJS: todayStart.minus({ days: 1 }).toJSDate(), endJS: maxEndJS }
        case "yesterday":
            return { startJS: todayStart.minus({ days: 1 }).toJSDate(), endJS: maxEndJS }
        case "7days":
            return { startJS: todayStart.minus({ days: 7 }).toJSDate(), endJS: maxEndJS }
        case "thisMonth": {
            const monthStart = todayStart.startOf("month").set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })
            return { startJS: monthStart.toJSDate(), endJS: maxEndJS }
        }
        case "custom": {
            if (!from || !to) {
                const error = new Error("Missing 'from' or 'to' for custom range")
                error.statusCode = 400
                throw error
            }

            const customStart = DateTime.fromISO(String(from), { zone: BUSINESS_TZ }).set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 })
            const customEnd = DateTime.fromISO(String(to), { zone: BUSINESS_TZ }).set({ hour: ROLLOVER_HOUR, minute: 0, second: 0, millisecond: 0 }).plus({ days: 1 })

            if (!customStart.isValid || !customEnd.isValid) {
                const error = new Error("Invalid date format for custom range")
                error.statusCode = 400
                throw error
            }

            const actualEnd = customEnd > todayStart ? todayStart : customEnd
            const actualStart = customStart > actualEnd ? actualEnd : customStart

            return { startJS: actualStart.toJSDate(), endJS: actualEnd.toJSDate() }
        }
        default:
            return { startJS: todayStart.minus({ days: 1 }).toJSDate(), endJS: maxEndJS }
    }
}

function buildHistoryTimeline(order) {
    return [
        order.createdAt ? { label: "Created", at: order.createdAt } : null,
        order.readyAt ? { label: "Ready", at: order.readyAt } : null,
        order.completedAt ? { label: "Completed", at: order.completedAt } : null,
        order.servedAt ? { label: "Served", at: order.servedAt, by: order.servedByName || null } : null,
        order.paidAt ? { label: "Paid", at: order.paidAt, by: order.paidByName || null } : null,
        order.receiptSentAt ? { label: "Receipt sent", at: order.receiptSentAt } : null,
        order.cancelledAt ? { label: "Cancelled", at: order.cancelledAt } : null,
    ].filter(Boolean)
}

function normalizePaymentMethod(order) {
    if (order.paidVia === "cash") return "cash"
    if (order.paidVia === "pos_card") return "pos_card"
    if (order.paidVia === "online_card") return "online"
    return order.paymentChannel || "offline"
}

function getWaiterName(order, staffById) {
    return (
        order.servedByName ||
        order.paidByName ||
        order.completedBy ||
        staffById.get(order.servedByStaffId) ||
        staffById.get(order.paidByStaffId) ||
        staffById.get(order.createdByStaffId) ||
        ""
    )
}

export async function waiterPastOrders(req, res) {
    try {
        const businessId = req.session?.user?.businessId
        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        const {
            range = "today",
            from,
            to,
            status = "all",
            paymentStatus = "all",
            paymentMethod = "all",
            search = "",
        } = req.query

        const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1)
        const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "25"), 10) || 25))
        const skip = (page - 1) * limit
        const { startJS, endJS } = getHistoryDateRange(range, from, to)

        const filter = {
            businessId,
            createdAt: { $gte: startJS, $lt: endJS },
        }

        const allowedStatuses = ["placed", "in_progress", "ready", "completed", "cancelled"]
        if (status !== "all" && allowedStatuses.includes(status)) {
            filter.status = status
        } else {
            filter.status = { $in: allowedStatuses }
        }

        if (paymentStatus === "paid") {
            filter.paymentStatus = "paid"
        } else if (paymentStatus === "pending") {
            filter.paymentStatus = { $in: ["pending", "unpaid"] }
        }

        if (paymentMethod === "online") {
            filter.paymentChannel = "online"
        } else if (paymentMethod === "offline") {
            filter.paymentChannel = "offline"
        } else if (paymentMethod === "cash") {
            filter.paidVia = "cash"
        } else if (paymentMethod === "pos_card") {
            filter.paidVia = "pos_card"
        }

        const trimmedSearch = String(search || "").trim()
        if (trimmedSearch) {
            const searchRegex = new RegExp(escapeRegex(trimmedSearch), "i")
            const matchingStaff = await Staff.find(
                {
                    businessId,
                    name: { $regex: searchRegex },
                },
                { staffId: 1, waiterId: 1 }
            ).lean()

            const matchingStaffIds = matchingStaff
                .flatMap((staff) => [staff.staffId, staff.waiterId])
                .filter(Boolean)

            filter.$or = [
                { orderId: { $regex: searchRegex } },
                { receiptEmail: { $regex: searchRegex } },
                { crmEmail: { $regex: searchRegex } },
                { tableNumber: { $regex: searchRegex } },
                { tableLabel: { $regex: searchRegex } },
                { paidByName: { $regex: searchRegex } },
                { servedByName: { $regex: searchRegex } },
                { completedBy: { $regex: searchRegex } },
            ]

            if (matchingStaffIds.length > 0) {
                filter.$or.push(
                    { createdByStaffId: { $in: matchingStaffIds } },
                    { paidByStaffId: { $in: matchingStaffIds } },
                    { servedByStaffId: { $in: matchingStaffIds } }
                )
            }
        }

        const projection = {
            _id: 0,
            orderId: 1,
            businessId: 1,
            tableNumber: 1,
            tableLabel: 1,
            orderType: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            readyAt: 1,
            completedAt: 1,
            servedAt: 1,
            cancelledAt: 1,
            items: 1,
            subtotal: 1,
            taxAmount: 1,
            platformFeeTotal: 1,
            tipAmount: 1,
            tipType: 1,
            tipPercentage: 1,
            total: 1,
            currency: 1,
            paymentChannel: 1,
            paymentStatus: 1,
            paidVia: 1,
            paidAt: 1,
            receiptEmail: 1,
            receiptSent: 1,
            receiptSentAt: 1,
            crmEmail: 1,
            createdByStaffId: 1,
            completedBy: 1,
            paidByStaffId: 1,
            paidByName: 1,
            servedByStaffId: 1,
            servedByName: 1,
        }

        const [rawOrders, totalCount] = await Promise.all([
            Order.find(filter, projection)
                .sort({ createdAt: -1, updatedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Order.countDocuments(filter),
        ])

        const staffIds = Array.from(new Set(rawOrders.flatMap((order) => [
            order.createdByStaffId,
            order.paidByStaffId,
            order.servedByStaffId,
        ]).filter(Boolean)))

        const staffRows = staffIds.length > 0
            ? await Staff.find(
                {
                    businessId,
                    $or: [
                        { staffId: { $in: staffIds } },
                        { waiterId: { $in: staffIds } },
                    ],
                },
                { staffId: 1, waiterId: 1, name: 1 }
            ).lean()
            : []

        const staffById = new Map()
        for (const staff of staffRows) {
            if (staff.staffId) staffById.set(staff.staffId, staff.name)
            if (staff.waiterId) staffById.set(staff.waiterId, staff.name)
        }

        const orders = rawOrders.map((order) => ({
            orderId: order.orderId,
            businessId: order.businessId,
            tableNumber: order.tableNumber,
            tableLabel: order.tableLabel || order.tableNumber,
            servicePoint: order.tableLabel || order.tableNumber,
            orderType: order.orderType,
            status: order.status,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            readyAt: order.readyAt,
            completedAt: order.completedAt,
            servedAt: order.servedAt,
            cancelledAt: order.cancelledAt,
            customerEmail: order.receiptEmail || order.crmEmail || "",
            waiter: getWaiterName(order, staffById),
            paymentChannel: order.paymentChannel || "offline",
            paymentStatus: order.paymentStatus || "unpaid",
            paymentMethod: normalizePaymentMethod(order),
            paidVia: order.paidVia || null,
            paidAt: order.paidAt,
            receiptEmail: order.receiptEmail || "",
            receiptSent: Boolean(order.receiptSent),
            receiptSentAt: order.receiptSentAt,
            subtotal: order.subtotal || 0,
            taxAmount: order.taxAmount || 0,
            platformFeeTotal: order.platformFeeTotal || 0,
            tipAmount: order.tipAmount || 0,
            tipType: order.tipType || null,
            tipPercentage: order.tipPercentage ?? null,
            total: order.total || 0,
            currency: order.currency || "EUR",
            canMarkPaid: order.paymentChannel === "offline" && ["pending", "unpaid"].includes(order.paymentStatus) && order.status !== "cancelled",
            canMarkCompleted: ["placed", "in_progress", "ready"].includes(order.status),
            items: (order.items || []).map((item) => ({
                itemName: item.itemName,
                quantity: item.quantity,
                lineTotal: item.lineTotal || 0,
                notes: item.notes || "",
                allergies: item.allergies || [],
            })),
            timeline: buildHistoryTimeline(order),
        }))

        return res.json({
            orders,
            pagination: {
                page,
                limit,
                total: totalCount,
                totalPages: Math.max(1, Math.ceil(totalCount / limit)),
                hasNextPage: page * limit < totalCount,
                hasPreviousPage: page > 1,
            },
            filters: {
                range,
                from: startJS,
                to: endJS,
                status,
                paymentStatus,
                paymentMethod,
                search: trimmedSearch,
            },
        })
    } catch (err) {
        console.error("[waiterPastOrders]", err)
        return res.status(err.statusCode || 500).json({ error: err.message || "Failed to fetch waiter past orders" })
    }
}
// ✅ NEW: waiter can fetch ANY status (ready/placed/in_progress/completed/all)
// GET /waiter?status=ready
export async function waiterOrders(req, res) {
    try {
        const { startJS, endJS, businessDay, generatedAt } = getBusinessDayRange()

        const status = String(req.query.status || "ready")
        const businessId = req.session?.user?.businessId

        if (!businessId) {
            return res.status(401).json({ error: "Unauthorized" })
        }

        // Surface the waiter-ordering setting so the dashboard can show/hide the
        // "+ Take Order" button. Defaults to enabled when unset.
        const bizPrefs = await Business.findOne(
            { $or: [{ businessId }, { restaurantId: businessId }] },
            { "orderingPreferences.enableWaiterOrdering": 1 }
        ).lean()
        const enableWaiterOrdering = bizPrefs?.orderingPreferences?.enableWaiterOrdering !== false

        // ✅ Fetch all relevant statuses so FE can calculate counts for tabs
        // The FE sends ?status=... but relies on receiving ALL data to show badge counts
        const WAITER_STATUSES = ["placed", "in_progress", "ready", "completed"]

        const filter = {
            businessId,
            createdAt: { $gte: startJS, $lt: endJS },
            status: { $in: WAITER_STATUSES },
        }

        const rawOrders = await Order.find(
            filter,
            {
                _id: 0,
                orderId: 1,
                tableNumber: 1,
                tableLabel: 1,
                orderType: 1,
                status: 1,
                createdAt: 1,
                updatedAt: 1,
                readyAt: 1,
                items: 1,
                subtotal: 1,
                taxAmount: 1,
                platformFeeTotal: 1,
                tipAmount: 1,
                tipType: 1,
                tipPercentage: 1,
                total: 1,
                currency: 1,
                paymentChannel: 1,
                paymentStatus: 1,
                paidVia: 1,
            }
        )
            // ✅ show READY first if status=all, else normal ordering
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean()

        // ✅ counts for tabs (placed/in_progress/ready/completed)
        const countsAgg = await Order.aggregate([
            { $match: { businessId, createdAt: { $gte: startJS, $lt: endJS } } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
        ])

        const counts = { placed: 0, in_progress: 0, ready: 0, completed: 0 }
        for (const row of countsAgg) {
            if (row?._id && counts[row._id] !== undefined) counts[row._id] = row.count
        }

        // ✅ shape for FE
        const orders = rawOrders.map((o) => {
            const allergiesSet = new Set()
            let specialRequest = ""

            for (const it of o.items || []) {
                if (Array.isArray(it.allergies)) {
                    for (const a of it.allergies) {
                        if (a && String(a).trim()) allergiesSet.add(String(a).trim())
                    }
                }
                // grab first non-empty note
                if (!specialRequest && it.notes && String(it.notes).trim()) {
                    specialRequest = String(it.notes).trim()
                }
            }

            return {
                businessId: o.businessId,
                restaurantId: o.businessId, // legacy alias
                orderId: o.orderId,
                tableNumber: o.tableNumber,
                tableLabel: o.tableLabel || o.tableNumber,
                orderType: o.orderType,
                status: o.status,
                createdAt: o.createdAt,
                readyAt: o.readyAt,
                updatedAt: o.updatedAt,
                paymentChannel: o.paymentChannel,
                paymentStatus: o.paymentStatus,
                paidVia: o.paidVia,
                items: (o.items || []).map((it) => ({
                    itemName: it.itemName,
                    quantity: it.quantity,
                    lineTotal: it.lineTotal || 0,
                    notes: it.notes,
                    allergies: it.allergies
                })),
                allergies: Array.from(allergiesSet),
                notes: specialRequest,
                subtotal: o.subtotal || 0,
                taxAmount: o.taxAmount || 0,
                platformFeeTotal: o.platformFeeTotal || 0,
                tipAmount: o.tipAmount || 0,
                tipType: o.tipType || null,
                tipPercentage: o.tipPercentage ?? null,
                total: o.total,
                // subtotalCents: o.subtotalCents || 0,
                // taxCents: o.taxCents || 0,
                // totalCents: o.totalCents || 0,
                currency: o.currency || "EUR",
            }
        })

        // ✅ optional: if status=all, prioritize ready -> in_progress -> placed -> completed
        if (status === "all") {
            const rank = { ready: 1, in_progress: 2, placed: 3, completed: 4 }
            orders.sort((a, b) => (rank[a.status] || 99) - (rank[b.status] || 99))
        }

        return res.json({ businessDay, generatedAt, counts, orders, settings: { enableWaiterOrdering } })
    } catch (err) {
        console.error("[waiterOrders]", err)
        return res.status(500).json({ error: "Failed to fetch waiter orders" })
    }
}

// keep your ready endpoint if you still want it
export async function waiterReadyOrders(req, res) {
    req.query.status = "ready"
    return waiterOrders(req, res)
}

export async function createWaiterOrder(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    const staffId = req.session?.user?.staffId || req.session?.user?.id
    
    if (!businessId) {
      return res.status(403).json({ message: "Unauthorized: Missing businessId in session" })
    }

    const { tableNumber, items, orderType, currency, tipAmount, tipType, tipPercentage } = req.body

    if (!tableNumber || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "tableNumber and items are required" })
    }

    const allowedTypes = ["dine-in", "takeout"]
    const finalOrderType = orderType || "dine-in"

    if (!allowedTypes.includes(finalOrderType)) {
      return res.status(400).json({ message: `Invalid orderType. Use: ${allowedTypes.join(", ")}` })
    }

    // Verify service point belongs to this business
    const sp = await ServicePoint.findOne({ servicePointId: tableNumber, businessId }).lean()
    if (!sp) {
      return res.status(403).json({ message: "Invalid service point for this business." })
    }

    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    }).lean()

    if (!business) {
      return res.status(404).json({ success: false, message: "Business not found." })
    }

    // Enforce the waiter-assisted ordering setting on the server — hiding the
    // button on the client is not sufficient. Defaults to enabled when unset.
    if (business.orderingPreferences?.enableWaiterOrdering === false) {
      return res.status(403).json({
        success: false,
        message: "Waiter-assisted ordering is disabled for this business.",
      })
    }

    const openStatus = isBusinessOpen(business)
    if (!openStatus.isOpen) {
      return res.status(403).json({
        error: `Business is closed. Will open ${openStatus.nextOpeningTime}.`
      })
    }

    const tableLabel = sp.label || sp.code || tableNumber
    const tableCode = sp.code || sp.label || tableNumber

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

    let calculatedTotal = 0
    const enrichedItems = await Promise.all(
      items.map(async (item) => {
        const menuItem = await MenuItem.findOne({ name: item.itemName, businessId }).lean()
        if (!menuItem) {
          throw new Error(`Menu item '${item.itemName}' is no longer available.`)
        }
        
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

    const hasFood = enrichedItems.some(i => i.type === "food")
    const initialStatus = hasFood ? "placed" : "ready"

    const subtotal = Number(calculatedTotal.toFixed(2))
    const taxRate = business.taxRate || 0
    const taxAmount = Number((subtotal * (taxRate / 100)).toFixed(2))

    const totalInCentsForFee = Math.round(subtotal * 100)
    const { commissionAmountCents, commissionRateApplied, planApplied } = await calculateOfflineCommission(totalInCentsForFee, business.currentPlan || "basic")
    
    let mode = business.platformFeeMode || (business.passPlatformFeeToCustomer ? "customer_pays" : "business_absorbs");
    let percent = mode === "split" ? (business.customerPlatformFeePercent || 0) : (mode === "customer_pays" ? 100 : 0);

    const fullPlatformFeeFloat = Number((subtotal * (commissionRateApplied / 100)).toFixed(2));
    const fullPlatformFeeCents = Math.round(fullPlatformFeeFloat * 100);

    const customerPlatformFeeCents = Math.round(fullPlatformFeeCents * percent / 100);
    const customerPlatformFeeFloat = Number((customerPlatformFeeCents / 100).toFixed(2));
    const businessAbsorbedPlatformFeeCents = fullPlatformFeeCents - customerPlatformFeeCents;

    const finalCommissionAmountCents = fullPlatformFeeCents;

    const tip = normalizeTip({
      tipsEnabled: business.settings?.tipsEnabled === true,
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
      tableNumber,
      tableLabel,
      orderType: finalOrderType,
      sessionId: `waiter_${staffId}_${Date.now()}`,
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
      currency: currency || business.currency || "EUR",
      paymentChannel: "offline",
      paymentStatus: "unpaid",
      paidVia: null,
      planApplied,
      commissionRateApplied,
      commissionAmountCents: finalCommissionAmountCents,
      planAtOrder: planApplied,
      commissionRateAtOrder: commissionRateApplied,
      platformFeeRateAtOrder: commissionRateApplied,
      orderSource: "waitstaff",
      createdBy: "staff",
      createdByStaffId: staffId
    })

    // --- Offline Inventory Deduction ---
    try {
      await deductTrackedStock(saved)
      saved.inventoryDeducted = true
      await saved.save()
    } catch (err) {
      console.error("[createWaiterOrder] Failed to deduct stock:", err)
      // We don't fail the order if deduction fails, we just don't mark it deducted.
    }

    const orderDTO = toOrderDTO(saved)

    const foodItems = saved.items.filter(i => i.type === "food")
    const drinkItems = saved.items.filter(i => i.type === "drinks")

    if (foodItems.length > 0) {
      const kitchenDTO = { ...orderDTO, items: foodItems }
      await publishEvent("order_created", businessId, ["kitchen"], { order: kitchenDTO })
    }

    if (drinkItems.length > 0) {
      const barDTO = { ...orderDTO, items: drinkItems }
      await publishEvent("order_created", businessId, ["bar"], { order: barDTO })
    }

    await publishEvent("order_created", businessId, ["waiter", "table", "anon"], { order: orderDTO })

    return res.status(201).json({ orderId: saved.orderId, businessId: saved.businessId, status: saved.status })
  } catch (err) {
    console.error("Create waiter order error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}

export async function cancelWaiterOrder(req, res) {
  try {
    const businessId = req.session?.user?.businessId
    const staffId = req.session?.user?.staffId || req.session?.user?.id
    const { orderId } = req.params

    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const order = await Order.findOne({ orderId, businessId })
    if (!order) {
      return res.status(404).json({ error: "Order not found" })
    }

    if (order.paymentChannel !== "offline") {
      return res.status(400).json({ error: "Only offline orders can be cancelled directly by staff." })
    }

    if (order.status !== "placed") {
      return res.status(400).json({ error: "Order has already started preparation and cannot be cancelled." })
    }

    if (order.status === "cancelled") {
      return res.status(400).json({ error: "Order is already cancelled." })
    }

    order.status = "cancelled"
    order.cancelledAt = new Date()
    order.cancelledByStaffId = staffId

    // Restore inventory only if it was actually deducted
    if (order.inventoryDeducted && !order.inventoryRestored) {
      try {
        await restoreTrackedStock(order)
        order.inventoryRestored = true
        order.inventoryRestoredAt = new Date()
      } catch (err) {
        console.error(`[cancelWaiterOrder] Failed to restore inventory for order ${orderId}:`, err)
        // We still save the order as cancelled, even if inventory restore fails, 
        // to prevent blocking the business operation.
      }
    }

    await order.save()

    const orderDTO = toOrderDTO(order)
    await publishEvent("order_updated", businessId, ["waiter", "kitchen", "bar", "table"], { order: orderDTO })

    return res.json({ success: true, orderId: order.orderId, status: order.status })
  } catch (err) {
    console.error("[cancelWaiterOrder] Error:", err)
    return res.status(500).json({ message: "Server error" })
  }
}
