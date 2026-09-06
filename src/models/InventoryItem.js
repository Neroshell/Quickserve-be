import crypto from "node:crypto"
import mongoose from "mongoose"
import {
    INVENTORY_DIMENSIONS,
    INVENTORY_TRACKING_UNITS,
    MAX_INVENTORY_QUANTITY,
} from "../constants/inventory.js"
import { getInventoryTrackingUnitDefinition } from "../services/inventoryUomService.js"

export function generateInventoryItemId() {
    return `inv_${crypto.randomBytes(8).toString("hex")}`
}

function isSafeNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_INVENTORY_QUANTITY
}

const InventoryDeletionActorSchema = new mongoose.Schema({
    staffId: { type: String, required: true, trim: true, maxlength: 200 },
    role: { type: String, required: true, trim: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
}, { _id: false })

const InventoryItemSchema = new mongoose.Schema({
    inventoryItemId: {
        type: String,
        required: true,
        trim: true,
        maxlength: 100,
    },
    businessId: {
        type: String,
        required: true,
        index: true,
    },
    name: {
        type: String,
        required: true,
        trim: true,
        maxlength: 120,
    },
    // Private duplicate-detection metadata. These fields never replace
    // inventoryItemId as canonical identity. Existing records remain
    // unbackfilled so historical duplicates can stay separate.
    normalizedName: {
        type: String,
        default: undefined,
        maxlength: 120,
        select: false,
    },
    normalizedCategory: {
        type: String,
        default: undefined,
        maxlength: 80,
        select: false,
    },
    duplicateIdentityKey: {
        type: String,
        default: undefined,
        maxlength: 80,
        select: false,
    },
    category: {
        type: String,
        default: null,
        trim: true,
        maxlength: 80,
    },
    trackingUnit: {
        type: String,
        required: true,
        enum: INVENTORY_TRACKING_UNITS,
    },
    baseUnitDimension: {
        type: String,
        required: true,
        enum: Object.values(INVENTORY_DIMENSIONS),
    },
    onHandQuantity: {
        type: Number,
        required: true,
        default: 0,
        validate: {
            validator: isSafeNonNegativeInteger,
            message: "onHandQuantity must be a non-negative safe integer",
        },
    },
    reservedQuantity: {
        type: Number,
        required: true,
        default: 0,
        validate: {
            validator: isSafeNonNegativeInteger,
            message: "reservedQuantity must be a non-negative safe integer",
        },
    },
    lowStockThreshold: {
        type: Number,
        required: true,
        default: 0,
        validate: {
            validator: isSafeNonNegativeInteger,
            message: "lowStockThreshold must be a non-negative safe integer",
        },
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
    isActive: {
        type: Boolean,
        default: true,
    },
    deletedAt: {
        type: Date,
        default: null,
    },
    deletedBy: {
        type: InventoryDeletionActorSchema,
        default: null,
    },
}, {
    timestamps: true,
    optimisticConcurrency: true,
})

InventoryItemSchema.index(
    { businessId: 1, inventoryItemId: 1 },
    { unique: true },
)
InventoryItemSchema.index(
    { businessId: 1, duplicateIdentityKey: 1 },
    {
        unique: true,
        partialFilterExpression: {
            duplicateIdentityKey: { $type: "string" },
            deletedAt: null,
        },
    },
)
InventoryItemSchema.index({ businessId: 1, deletedAt: 1, isActive: 1, name: 1, _id: 1 })
InventoryItemSchema.index({ businessId: 1, deletedAt: 1, category: 1, isActive: 1, name: 1, _id: 1 })
InventoryItemSchema.index({ businessId: 1, updatedAt: -1, _id: -1 })

InventoryItemSchema.pre("validate", function () {
    let definition
    try {
        definition = getInventoryTrackingUnitDefinition(this.trackingUnit)
    } catch (error) {
        this.invalidate("trackingUnit", error.message)
        return
    }
    if (definition.dimension !== this.baseUnitDimension) {
        this.invalidate(
            "baseUnitDimension",
            `baseUnitDimension must be ${definition.dimension} for ${this.trackingUnit}`,
        )
    }

    if (this.onHandQuantity < this.reservedQuantity) {
        this.invalidate(
            "onHandQuantity",
            "onHandQuantity cannot be lower than reservedQuantity",
        )
    }

    const hasCost = this.unitCostMinor !== null && this.unitCostMinor !== undefined
    const hasCurrency = typeof this.costCurrency === "string" && this.costCurrency.length > 0
    if (hasCost !== hasCurrency) {
        this.invalidate(
            hasCost ? "costCurrency" : "unitCostMinor",
            "unitCostMinor and costCurrency must be provided together",
        )
    }
})

export default mongoose.models.InventoryItem ||
    mongoose.model("InventoryItem", InventoryItemSchema, "inventoryitems")
