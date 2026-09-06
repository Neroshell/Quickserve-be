export const INVENTORY_RESERVATION_STATUSES = Object.freeze({
    HELD: "held",
    COMMITTED: "committed",
    RELEASED: "released",
    EXPIRED: "expired",
})

export const INVENTORY_RESERVATION_STATUS_VALUES = Object.freeze(
    Object.values(INVENTORY_RESERVATION_STATUSES),
)

export const INVENTORY_LINE_ALLOCATION_STATUSES = Object.freeze({
    RESERVED: "reserved",
    CONSUMED: "consumed",
    RELEASED: "released",
})

export const INVENTORY_LINE_ALLOCATION_STATUS_VALUES = Object.freeze(
    Object.values(INVENTORY_LINE_ALLOCATION_STATUSES),
)

export const INVENTORY_RESERVATION_SOURCE_TYPES = Object.freeze({
    OFFLINE_ORDER: "offline_order",
    WAITSTAFF_ORDER: "waitstaff_order",
    STRIPE_CHECKOUT: "stripe_checkout",
})

export const INVENTORY_RESERVATION_SOURCE_TYPE_VALUES = Object.freeze(
    Object.values(INVENTORY_RESERVATION_SOURCE_TYPES),
)

export const INVENTORY_RESERVATION_PROVIDER_STATES = Object.freeze({
    NOT_APPLICABLE: "not_applicable",
    PENDING: "pending",
    OPEN: "open",
    COMPLETE: "complete",
    EXPIRED: "expired",
    CREATION_FAILED: "creation_failed",
    UNKNOWN: "unknown",
})

export const INVENTORY_RESERVATION_PROVIDER_STATE_VALUES = Object.freeze(
    Object.values(INVENTORY_RESERVATION_PROVIDER_STATES),
)

export const INVENTORY_RESERVATION_RELEASE_EVIDENCE = Object.freeze({
    ORDER_CANCELLED_BEFORE_FULFILMENT: "order_cancelled_before_fulfilment",
    STRIPE_CREATION_FAILED: "stripe_creation_failed",
    STRIPE_EXPIRED_EVENT: "stripe_expired_event",
    STRIPE_VERIFIED_EXPIRED: "stripe_verified_expired",
})

export const STRIPE_INVENTORY_HOLD_LIFETIME_MS = 30 * 60 * 1000
export const INVENTORY_PROVIDER_CREATION_REPAIR_DELAY_MS = 2 * 60 * 1000
export const INVENTORY_REPAIR_SCAN_LIMIT = 50
