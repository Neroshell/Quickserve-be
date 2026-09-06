import crypto from "node:crypto"
import mongoose from "mongoose"

import { INVENTORY_TRACKING_UNITS, MAX_INVENTORY_QUANTITY } from "../constants/inventory.js"
import {
    INVENTORY_LINE_ALLOCATION_STATUSES,
    INVENTORY_LINE_ALLOCATION_STATUS_VALUES,
    INVENTORY_RESERVATION_PROVIDER_STATE_VALUES,
    INVENTORY_RESERVATION_PROVIDER_STATES,
    INVENTORY_RESERVATION_SOURCE_TYPE_VALUES,
    INVENTORY_RESERVATION_STATUSES,
    INVENTORY_RESERVATION_STATUS_VALUES,
} from "../constants/inventoryReservation.js"
import { MENU_INVENTORY_MODE_VALUES } from "../constants/menuInventory.js"
import {
    FULFILLMENT_BEHAVIOR_VALUES,
    FULFILLMENT_STATION_VALUES,
} from "../constants/orderFulfillment.js"

export function generateInventoryReservationId() {
    return `irv_${crypto.randomBytes(12).toString("hex")}`
}

function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_INVENTORY_QUANTITY
}

const InventoryReservationComponentSchema = new mongoose.Schema({
    inventoryItemId: { type: String, required: true, trim: true, maxlength: 100 },
    canonicalQuantity: { type: Number, required: true, validate: isPositiveSafeInteger },
    unit: { type: String, required: true, enum: INVENTORY_TRACKING_UNITS },
    reserveMovementId: { type: String, required: true, trim: true, maxlength: 100 },
    releaseMovementId: { type: String, default: null, trim: true, maxlength: 100 },
}, { _id: false })

const InventoryReservationLineAllocationSchema = new mongoose.Schema({
    allocationId: { type: String, required: true, trim: true, maxlength: 100 },
    orderLineId: { type: String, required: true, trim: true, maxlength: 100 },
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem", required: true },
    fulfillmentStation: { type: String, required: true, enum: FULFILLMENT_STATION_VALUES },
    fulfillmentBehavior: { type: String, required: true, enum: FULFILLMENT_BEHAVIOR_VALUES },
    inventoryItemId: { type: String, required: true, trim: true, maxlength: 100 },
    canonicalQuantity: { type: Number, required: true, validate: isPositiveSafeInteger },
    unit: { type: String, required: true, enum: INVENTORY_TRACKING_UNITS },
    status: {
        type: String,
        required: true,
        enum: INVENTORY_LINE_ALLOCATION_STATUS_VALUES,
        default: INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED,
    },
    consumeMovementId: { type: String, default: null, trim: true, maxlength: 100 },
    consumedAt: { type: Date, default: null },
    releaseMovementId: { type: String, default: null, trim: true, maxlength: 100 },
    releasedAt: { type: Date, default: null },
}, { _id: false })

InventoryReservationLineAllocationSchema.pre("validate", function () {
    if (this.status === INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED) {
        if (this.consumeMovementId || this.consumedAt || this.releaseMovementId || this.releasedAt) {
            this.invalidate("status", "Reserved allocations cannot contain terminal lifecycle metadata")
        }
    } else if (this.status === INVENTORY_LINE_ALLOCATION_STATUSES.CONSUMED) {
        if (!this.consumeMovementId || !this.consumedAt || this.releaseMovementId || this.releasedAt) {
            this.invalidate("status", "Consumed allocations require only consumption lifecycle metadata")
        }
    } else if (this.status === INVENTORY_LINE_ALLOCATION_STATUSES.RELEASED) {
        if (!this.releaseMovementId || !this.releasedAt || this.consumeMovementId || this.consumedAt) {
            this.invalidate("status", "Released allocations require only release lifecycle metadata")
        }
    }
})

const LegacyReservationComponentSchema = new mongoose.Schema({
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem", required: true },
    quantity: { type: Number, required: true, validate: isPositiveSafeInteger },
}, { _id: false })

const MenuRequirementSnapshotSchema = new mongoose.Schema({
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem", required: true },
    orderQuantity: { type: Number, required: true, validate: isPositiveSafeInteger },
    authority: {
        type: String,
        required: true,
        enum: ["canonical", "legacy_menu_item"],
    },
    mappingMode: { type: String, enum: [...MENU_INVENTORY_MODE_VALUES, null], default: null },
    mappingVersion: { type: Number, min: 1, default: null },
}, { _id: false })

