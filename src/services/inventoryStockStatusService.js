export const INVENTORY_STOCK_STATUSES = Object.freeze({
    HEALTHY: "healthy",
    LOW_STOCK: "low_stock",
    OUT_OF_STOCK: "out_of_stock",
})

function safeInteger(value, field) {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`)
    }
    return parsed
}

export function resolveInventoryStockStatus({
    onHandQuantity,
    reservedQuantity,
    lowStockThreshold,
}) {
    const onHand = safeInteger(onHandQuantity, "onHandQuantity")
    const reserved = safeInteger(reservedQuantity, "reservedQuantity")
    const threshold = safeInteger(lowStockThreshold, "lowStockThreshold")
    const availableQuantity = onHand - reserved

    if (availableQuantity <= 0) {
        return {
            status: INVENTORY_STOCK_STATUSES.OUT_OF_STOCK,
            availableQuantity,
        }
    }
    if (availableQuantity <= threshold) {
        return {
            status: INVENTORY_STOCK_STATUSES.LOW_STOCK,
            availableQuantity,
        }
    }
    return {
        status: INVENTORY_STOCK_STATUSES.HEALTHY,
        availableQuantity,
    }
}
