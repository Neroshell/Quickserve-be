/**
 * Normalize only categories produced by the existing food-service waiter-call
 * UI. Lodging categories are intentionally not inferred from free-form text.
 */
export function normalizeFoodServiceRequestCategory(reason) {
    const normalized = String(reason || "")
        .trim()
        .toLowerCase()
    if (
        normalized === "bill request" ||
        normalized === "request_bill"
    ) {
        return "request_bill"
    }
    if (
        normalized ===
            "customer neeed assistance" ||
        normalized ===
            "customer need assistance" ||
        normalized === "assistance"
    ) {
        return "assistance"
    }
    if (normalized === "emergency") {
        return "emergency"
    }
    return "other"
}
