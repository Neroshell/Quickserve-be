export const FINANCIAL_NOTIFICATION_METHODS = Object.freeze({
    INVOICE_PAYMENT_FAILED: "notifyBillingInvoicePaymentFailed",
    SERVICE_RESTRICTED: "notifyBillingServiceRestricted",
    RESERVATION_REFUND_FAILED: "notifyReservationRefundFailed",
})

export async function safelyNotifyFinancialEvent({
    method,
    input,
}, {
    notify = null,
    logger = console,
    context = {},
} = {}) {
    try {
        const module = notify ? null : await import("./financialNotificationService.js")
        const dispatch = notify || module?.[method]
        if (typeof dispatch !== "function") {
            throw new TypeError(`Unsupported financial notification method: ${String(method)}`)
        }
        return await dispatch(input)
    } catch (error) {
        logger?.error?.("[financial-notification] Notification intent failed", {
            ...context,
            errorClass: error?.name || "Error",
        })
        return { failed: true, reason: "notification_failed" }
    }
}
