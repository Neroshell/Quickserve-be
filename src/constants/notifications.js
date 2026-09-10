import { MANAGEMENT_ACCESS_AREAS } from "./managementAccess.js"
import { PERMISSIONS } from "./permissions.js"

export const NOTIFICATION_TYPES = Object.freeze({
    RESERVATION_EXTERNAL_CREATED: "reservation.external_created",
    RESERVATION_GUEST_CANCELLED: "reservation.guest_cancelled",
    RESERVATION_GUEST_ARRIVED: "reservation.guest_arrived",
    RESERVATION_REFUND_FAILED: "reservation.refund_failed",
    FEEDBACK_LOW_RATING_RECEIVED: "feedback.low_rating_received",
    INVENTORY_LOW_STOCK_ENTERED: "inventory.low_stock_entered",
    INVENTORY_OUT_OF_STOCK_ENTERED: "inventory.out_of_stock_entered",
    BILLING_INVOICE_PAYMENT_FAILED: "billing.invoice_payment_failed",
    BILLING_SERVICE_RESTRICTED: "billing.service_restricted",
})

export const NOTIFICATION_TYPE_VALUES = Object.freeze(
    Object.values(NOTIFICATION_TYPES),
)

export const NOTIFICATION_CATEGORIES = Object.freeze({
    RESERVATIONS: "reservations",
    FEEDBACK: "feedback",
    INVENTORY: "inventory",
    BILLING: "billing",
})

export const NOTIFICATION_CATEGORY_VALUES = Object.freeze(
    Object.values(NOTIFICATION_CATEGORIES),
)

export const NOTIFICATION_SEVERITIES = Object.freeze({
    INFO: "info",
    WARNING: "warning",
    CRITICAL: "critical",
})

export const NOTIFICATION_SEVERITY_VALUES = Object.freeze(
    Object.values(NOTIFICATION_SEVERITIES),
)

export const NOTIFICATION_RECIPIENT_KINDS = Object.freeze({
    OWNER: "owner",
    STAFF: "staff",
})

export const NOTIFICATION_RECIPIENT_KIND_VALUES = Object.freeze(
    Object.values(NOTIFICATION_RECIPIENT_KINDS),
)

export const NOTIFICATION_ENTITY_TYPES = Object.freeze({
    RESERVATION: "reservation",
    FEEDBACK: "feedback",
    INVENTORY_ITEM: "inventory_item",
    BILLING_INVOICE: "billing_invoice",
    BUSINESS: "business",
})

export const NOTIFICATION_ENTITY_TYPE_VALUES = Object.freeze(
    Object.values(NOTIFICATION_ENTITY_TYPES),
)

export const NOTIFICATION_RETENTION_DAYS = 30
export const NOTIFICATION_RETENTION_MS =
    NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000

export const NOTIFICATION_EVENT_ACCESS = Object.freeze({
    [NOTIFICATION_TYPES.RESERVATION_EXTERNAL_CREATED]: Object.freeze({
        area: MANAGEMENT_ACCESS_AREAS.RESERVATIONS,
        managerPermissions: Object.freeze([PERMISSIONS.RESERVATIONS_VIEW]),
        managersEligible: true,
    }),
    [NOTIFICATION_TYPES.RESERVATION_GUEST_CANCELLED]: Object.freeze({
        area: MANAGEMENT_ACCESS_AREAS.RESERVATIONS,
        managerPermissions: Object.freeze([PERMISSIONS.RESERVATIONS_VIEW]),
        managersEligible: true,
    }),
    [NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED]: Object.freeze({
        area: MANAGEMENT_ACCESS_AREAS.RESERVATIONS,
        managerPermissions: Object.freeze([PERMISSIONS.RESERVATIONS_VIEW]),
        managersEligible: true,
    }),
    [NOTIFICATION_TYPES.RESERVATION_REFUND_FAILED]: Object.freeze({
        area: MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING,
        managerPermissions: Object.freeze([]),
        managersEligible: false,
    }),
    [NOTIFICATION_TYPES.FEEDBACK_LOW_RATING_RECEIVED]: Object.freeze({
        area: MANAGEMENT_ACCESS_AREAS.FEEDBACK,
        managerPermissions: Object.freeze([PERMISSIONS.FEEDBACK_VIEW]),
        managersEligible: true,
    }),
    [NOTIFICATION_TYPES.INVENTORY_LOW_STOCK_ENTERED]: Object.freeze({
        area: MANAGEMENT_ACCESS_AREAS.INVENTORY,
        managerPermissions: Object.freeze([PERMISSIONS.INVENTORY_VIEW]),
        managersEligible: true,
    }),
    [NOTIFICATION_TYPES.INVENTORY_OUT_OF_STOCK_ENTERED]: Object.freeze({
        area: MANAGEMENT_ACCESS_AREAS.INVENTORY,
        managerPermissions: Object.freeze([PERMISSIONS.INVENTORY_VIEW]),
        managersEligible: true,
    }),
    [NOTIFICATION_TYPES.BILLING_INVOICE_PAYMENT_FAILED]: Object.freeze({
        area: MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING,
        managerPermissions: Object.freeze([]),
        managersEligible: false,
    }),
    [NOTIFICATION_TYPES.BILLING_SERVICE_RESTRICTED]: Object.freeze({
        area: MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING,
        managerPermissions: Object.freeze([]),
        managersEligible: false,
    }),
})
