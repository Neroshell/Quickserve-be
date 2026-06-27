import mongoose from "mongoose"

const MenuItemSchema = new mongoose.Schema({
    businessId: { type: String, required: true, index: true },
    name: { type: String, required: true, maxlength: 30 },
    price: { type: Number, required: true },
    prepTimeMinutes: {
        type: Number,
        required: true,
        min: 1,
        default: 10,
        validate: {
            validator: Number.isInteger,
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
    description: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    imagePublicId: { type: String, default: "" },
    isAvailable: { type: Boolean, default: true },
    trackStock: { type: Boolean, default: false },
    stockQuantity: { type: Number, default: null },
    lowStockThreshold: { type: Number, default: 5 }
}, { timestamps: true })

export default mongoose.models.MenuItem || mongoose.model("MenuItem", MenuItemSchema)
