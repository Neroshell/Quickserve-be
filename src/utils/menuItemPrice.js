export const MENU_ITEM_PRICE_ERROR = "Price must be a finite number greater than 0."

const DECIMAL_PRICE_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

export function isValidMenuItemPrice(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
}

export function parseMenuItemPrice(value) {
    if (typeof value === "number") {
        return isValidMenuItemPrice(value) ? value : null
    }
    if (typeof value !== "string") return null

    const normalized = value.trim()
    if (!DECIMAL_PRICE_PATTERN.test(normalized)) return null

    const numericValue = Number(normalized)
    return isValidMenuItemPrice(numericValue) ? numericValue : null
}