const InventoryReservationSchema = new mongoose.Schema({
    reservationId: { type: String, required: true, trim: true, maxlength: 100 },
    businessId: { type: String, required: true, trim: true, maxlength: 200 },
    sourceType: { type: String, required: true, enum: INVENTORY_RESERVATION_SOURCE_TYPE_VALUES },
    sourceId: { type: String, required: true, trim: true, maxlength: 200 },
    orderId: { type: String, default: null, trim: true, maxlength: 200 },
    pendingCheckoutId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "PendingCheckout",
        default: null,
    },
    status: {
        type: String,
        required: true,
        enum: INVENTORY_RESERVATION_STATUS_VALUES,
    },
    components: { type: [InventoryReservationComponentSchema], default: [] },
    lineAllocations: { type: [InventoryReservationLineAllocationSchema], default: [] },
    legacyComponents: { type: [LegacyReservationComponentSchema], default: [] },
    menuRequirements: { type: [MenuRequirementSnapshotSchema], default: [] },
    expiresAt: { type: Date, default: null },
    stripeExpiresAt: { type: Date, default: null },
    stripeSessionId: { type: String, default: null, trim: true, maxlength: 255 },
    providerState: {
        type: String,
        enum: INVENTORY_RESERVATION_PROVIDER_STATE_VALUES,
        default: INVENTORY_RESERVATION_PROVIDER_STATES.NOT_APPLICABLE,
    },
    providerCreationStartedAt: { type: Date, default: null },
    providerLastVerifiedAt: { type: Date, default: null },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
    requestFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    committedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    releaseEvidence: { type: String, default: null, trim: true, maxlength: 100 },
}, {
    timestamps: true,
    optimisticConcurrency: true,
})

InventoryReservationSchema.index({ businessId: 1, reservationId: 1 }, { unique: true })
InventoryReservationSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true })
InventoryReservationSchema.index({ businessId: 1, orderId: 1 })
InventoryReservationSchema.index({ businessId: 1, pendingCheckoutId: 1 })
InventoryReservationSchema.index({ stripeSessionId: 1 }, {
    unique: true,
    partialFilterExpression: { stripeSessionId: { $type: "string" } },
})
InventoryReservationSchema.index({ status: 1, expiresAt: 1, createdAt: 1 })

InventoryReservationSchema.pre("validate", function () {
    const canonicalCount = Array.isArray(this.components) ? this.components.length : 0
    const legacyCount = Array.isArray(this.legacyComponents) ? this.legacyComponents.length : 0
    if (canonicalCount === 0 && legacyCount === 0) {
        this.invalidate(
            "components",
            "InventoryReservation requires canonical or legacy reserved components",
        )
    }

    const canonicalIds = new Set()
    for (const component of this.components || []) {
        if (canonicalIds.has(component.inventoryItemId)) {
            this.invalidate("components", "Canonical reservation components must be aggregated")
            break
        }
        canonicalIds.add(component.inventoryItemId)
    }

    const legacyIds = new Set()
    for (const component of this.legacyComponents || []) {
        const key = String(component.menuItemId)
        if (legacyIds.has(key)) {
            this.invalidate("legacyComponents", "Legacy reservation components must be aggregated")
            break
        }
        legacyIds.add(key)
    }

    const allocations = Array.isArray(this.lineAllocations) ? this.lineAllocations : []
    if (allocations.length > 0) {
        const allocationIds = new Set()
        const allocationKeys = new Set()
        const allocationTotals = new Map()
        for (const allocation of allocations) {
            const allocationKey = `${allocation.orderLineId}:${allocation.inventoryItemId}`
            if (allocationIds.has(allocation.allocationId) || allocationKeys.has(allocationKey)) {
                this.invalidate(
                    "lineAllocations",
                    "Inventory line allocations must be unique by ID and order-line inventory ownership",
                )
                break
            }
            allocationIds.add(allocation.allocationId)
            allocationKeys.add(allocationKey)
            const current = allocationTotals.get(allocation.inventoryItemId) || {
                canonicalQuantity: 0,
                unit: allocation.unit,
            }
            current.canonicalQuantity += allocation.canonicalQuantity
            if (current.unit !== allocation.unit || !isPositiveSafeInteger(current.canonicalQuantity)) {
                this.invalidate("lineAllocations", "Inventory line allocation totals are invalid")
                break
            }
            allocationTotals.set(allocation.inventoryItemId, current)
        }

        if (
            allocationTotals.size !== canonicalIds.size ||
            [...canonicalIds].some((inventoryItemId) => {
                const component = (this.components || []).find(
                    (entry) => entry.inventoryItemId === inventoryItemId,
                )
                const allocated = allocationTotals.get(inventoryItemId)
                return !component || !allocated ||
                    component.canonicalQuantity !== allocated.canonicalQuantity ||
                    component.unit !== allocated.unit
            })
        ) {
            this.invalidate(
                "lineAllocations",
                "Inventory line allocations must exactly reconcile to aggregate components",
            )
        }
    }

    if (this.sourceType === "stripe_checkout") {
        if (!this.expiresAt || !this.pendingCheckoutId) {
            this.invalidate(
                "expiresAt",
                "Stripe inventory reservations require expiry and PendingCheckout linkage",
            )
        }
    } else if (this.status === INVENTORY_RESERVATION_STATUSES.HELD) {
        this.invalidate("status", "Only Stripe Checkout reservations may remain held")
    }
})

export default mongoose.models.InventoryReservation || mongoose.model(
    "InventoryReservation",
    InventoryReservationSchema,
    "inventoryreservations",
)
