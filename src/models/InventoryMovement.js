import crypto from "node:crypto"
import mongoose from "mongoose"
import {
    INVENTORY_MOVEMENT_TYPE_VALUES,
    INVENTORY_UNIT_VALUES,
    MAX_INVENTORY_QUANTITY,
} from "../constants/inventory.js"
import {
    FULFILLMENT_ACTION_VALUES,
    FULFILLMENT_STATION_VALUES,
} from "../constants/orderFulfillment.js"

export function generateInventoryMovementId() {
    return `imv_${crypto.randomBytes(8).toString("hex")}`
}

function isSafeInteger(value) {
    return Number.isSafeInteger(value) && Math.abs(value) <= MAX_INVENTORY_QUANTITY
}

function isSafeNonNegativeInteger(value) {
    return isSafeInteger(value) && value >= 0
}

const PerformedBySchema = new mongoose.Schema({
    staffId: { type: String, required: true, trim: true, maxlength: 200 },
    role: { type: String, required: true, trim: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
}, { _id: false })

const InventoryMovementSchema = new mongoose.Schema({
    movementId: { type: String, required: true, trim: true, maxlength: 100 },
    businessId: { type: String, required: true },
    inventoryItemId: { type: String, required: true, trim: true, maxlength: 100 },
    type: { type: String, required: true, enum: INVENTORY_MOVEMENT_TYPE_VALUES },
    quantityDeltaOnHand: {
        type: Number,
        required: true,
        validate: { validator: isSafeInteger, message: "quantityDeltaOnHand must be a safe integer" },
    },
    quantityDeltaReserved: {
        type: Number,
        required: true,
        validate: { validator: isSafeInteger, message: "quantityDeltaReserved must be a safe integer" },
    },
    unit: { type: String, required: true, enum: INVENTORY_UNIT_VALUES },
    canonicalQuantity: {
        type: Number,
        required: true,
        validate: {
            validator(value) {
                return isSafeNonNegativeInteger(value) && value > 0
            },
            message: "canonicalQuantity must be a positive safe integer",
        },
    },
    onHandBefore: { type: Number, required: true, validate: isSafeNonNegativeInteger },
    onHandAfter: { type: Number, required: true, validate: isSafeNonNegativeInteger },
    reservedBefore: { type: Number, required: true, validate: isSafeNonNegativeInteger },
    reservedAfter: { type: Number, required: true, validate: isSafeNonNegativeInteger },
    sourceType: { type: String, required: true, trim: true, maxlength: 80 },
    sourceId: { type: String, default: null, trim: true, maxlength: 200 },
    reasonCode: { type: String, default: null, trim: true, maxlength: 100 },
    note: { type: String, default: null, trim: true, maxlength: 1000 },
    performedBy: { type: PerformedBySchema, required: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
    requestFingerprint: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
    },
    inventoryReservationId: { type: String, default: null, trim: true, maxlength: 100 },
    orderId: { type: String, default: null, trim: true, maxlength: 200 },
    orderLineIds: [{ type: String, trim: true, maxlength: 100 }],
    allocationIds: [{ type: String, trim: true, maxlength: 100 }],
    fulfillmentStation: {
        type: String,
        enum: [...FULFILLMENT_STATION_VALUES, null],
        default: null,
    },
    fulfillmentAction: {
        type: String,
        enum: [...FULFILLMENT_ACTION_VALUES, null],
        default: null,
    },
    unitCostMinor: {
        type: Number,
        default: null,
        validate: {
            validator(value) {
                return value === null || value === undefined || isSafeNonNegativeInteger(value)
            },
            message: "unitCostMinor must be a non-negative safe integer",
        },
    },
    costCurrency: {
        type: String,
        default: null,
        uppercase: true,
        trim: true,
        minlength: 3,
        maxlength: 3,
    },
}, {
    timestamps: { createdAt: true, updatedAt: false },
})

InventoryMovementSchema.index(
    { businessId: 1, movementId: 1 },
    { unique: true },
)
InventoryMovementSchema.index(
    { businessId: 1, idempotencyKey: 1 },
    { unique: true },
)
InventoryMovementSchema.index({
    businessId: 1,
    inventoryItemId: 1,
    createdAt: -1,
    _id: -1,
})
InventoryMovementSchema.index({
    businessId: 1,
    type: 1,
    createdAt: -1,
    _id: -1,
})
InventoryMovementSchema.index({ businessId: 1, createdAt: -1, _id: -1 })
InventoryMovementSchema.index({ businessId: 1, sourceType: 1, sourceId: 1 })

const DELTA_RULES_BY_MOVEMENT_TYPE = Object.freeze({
    RECEIVE: { onHand: 1, reserved: 0 },
    RESERVE: { onHand: 0, reserved: 1 },
    RELEASE: { onHand: 0, reserved: -1 },
    CONSUME: { onHand: -1, reserved: -1 },
    WASTE: { onHand: -1, reserved: 0 },
    ADJUSTMENT_INCREASE: { onHand: 1, reserved: 0 },
    ADJUSTMENT_DECREASE: { onHand: -1, reserved: 0 },
    COUNT_RECONCILIATION_INCREASE: { onHand: 1, reserved: 0 },
    COUNT_RECONCILIATION_DECREASE: { onHand: -1, reserved: 0 },
    LEGACY_ORDER_DEDUCTION: { onHand: -1, reserved: 0 },
    LEGACY_ORDER_RESTORE: { onHand: 1, reserved: 0 },
})

InventoryMovementSchema.pre("validate", function () {
    const hasCost = this.unitCostMinor !== null && this.unitCostMinor !== undefined
    const hasCurrency = typeof this.costCurrency === "string" && this.costCurrency.length > 0
    if (hasCost !== hasCurrency) {
        this.invalidate(
            hasCost ? "costCurrency" : "unitCostMinor",
            "unitCostMinor and costCurrency must be provided together",
        )
    }

    const deltaRule = DELTA_RULES_BY_MOVEMENT_TYPE[this.type]
    if (!deltaRule || !Number.isSafeInteger(this.canonicalQuantity)) return

    const expectedOnHandDelta = deltaRule.onHand * this.canonicalQuantity
    const expectedReservedDelta = deltaRule.reserved * this.canonicalQuantity
    if (this.quantityDeltaOnHand !== expectedOnHandDelta) {
        this.invalidate(
            "quantityDeltaOnHand",
            `${this.type} requires an On Hand delta of ${expectedOnHandDelta}`,
        )
    }
    if (this.quantityDeltaReserved !== expectedReservedDelta) {
        this.invalidate(
            "quantityDeltaReserved",
            `${this.type} requires a Reserved delta of ${expectedReservedDelta}`,
        )
    }
    if (this.onHandAfter !== this.onHandBefore + this.quantityDeltaOnHand) {
        this.invalidate("onHandAfter", "onHandAfter must equal On Hand before plus its delta")
    }
    if (this.reservedAfter !== this.reservedBefore + this.quantityDeltaReserved) {
        this.invalidate(
            "reservedAfter",
            "reservedAfter must equal Reserved before plus its delta",
        )
    }
    if (this.onHandBefore < this.reservedBefore || this.onHandAfter < this.reservedAfter) {
        this.invalidate(
            "reservedAfter",
            "InventoryMovement cannot record Reserved above On Hand",
        )
    }

    if (this.type === "CONSUME") {
        if (
            !this.inventoryReservationId ||
            !this.orderId ||
            !this.fulfillmentStation ||
            !this.fulfillmentAction ||
            !Array.isArray(this.orderLineIds) ||
            this.orderLineIds.length === 0 ||
            !Array.isArray(this.allocationIds) ||
            this.allocationIds.length === 0
        ) {
            this.invalidate(
                "inventoryReservationId",
                "CONSUME movements require reservation, order, allocation, line, station, and action metadata",
            )
        }
    }
})

InventoryMovementSchema.pre("save", function () {
    if (!this.isNew) {
        throw new Error("InventoryMovement is immutable")
    }
})

for (const operation of [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "findOneAndReplace",
    "replaceOne",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete",
]) {
    InventoryMovementSchema.pre(operation, function () {
        throw new Error("InventoryMovement is immutable")
    })
}

InventoryMovementSchema.pre("deleteOne", { document: true, query: false }, function () {
    throw new Error("InventoryMovement is immutable")
})

InventoryMovementSchema.pre("bulkWrite", function (operations) {
    if (!Array.isArray(operations) || operations.some((operation) => !operation.insertOne)) {
        throw new Error("InventoryMovement is immutable")
    }
})

export default mongoose.models.InventoryMovement ||
    mongoose.model("InventoryMovement", InventoryMovementSchema, "inventorymovements")
