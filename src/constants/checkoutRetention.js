// Stripe Checkout Sessions default to, and can remain payable for at most,
// 24 hours. Live webhook deliveries are then retried automatically for up to
// three days. Keep the authoritative cart snapshot for that entire protocol
// window, plus one hour for delivery-boundary, clock, and Mongo TTL cleanup
// tolerance.
export const STRIPE_CHECKOUT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000
export const STRIPE_WEBHOOK_AUTOMATIC_RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
export const PENDING_CHECKOUT_EXPIRY_SAFETY_BUFFER_MS = 60 * 60 * 1000

export const PENDING_CHECKOUT_RETENTION_MS =
    STRIPE_CHECKOUT_MAX_LIFETIME_MS +
    STRIPE_WEBHOOK_AUTOMATIC_RETRY_WINDOW_MS +
    PENDING_CHECKOUT_EXPIRY_SAFETY_BUFFER_MS

export function getPendingCheckoutExpiresAt({
    stripeExpiresAt = null,
    now = new Date(),
} = {}) {
    const hasStripeExpiry = stripeExpiresAt instanceof Date ||
        (stripeExpiresAt !== null &&
            stripeExpiresAt !== undefined &&
            stripeExpiresAt !== "" &&
            Number.isFinite(Number(stripeExpiresAt)))
    const stripeExpiry = hasStripeExpiry
        ? stripeExpiresAt instanceof Date
            ? stripeExpiresAt
            : new Date(Number(stripeExpiresAt) * 1000)
        : null
    const baseTime = !stripeExpiry || Number.isNaN(stripeExpiry.getTime())
        ? new Date(now).getTime() + STRIPE_CHECKOUT_MAX_LIFETIME_MS
        : stripeExpiry.getTime()

    return new Date(
        baseTime +
        STRIPE_WEBHOOK_AUTOMATIC_RETRY_WINDOW_MS +
        PENDING_CHECKOUT_EXPIRY_SAFETY_BUFFER_MS,
    )
}
