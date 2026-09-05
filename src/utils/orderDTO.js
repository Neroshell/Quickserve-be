import { FULFILLMENT_BEHAVIORS, FULFILLMENT_STATUSES } from "../constants/orderFulfillment.js"
import {
    getCustomerOrderProgress,
    resolveMenuItemFulfillment,
} from "../services/orderFulfillmentService.js"

/**
 * Consistent Order DTO Builder
 * Ensures kitchen and waiter dashboards receive the exact same fields.
 */
export function toOrderDTO(
    orderDoc,
    { includeFulfillment = false, customerProgressOptions = {} } = {},
) {
    // Use .toObject() if it's a Mongoose document, or lean it out
    const o = typeof orderDoc.toObject === 'function' ? orderDoc.toObject() : orderDoc;

    const allergiesSet = new Set();
    let firstNote = "";

    // Aggregate allergies and find the first non-empty note
    (o.items || []).forEach((item) => {
        if (Array.isArray(item.allergies)) {
            item.allergies.forEach((a) => {
                if (a && String(a).trim()) {
                    allergiesSet.add(String(a).trim());
                }
            });
        }
        if (!firstNote && item.notes && String(item.notes).trim()) {
            firstNote = String(item.notes).trim();
        }
    });

    const fulfillmentItems = (o.items || []).map((it) => {
        const resolved = resolveMenuItemFulfillment(it)
        const legacyStatus = ["ready", "completed"].includes(o.status)
            ? FULFILLMENT_STATUSES.READY
            : o.status === "in_progress" && resolved.behavior === FULFILLMENT_BEHAVIORS.PREPARED
                ? FULFILLMENT_STATUSES.IN_PROGRESS
                : FULFILLMENT_STATUSES.PENDING
        const item = {
            itemName: it.itemName,
            quantity: it.quantity,
            lineTotal: it.lineTotal || 0,
            prepTimeMinutes: it.prepTimeMinutes ?? null,
            type: it.type || "food",
            category: it.category || "food",
            notes: it.notes || "",
            allergies: it.allergies || [],
        }
        return {
            ...item,
            orderLineId: it.orderLineId || null,
            fulfillmentStation: it.fulfillmentStation || resolved.station,
            fulfillmentBehavior: it.fulfillmentBehavior || resolved.behavior,
            fulfillmentStatus: it.fulfillmentStatus || legacyStatus,
            fulfillmentStartedAt: it.fulfillmentStartedAt || null,
            fulfillmentStartedBy: it.fulfillmentStartedBy || null,
            fulfillmentReadyAt: it.fulfillmentReadyAt || null,
            fulfillmentReadyBy: it.fulfillmentReadyBy || null,
        }
    })
    const projectedItems = includeFulfillment
        ? fulfillmentItems
        : fulfillmentItems.map(({
            orderLineId,
            fulfillmentStation,
            fulfillmentBehavior,
            fulfillmentStatus,
            fulfillmentStartedAt,
            fulfillmentStartedBy,
            fulfillmentReadyAt,
            fulfillmentReadyBy,
            ...item
        }) => item)

    // A placed-state waiting message is only specific when it comes from the
    // frozen Order-line snapshot. Keep legacy inference for established
    // in-progress compatibility, but never use it to guess placed-state copy.
    const customerProgress = getCustomerOrderProgress({
        ...o,
        items: o.status === "placed" ? (o.items || []) : fulfillmentItems,
    }, customerProgressOptions)

    return {
        orderId: o.orderId,
        sessionId: o.sessionId,
         servicePointId: o.servicePointLabel, //
        servicePointLabel: o.servicePointLabel, // kept for internal reference only
        displayLabel: o.displayLabel || o.tableLabel || o.servicePointLabel, // display this — falls back to systemId for legacy orders
        orderType: o.orderType || "dine-in",
        status: o.status,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        readyAt: o.readyAt,
        completedAt: o.completedAt,
        estimatedPrepMinutes: o.estimatedPrepMinutes ?? null,
        estimatedReadyAt: o.estimatedReadyAt ?? null,
        subtotal: o.subtotal || 0,
        taxAmount: o.taxAmount || 0,
        platformFeeTotal: o.platformFeeTotal || 0,
        tipAmount: o.tipAmount || 0,
        tipType: o.tipType || null,
        tipPercentage: o.tipPercentage ?? null,
        total: o.total || 0,
        currency: o.currency || "EUR",
        paymentChannel: o.paymentChannel || "offline",
        paymentStatus: o.paymentStatus || "unpaid",
        paidVia: o.paidVia || null,
        completedBy: o.completedBy || null,
        items: projectedItems,
        customerProgress,
        customerStatusMessage: customerProgress.headline,
        // Aggregated fields for UI cards
        allergies: Array.from(allergiesSet),
        notes: firstNote,
        // Feedback tracking — needed by customer status page to avoid re-triggering the modal
        businessId: o.businessId || null,
        feedbackSubmitted: o.feedbackSubmitted || false,
    };
}
