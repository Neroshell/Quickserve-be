import mongoose from "mongoose"

const MenuItemSchema = new mongoose.Schema({
    restaurantId: { type: String, required: true, index: true },
    name: { type: String, required: true, maxlength: 30 },
    price: { type: Number, required: true },
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
    description: { type: String, default: "", maxlength: 70 },
    imageUrl: { type: String, default: "" },
    isAvailable: { type: Boolean, default: true }
}, { timestamps: true })

export default mongoose.models.MenuItem || mongoose.model("MenuItem", MenuItemSchema)
