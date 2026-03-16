/**
 * Consistent Order DTO Builder
 * Ensures kitchen and waiter dashboards receive the exact same fields.
 */
export function toOrderDTO(orderDoc) {
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

    return {
        orderId: o.orderId,
        tableNumber: o.tableNumber,
        orderType: o.orderType || "dine-in",
        status: o.status,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        readyAt: o.readyAt,
        completedAt: o.completedAt,
        total: o.total || 0,
        currency: o.currency || "EUR",
        paymentChannel: o.paymentChannel || "offline",
        paymentStatus: o.paymentStatus || "unpaid",
        paidVia: o.paidVia || null,
        items: (o.items || []).map((it) => ({
            itemName: it.itemName,
            quantity: it.quantity,
            lineTotal: it.lineTotal || 0,
            type: it.type || "food",
            category: it.category || "food",
            notes: it.notes || "",
            allergies: it.allergies || [],
        })),
        // Aggregated fields for UI cards
        allergies: Array.from(allergiesSet),
        notes: firstNote,
    };
}
