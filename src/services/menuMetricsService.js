import MenuItem from "../models/menuItem.js"

function requireBusinessId(value) {
    const businessId = String(value ?? "").trim()
    if (!businessId) throw new TypeError("businessId is required")
    return businessId
}

/**
 * Count current Menu-domain records for one authenticated tenant.
 * Availability and Inventory lifecycle state intentionally do not participate.
 */
export async function countCurrentMenuItems({ businessId }, {
    MenuItemModel = MenuItem,
} = {}) {
    return MenuItemModel.countDocuments({
        businessId: requireBusinessId(businessId),
        archivedAt: null,
    })
}
