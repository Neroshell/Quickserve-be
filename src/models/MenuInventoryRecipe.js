import crypto from "node:crypto"
import mongoose from "mongoose"

import { INVENTORY_UNIT_VALUES, MAX_INVENTORY_QUANTITY } from "../constants/inventory.js"
import {
    LEGACY_MENU_STOCK_MIGRATION_SOURCE,
    MAX_INGREDIENT_RECIPE_COMPONENTS,
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_MAPPING_STATUS_VALUES,
    MENU_INVENTORY_MODE_VALUES,
    MENU_INVENTORY_MODES,
} from "../constants/menuInventory.js"

export function generateMenuInventoryRecipeId() {
    return `mir_${crypto.randomBytes(8).toString("hex")}`
}

function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_INVENTORY_QUANTITY
}

function isPositiveQuantity(value) {
    return Number.isFinite(value) && value > 0 && value <= MAX_INVENTORY_QUANTITY
}

const MenuInventoryComponentSchema = new mongoose.Schema({
    inventoryItemId: { type: String, required: true, trim: true, maxlength: 100 },
    quantity: { type: Number, required: true, validate: isPositiveQuantity },
    unit: { type: String, required: true, enum: INVENTORY_UNIT_VALUES },
    canonicalQuantity: { type: Number, required: true, validate: isPositiveSafeInteger },
}, { _id: false })

const LegacySnapshotSchema = new mongoose.Schema({
    trackStock: { type: Boolean, required: true },
    stockQuantity: { type: Number, default: null },
    lowStockThreshold: { type: Number, default: null },
    isAvailable: { type: Boolean, required: true },
    menuUpdatedAt: { type: Date, default: null },
}, { _id: false })

const MigrationMetadataSchema = new mongoose.Schema({
    source: {
        type: String,
        enum: [LEGACY_MENU_STOCK_MIGRATION_SOURCE],
        required: true,
    },
    version: { type: Number, required: true, min: 1, validate: Number.isInteger },
    migratedAt: { type: Date, required: true },
    legacySnapshot: { type: LegacySnapshotSchema, required: true },
    requiresOwnerAvailabilityReview: { type: Boolean, default: false },
}, { _id: false })

const MenuInventoryRecipeSchema = new mongoose.Schema({
    menuInventoryRecipeId: { type: String, required: true, trim: true, maxlength: 100 },
    businessId: { type: String, required: true, trim: true, maxlength: 200 },
    menuItemId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "MenuItem",
        required: true,
    },
    mode: {
        type: String,
        enum: MENU_INVENTORY_MODE_VALUES,
        default: MENU_INVENTORY_MODES.SIMPLE,
        required: true,
    },
    status: {
        type: String,
        enum: MENU_INVENTORY_MAPPING_STATUS_VALUES,
        default: MENU_INVENTORY_MAPPING_STATUSES.DISABLED,
        required: true,
    },
    version: { type: Number, default: 1, min: 1, validate: Number.isInteger },
    components: {
        type: [MenuInventoryComponentSchema],
        required: true,
        validate: {
            validator(value) {
                return Array.isArray(value) &&
                    value.length > 0 &&
                    value.length <= MAX_INGREDIENT_RECIPE_COMPONENTS
            },
            message: `Menu inventory mapping requires 1-${MAX_INGREDIENT_RECIPE_COMPONENTS} components`,
        },
    },
    // A Simple Stock mapping keeps its sellable InventoryItem in `components`.
    // Optional ingredients live beside it so the existing unique menu mapping,
    // Simple Stock history, and production indexes remain backward compatible.
    ingredientComponents: {
        type: [MenuInventoryComponentSchema],
        default: [],
        validate: {
            validator(value) {
                return Array.isArray(value) && value.length <= MAX_INGREDIENT_RECIPE_COMPONENTS
            },
            message: `Ingredient tracking allows at most ${MAX_INGREDIENT_RECIPE_COMPONENTS} components`,
        },
    },
    ingredientTrackingStatus: {
        type: String,
        enum: [...MENU_INVENTORY_MAPPING_STATUS_VALUES, null],
        default: null,
    },
    ingredientTrackingDisabledAt: { type: Date, default: null },
    ingredientTrackingRemovedAt: { type: Date, default: null },
    migration: { type: MigrationMetadataSchema, default: null },
    creationRequestFingerprint: {
        type: String,
        default: null,
        match: /^[a-f0-9]{64}$/,
    },
    disabledReason: {
        type: String,
        enum: ["owner_disabled", "legacy_rollback", "archived", null],
        default: null,
    },
    disabledAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
}, {
    timestamps: true,
    optimisticConcurrency: true,
})

MenuInventoryRecipeSchema.index(
    { businessId: 1, menuInventoryRecipeId: 1 },
    { unique: true },
)
MenuInventoryRecipeSchema.index(
    { businessId: 1, menuItemId: 1 },
    { unique: true },
)
MenuInventoryRecipeSchema.index({ businessId: 1, status: 1, mode: 1, _id: 1 })
MenuInventoryRecipeSchema.index({
    businessId: 1,
    "components.inventoryItemId": 1,
    status: 1,
})
MenuInventoryRecipeSchema.index({
    businessId: 1,
    "ingredientComponents.inventoryItemId": 1,
    ingredientTrackingStatus: 1,
})

function validateUniqueIngredientComponents(document, path, components) {
    const seenInventoryItemIds = new Set()
    for (const component of components || []) {
        if (seenInventoryItemIds.has(component.inventoryItemId)) {
            document.invalidate(
                path,
                "Ingredient recipes cannot contain the same inventory item more than once",
            )
            return false
        }
        seenInventoryItemIds.add(component.inventoryItemId)
    }
    return true
}

MenuInventoryRecipeSchema.pre("validate", function () {
    if (!Array.isArray(this.components) || this.components.length === 0) return

    if (this.mode === MENU_INVENTORY_MODES.SIMPLE) {
        if (this.components.length !== 1) {
            this.invalidate("components", "Simple Stock requires exactly one inventory component")
            return
        }

        const [component] = this.components
        if (component.quantity !== 1 || component.canonicalQuantity !== 1) {
            this.invalidate(
                "components",
                "Simple Stock requires one canonical inventory unit per menu sale",
            )
        }
        const ingredientComponents = Array.isArray(this.ingredientComponents)
            ? this.ingredientComponents
            : []
        if (ingredientComponents.length === 0 && this.ingredientTrackingStatus !== null) {
            this.invalidate(
                "ingredientTrackingStatus",
                "Ingredient tracking status requires ingredient components",
            )
        }
        if (
            ingredientComponents.length > 0 &&
            ![
                MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
                MENU_INVENTORY_MAPPING_STATUSES.DISABLED,
            ].includes(this.ingredientTrackingStatus)
        ) {
            this.invalidate(
                "ingredientTrackingStatus",
                "Ingredient components require an active or disabled tracking status",
            )
        }
        validateUniqueIngredientComponents(this, "ingredientComponents", ingredientComponents)
        return
    }

    if ((this.ingredientComponents || []).length > 0 || this.ingredientTrackingStatus !== null) {
        this.invalidate(
            "ingredientComponents",
            "Recipe mappings store ingredients in components",
        )
    }
    validateUniqueIngredientComponents(this, "components", this.components)
})

export default mongoose.models.MenuInventoryRecipe || mongoose.model(
    "MenuInventoryRecipe",
    MenuInventoryRecipeSchema,
    "menuinventoryrecipes",
)
