export const LODGING_STAY_LENGTH_STATUSES = Object.freeze([
    "pending",
    "pending_approval",
    "accepted_awaiting_payment",
    "confirmed",
    "checked_in",
    "checked_out",
])

export const LODGING_SCHEDULED_STAY_STATUSES =
    Object.freeze([
        "confirmed",
        "checked_in",
        "checked_out",
    ])

export const LODGING_INVENTORY_BLOCKING_STATUSES =
    Object.freeze([
        "accepted_awaiting_payment",
        "confirmed",
        "checked_in",
    ])

export const LODGING_ACTIVE_PENDING_PAYMENT_STATUSES =
    Object.freeze(["accepted_awaiting_payment"])

export const LODGING_EXPIRED_PENDING_PAYMENT_STATUSES =
    Object.freeze([
        "accepted_awaiting_payment",
        "expired",
    ])

export const LODGING_NON_SERVICE_TERMINAL_STATUSES =
    Object.freeze([
        "cancelled",
        "declined",
        "expired",
        "no_show",
    ])

// Current-state booking-decision cohort used only for the explicitly named
// cancelled-booking cohort rate.
export const LODGING_BOOKING_DECISION_STATUSES =
    Object.freeze([
        "accepted_awaiting_payment",
        "confirmed",
        "checked_in",
        "checked_out",
        "cancelled",
        "expired",
    ])

export const LODGING_ROOM_TYPE_STAY_STATUSES =
    Object.freeze([
        "accepted_awaiting_payment",
        "confirmed",
        "checked_in",
        "checked_out",
    ])
