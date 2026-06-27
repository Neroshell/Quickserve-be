import MenuItem from "../models/menuItem.js";
import Order from "../models/order.js";

/**
 * Validates that requested items have enough stock.
 * Returns an array of failures — empty array means all items are available.
 * Never throws; callers are responsible for returning 400 if failures exist.
 */
export async function validateTrackedStock(items, businessId) {
    const failures = [];

    for (const item of items) {
        const query = item.menuItemId
            ? { _id: item.menuItemId, businessId }
            : { name: item.itemName, businessId };

        const menuItem = await MenuItem.findOne(query).lean();

        if (menuItem && menuItem.trackStock && menuItem.stockQuantity != null) {
            if (menuItem.stockQuantity < item.quantity) {
                failures.push({
                    menuItemId: menuItem._id,
                    itemName:   menuItem.name,
                    requested:  item.quantity,
                    available:  menuItem.stockQuantity,
                });
            }
        }
    }

    return failures;
}


/**
 * Deducts stock for tracked items in an order.
 * Automatically marks items as sold out if stock hits 0.
 */
export async function deductTrackedStock(order) {
    try {
        let itemsDeductedCount = 0;
        
        for (const item of order.items) {
            const matchQuery = item.menuItemId
                ? { _id: item.menuItemId, businessId: order.businessId, trackStock: true, stockQuantity: { $gte: item.quantity } }
                : { name: item.itemName, businessId: order.businessId, trackStock: true, stockQuantity: { $gte: item.quantity } };

            const updated = await MenuItem.findOneAndUpdate(
                matchQuery,
                { $inc: { stockQuantity: -item.quantity } },
                { new: true }
            );

            if (updated) {
                itemsDeductedCount++;

                // Mark sold out if stock hit 0
                if (updated.stockQuantity <= 0) {
                    updated.isAvailable = false;
                    updated.stockQuantity = 0;
                    await updated.save();
                }
            }
        }
        
        return itemsDeductedCount > 0;
    } catch (err) {
        console.error(`[deductTrackedStock] ❌ Failed to deduct stock for order ${order.orderId}:`, err);
        throw err;
    }
}


/**
 * Restores stock for tracked items in an order (e.g. upon cancellation).
 * Automatically makes items available if stock > 0.
 */
export async function restoreTrackedStock(order) {
    try {
        let itemsRestoredCount = 0;
        
        for (const item of order.items) {
            const query = item.menuItemId 
                ? { _id: item.menuItemId, businessId: order.businessId, trackStock: true } 
                : { name: item.itemName, businessId: order.businessId, trackStock: true };
                
            // Restore stock
            const updated = await MenuItem.findOneAndUpdate(
                query,
                { $inc: { stockQuantity: item.quantity } },
                { new: true }
            );
            
            if (updated) {
                itemsRestoredCount++;
                
                // Auto mark available if stock > 0
                if (updated.stockQuantity > 0 && !updated.isAvailable) {
                    await MenuItem.updateOne(
                        { _id: updated._id },
                        { $set: { isAvailable: true } }
                    );
                }
            }
        }
        return itemsRestoredCount > 0;
    } catch (err) {
        console.error(`[restoreTrackedStock] ❌ Failed to restore stock for order ${order.orderId}:`, err);
        throw err;
    }
}
