import { NOTIFICATION_TYPES } from "../constants/notifications.js"
import {
    buildNotificationIdempotencyKey,
    createNotificationEvent,
} from "./notificationService.js"

function plain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : { ...value }
}

function validDate(value, fallback) {
    const parsed = value instanceof Date ? new Date(value) : new Date(value || "")
    return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

function requiredIdentity(value, field) {
    const normalized = String(value || "").trim()
    if (!normalized) throw new TypeError(`${field} is required`)
    return normalized
}

export async function notifyBillingInvoicePaymentFailed({
    billingInvoice: billingInvoiceValue,
    stripeInvoice = null,
    providerEventId,
    occurredAt,
    now = new Date(),
}, {
    createEvent = createNotificationEvent,
} = {}) {
    const billingInvoice = plain(billingInvoiceValue)
    if (billingInvoice?.status !== "failed") {
        return { skipped: true, reason: "invoice_not_failed" }
    }

    const businessId = requiredIdentity(billingInvoice.businessId, "businessId")
    const entityId = requiredIdentity(
        billingInvoice._id || billingInvoice.id || billingInvoice.stripeInvoiceId,
        "billingInvoice identity",
    )
    const occurrenceId = requiredIdentity(providerEventId, "providerEventId")
    const type = NOTIFICATION_TYPES.BILLING_INVOICE_PAYMENT_FAILED

    return createEvent({
        businessId,
        type,
        entityId,
        occurredAt: validDate(occurredAt, now),
        idempotencyKey: buildNotificationIdempotencyKey({
            type,
            entityId,
            occurrenceId,
        }),
        facts: {
            invoiceReference:
                stripeInvoice?.number ||
                billingInvoice.stripeInvoiceId ||
                entityId,
        },
    })
}

export async function notifyBillingServiceRestricted({
    business: businessValue,
    periodKey,
    now = new Date(),
}, {
    createEvent = createNotificationEvent,
} = {}) {
    const business = plain(businessValue)
    if (business?.offlineServiceRestricted !== true) {
        return { skipped: true, reason: "service_not_restricted" }
    }

    const businessId = requiredIdentity(business.businessId, "businessId")
    const occurrenceId = requiredIdentity(periodKey, "periodKey")
    const type = NOTIFICATION_TYPES.BILLING_SERVICE_RESTRICTED

    return createEvent({
        businessId,
        type,
        entityId: businessId,
        occurredAt: validDate(business.offlineServiceRestrictedAt, now),
        idempotencyKey: buildNotificationIdempotencyKey({
            type,
            entityId: businessId,
            occurrenceId,
        }),
        facts: {},
    })
}

export async function notifyReservationRefundFailed({
    refund: refundValue,
    now = new Date(),
}, {
    createEvent = createNotificationEvent,
} = {}) {
    const refund = plain(refundValue)
    if (refund?.status !== "failed") {
        return { skipped: true, reason: "refund_not_failed" }
    }

    const businessId = requiredIdentity(refund.businessId, "businessId")
    const entityId = requiredIdentity(refund.reservationId, "reservationId")
    const occurrenceId = requiredIdentity(refund.refundId, "refundId")
    const type = NOTIFICATION_TYPES.RESERVATION_REFUND_FAILED

    return createEvent({
        businessId,
        type,
        entityId,
        occurredAt: validDate(refund.failedAt, now),
        idempotencyKey: buildNotificationIdempotencyKey({
            type,
            entityId,
            occurrenceId,
        }),
        facts: {
            reservationReference: `reservation ${entityId}`,
        },
    })
}
