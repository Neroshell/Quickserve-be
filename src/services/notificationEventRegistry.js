import {
    NOTIFICATION_CATEGORIES,
    NOTIFICATION_ENTITY_TYPES,
    NOTIFICATION_EVENT_ACCESS,
    NOTIFICATION_SEVERITIES,
    NOTIFICATION_TYPES,
} from "../constants/notifications.js"

const STRING_LIMITS = Object.freeze({
    guestName: 120,
    reservationTime: 80,
    servicePointDisplayName: 120,
    reservationReference: 120,
    itemName: 160,
    trackingUnit: 40,
    invoiceReference: 120,
})

function text(value, fallback, maxLength = 120) {
    const normalized = typeof value === "string" ? value.trim() : ""
    return normalized ? normalized.slice(0, maxLength) : fallback
}

function positiveInteger(value, fallback = null) {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function finiteNumber(value, fallback = null) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

function reservationMessage(facts) {
    const parts = [
        `Reservation for ${positiveInteger(facts.partySize, 1)}`,
        text(facts.reservationTime, "scheduled time", STRING_LIMITS.reservationTime),
    ]
    const servicePoint = text(
        facts.servicePointDisplayName,
        "",
        STRING_LIMITS.servicePointDisplayName,
    )
    if (servicePoint) parts.push(servicePoint)
    return parts.join(" · ")
}

function inventoryMessage(facts, fallbackQuantity) {
    const quantity = finiteNumber(facts.availableQuantity, fallbackQuantity)
    const unit = text(facts.trackingUnit, "units", STRING_LIMITS.trackingUnit)
    return `${quantity} ${unit} available`
}

const DEFINITIONS = Object.freeze({
    [NOTIFICATION_TYPES.RESERVATION_EXTERNAL_CREATED]: Object.freeze({
        category: NOTIFICATION_CATEGORIES.RESERVATIONS,
        severity: NOTIFICATION_SEVERITIES.INFO,
        entityType: NOTIFICATION_ENTITY_TYPES.RESERVATION,
        metadataKeys: Object.freeze([
            "partySize",
            "reservationTime",
            "servicePointDisplayName",
        ]),
        buildContent(facts) {
            return {
                title: "New external reservation",
                message: reservationMessage(facts),
            }
        },
    }),
    [NOTIFICATION_TYPES.RESERVATION_GUEST_CANCELLED]: Object.freeze({
        category: NOTIFICATION_CATEGORIES.RESERVATIONS,
        severity: NOTIFICATION_SEVERITIES.WARNING,
        entityType: NOTIFICATION_ENTITY_TYPES.RESERVATION,
        metadataKeys: Object.freeze([
            "partySize",
            "reservationTime",
            "servicePointDisplayName",
        ]),
        buildContent(facts) {
            const guestName = text(facts.guestName, "A guest", STRING_LIMITS.guestName)
            return {
                title: `${guestName} cancelled`,
                message: reservationMessage(facts),
            }
        },
    }),
    [NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED]: Object.freeze({
        category: NOTIFICATION_CATEGORIES.RESERVATIONS,
        severity: NOTIFICATION_SEVERITIES.INFO,
        entityType: NOTIFICATION_ENTITY_TYPES.RESERVATION,
        metadataKeys: Object.freeze([
            "partySize",
            "reservationTime",
            "servicePointDisplayName",
        ]),
        buildContent(facts) {
            const guestName = text(facts.guestName, "A guest", STRING_LIMITS.guestName)
            return {
                title: `${guestName} has arrived`,
                message: reservationMessage(facts),
            }
        },
    }),
    [NOTIFICATION_TYPES.RESERVATION_REFUND_FAILED]: Object.freeze({
        category: NOTIFICATION_CATEGORIES.RESERVATIONS,
        severity: NOTIFICATION_SEVERITIES.CRITICAL,
        entityType: NOTIFICATION_ENTITY_TYPES.RESERVATION,
        metadataKeys: Object.freeze(["reservationReference"]),
        buildContent(facts) {
            const reference = text(
                facts.reservationReference,
                "the reservation",
                STRING_LIMITS.reservationReference,
            )
            return {
                title: "Reservation refund failed",
                message: `The refund for ${reference} could not be completed`,
            }
        },
    }),
    [NOTIFICATION_TYPES.FEEDBACK_LOW_RATING_RECEIVED]: Object.freeze({
        category: NOTIFICATION_CATEGORIES.FEEDBACK,
        severity: NOTIFICATION_SEVERITIES.WARNING,
        entityType: NOTIFICATION_ENTITY_TYPES.FEEDBACK,
        metadataKeys: Object.freeze(["rating", "servicePointDisplayName"]),
        buildContent(facts) {
            const rating = finiteNumber(facts.rating)
            if (rating === null || rating < 1 || rating > 2) {
                throw new TypeError("Low-rating notifications require a rating from 1 through 2")
            }
            const servicePoint = text(
                facts.servicePointDisplayName,
                "",
                STRING_LIMITS.servicePointDisplayName,
            )
            return {
                title: `${rating}-star feedback received`,
                message: servicePoint
                    ? `New low-rated feedback from ${servicePoint}`
                    : "New low-rated guest feedback",
            }
        },
    }),
    [NOTIFICATION_TYPES.INVENTORY_LOW_STOCK_ENTERED]: Object.freeze({
        category: NOTIFICATION_CATEGORIES.INVENTORY,
        severity: NOTIFICATION_SEVERITIES.WARNING,
        entityType: NOTIFICATION_ENTITY_TYPES.INVENTORY_ITEM,
        metadataKeys: Object.freeze(["itemName", "availableQuantity", "trackingUnit"]),
        buildContent(facts) {
            const itemName = text(facts.itemName, "An inventory item", STRING_LIMITS.itemName)
            return {
                title: `${itemName} is running low`,
                message: inventoryMessage(facts, 0),
            }
        },
    }),
    [NOTIFICATION_TYPES.INVENTORY_OUT_OF_STOCK_ENTERED]: Object.freeze({
        category: NOTIFICATION_CATEGORIES.INVENTORY,
        severity: NOTIFICATION_SEVERITIES.CRITICAL,
        entityType: NOTIFICATION_ENTITY_TYPES.INVENTORY_ITEM,
        metadataKeys: Object.freeze(["itemName", "availableQuantity", "trackingUnit"]),
        buildContent(facts) {
            const itemName = text(facts.itemName, "An inventory item", STRING_LIMITS.itemName)
            return {
                title: `${itemName} is out of stock`,
                message: inventoryMessage(facts, 0),
            }
        },
    }),
    [NOTIFICATION_TYPES.BILLING_INVOICE_PAYMENT_FAILED]: Object.freeze({
        category: NOTIFICATION_CATEGORIES.BILLING,
        severity: NOTIFICATION_SEVERITIES.CRITICAL,
        entityType: NOTIFICATION_ENTITY_TYPES.BILLING_INVOICE,
        metadataKeys: Object.freeze(["invoiceReference"]),
        buildContent(facts) {
            const reference = text(
                facts.invoiceReference,
                "the latest invoice",
                STRING_LIMITS.invoiceReference,
            )
            return {
                title: "Invoice payment failed",
                message: `Payment for ${reference} could not be collected`,
            }
        },
    }),
    [NOTIFICATION_TYPES.BILLING_SERVICE_RESTRICTED]: Object.freeze({
        category: NOTIFICATION_CATEGORIES.BILLING,
        severity: NOTIFICATION_SEVERITIES.CRITICAL,
        entityType: NOTIFICATION_ENTITY_TYPES.BUSINESS,
        metadataKeys: Object.freeze([]),
        buildContent() {
            return {
                title: "Service access restricted",
                message: "Billing requires attention to restore full service access",
            }
        },
    }),
})

function sanitizeMetadata(definition, facts = {}) {
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
        throw new TypeError("Notification event facts must be an object")
    }

    const metadata = {}
    for (const key of definition.metadataKeys) {
        const value = facts[key]
        if (value === undefined || value === null || value === "") continue
        if (key === "partySize" || key === "rating") {
            const normalized = positiveInteger(value)
            if (normalized !== null) metadata[key] = normalized
            continue
        }
        if (key === "availableQuantity") {
            const normalized = finiteNumber(value)
            if (normalized !== null) metadata[key] = normalized
            continue
        }
        metadata[key] = text(value, "", STRING_LIMITS[key] || 160)
    }
    return metadata
}

export function getNotificationEventDefinition(type) {
    return DEFINITIONS[type] || null
}

export function prepareNotificationEvent({ type, facts = {} }) {
    const definition = getNotificationEventDefinition(type)
    if (!definition) throw new TypeError(`Unsupported notification type: ${String(type)}`)

    const access = NOTIFICATION_EVENT_ACCESS[type]
    const content = definition.buildContent(facts)
    return {
        type,
        category: definition.category,
        severity: definition.severity,
        entityType: definition.entityType,
        title: text(content.title, "Notification", 160),
        message: text(content.message, "", 500),
        requiredAccessArea: access.area,
        requiredPermission: access.managerPermissions[0] || null,
        managersEligible: access.managersEligible,
        managerPermissions: [...access.managerPermissions],
        metadata: sanitizeMetadata(definition, facts),
    }
}
