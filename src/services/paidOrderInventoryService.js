import PendingCheckout from "../models/PendingCheckout.js"
import Order from "../models/order.js"
import {
    ORDER_INVENTORY_AUTHORITIES,
    ORDER_INVENTORY_SEMANTICS,
} from "../constants/orderInventory.js"
import { withCanonicalInventoryTransaction } from "./canonicalInventoryService.js"
import { commitHeldInventoryReservation } from "./inventoryReservationService.js"
import { buildOrderInventoryDeductionLine } from "./orderInventorySemanticsService.js"
import { reconcileFrozenCheckoutFulfillment } from "./orderFulfillmentService.js"

function reservationSemantics(reservation) {
    const canonical = (reservation.components || []).length > 0
    const legacy = (reservation.legacyComponents || []).length > 0
    if (canonical && legacy) return ORDER_INVENTORY_SEMANTICS.MIXED_RESERVATION_V1
    if (canonical) return ORDER_INVENTORY_SEMANTICS.CANONICAL_RESERVATION_V1
    return ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1
}

function legacyAuthorityLines(reservation) {
    return (reservation.legacyComponents || []).map((component) =>
        buildOrderInventoryDeductionLine({
            menuItemId: component.menuItemId,
            authority: ORDER_INVENTORY_AUTHORITIES.LEGACY_MENU_ITEM,
            orderQuantity: component.quantity,
        }))
}

/**
 * Atomically creates/recovers the paid Order and commits the exact inventory
 * hold. This never resolves recipes again and never performs a second stock
 * availability check.
 */
export async function finalizePaidOrderWithInventory({
    businessId,
    pendingCheckoutId,
    inventoryReservationId,
    stripeSessionId,
    orderId,
    orderInput,
}, {
    PendingCheckoutModel = PendingCheckout,
    OrderModel = Order,
} = {}) {
    return withCanonicalInventoryTransaction(async (session) => {
        const pending = await PendingCheckoutModel.findOne({
            _id: pendingCheckoutId,
            businessId,
            inventoryReservationId,
        }, null, { session })
        if (!pending) {
            const error = new Error("PendingCheckout inventory state is missing")
            error.code = "PENDING_CHECKOUT_INVENTORY_STATE_MISSING"
            error.statusCode = 500
            throw error
        }
        if (pending.stripeSessionId && pending.stripeSessionId !== stripeSessionId) {
            const error = new Error("Stripe session does not match PendingCheckout")
            error.code = "STRIPE_SESSION_MISMATCH"
            error.statusCode = 409
            throw error
        }

        const committed = await commitHeldInventoryReservation({
            businessId,
            reservationId: inventoryReservationId,
            pendingCheckoutId,
            stripeSessionId,
            orderId,
            session,
        })
        const reservation = committed.reservation
        let order = await OrderModel.findOne({ businessId, orderId }, null, { session })
        let created = false
        if (!order) {
            ;[order] = await OrderModel.create([{
                ...orderInput,
                businessId,
                orderId,
                inventoryReservationId: reservation.reservationId,
                inventoryReserved: true,
                inventoryReservedAt: reservation.createdAt || reservation.committedAt || new Date(),
                inventorySemanticsVersion: reservationSemantics(reservation),
                inventoryDeductionLines: legacyAuthorityLines(reservation),
                inventoryDeducted: (reservation.legacyComponents || []).length > 0,
                inventoryDeductedAt: (reservation.legacyComponents || []).length > 0
                    ? reservation.createdAt || new Date()
                    : null,
            }], { session })
            created = true
        } else {
            if (order.inventoryReservationId && order.inventoryReservationId !== reservation.reservationId) {
                const error = new Error("Order is linked to another inventory reservation")
                error.code = "ORDER_INVENTORY_RESERVATION_CONFLICT"
                error.statusCode = 409
                throw error
            }
            const {
                createdAt: _ignoredCreatedAt,
                paidAt: requestedPaidAt,
                items: _ignoredItems,
                status: _ignoredStatus,
                ...replaySafeOrderInput
            } = orderInput
            reconcileFrozenCheckoutFulfillment(order, _ignoredItems)
            Object.assign(order, replaySafeOrderInput, {
                businessId,
                orderId,
                paidAt: order.paidAt || requestedPaidAt || new Date(),
                inventoryReservationId: reservation.reservationId,
                inventoryReserved: true,
                inventoryReservedAt: order.inventoryReservedAt || reservation.createdAt || new Date(),
                inventorySemanticsVersion: reservationSemantics(reservation),
                inventoryDeductionLines: legacyAuthorityLines(reservation),
                inventoryDeducted: (reservation.legacyComponents || []).length > 0,
                inventoryDeductedAt: (reservation.legacyComponents || []).length > 0
                    ? order.inventoryDeductedAt || reservation.createdAt || new Date()
                    : null,
            })
            await order.save({ session })
        }

        pending.stripeSessionId = stripeSessionId
        pending.status = "completed"
        await pending.save({ session })
        return {
            order,
            reservation,
            created,
            replayed: !created && committed.replayed,
        }
    })
}
