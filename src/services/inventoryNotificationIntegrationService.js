export async function safelyNotifyInventoryStockTransitions(input, {
    notify = null,
    logger = console,
} = {}) {
    try {
        if (!Array.isArray(input?.movements) || input.movements.length === 0) {
            return { attempted: 0, created: 0, failed: 0, skipped: 0 }
        }
        const dispatch = notify || (await import("./inventoryNotificationService.js"))
            .createInventoryStockTransitionNotifications
        return await dispatch(input)
    } catch (error) {
        logger?.error?.("[inventory-notification] Transition processing failed", {
            businessId: String(input?.businessId || ""),
            errorClass: error?.name || "Error",
        })
        return { attempted: 0, created: 0, failed: 1, skipped: 0 }
    }
}
