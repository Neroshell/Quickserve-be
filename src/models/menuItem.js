import mongoose from "mongoose"

const MenuItemSchema = new mongoose.Schema({
    businessId: { type: String, required: true, index: true },
    name: { type: String, required: true, maxlength: 30 },
    price: { type: Number, required: true },
    prepTimeMinutes: {
        type: Number,
        default: 10,
        min: 1,
        validate: {
            validator: (value) => value === null || value === undefined || Number.isInteger(value),
            message: "Preparation time must be a whole number of minutes"
        }
    },
    category: {
        type: String, // UI display category: "appetizers", "mains", "desserts", "beverages"
        required: true,
        default: "mains"
    },
    type: {
        type: String, // Backend order routing type: "food" or "drinks"
        enum: ["food", "drinks"],
        required: true,
        default: "food"
    },
    // Null is retained for historical records so the compatibility resolver
    // can apply food -> kitchen/prepared and drinks -> bar/direct.
    fulfillmentStation: {
        type: String,
        enum: ["kitchen", "bar", null],
        default: null,
    },
    fulfillmentBehavior: {
        type: String,
        enum: ["prepared", "direct", null],
        default: null,
    },
    description: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    imagePublicId: { type: String, default: "" },
    isAvailable: { type: Boolean, default: true },
    // Phase 2A foundation only. Null means the legacy isAvailable value remains
    // the fallback owner intent until an explicit Simple Stock cutover.
    manualIsAvailable: { type: Boolean, default: null },
    trackStock: { type: Boolean, default: false },
    stockQuantity: { type: Number, default: null },
    lowStockThreshold: { type: Number, default: 5 },
    archivedAt: { type: Date, default: null, index: true }
}, { timestamps: true })

MenuItemSchema.pre("validate", function () {
    const hasExplicitFulfillment = this.fulfillmentStation || this.fulfillmentBehavior
    if (!hasExplicitFulfillment) return

    const validFood = this.type === "food" &&
        this.fulfillmentStation === "kitchen" &&
        this.fulfillmentBehavior === "prepared"
    const validDrink = this.type === "drinks" &&
        this.fulfillmentStation === "bar" &&
        ["direct", "prepared"].includes(this.fulfillmentBehavior)
    if (!validFood && !validDrink) {
        this.invalidate("fulfillmentStation", "Menu fulfilment configuration is inconsistent with item type")
    }
    if (this.fulfillmentBehavior === "prepared" && !Number.isInteger(this.prepTimeMinutes)) {
        this.invalidate("prepTimeMinutes", "Prepared items require a whole-number preparation time")
    }
    if (this.fulfillmentBehavior === "direct" && this.prepTimeMinutes !== null) {
        this.invalidate("prepTimeMinutes", "Direct items do not use a preparation time")
    }
})

MenuItemSchema.index({ businessId: 1, archivedAt: 1, createdAt: -1 })

export default mongoose.models.MenuItem || mongoose.model("MenuItem", MenuItemSchema)
