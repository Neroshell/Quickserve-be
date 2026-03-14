import mongoose from "mongoose"

const MenuItemSchema = new mongoose.Schema({
    restaurantId: { type: String, required: true, index: true },
    name: { type: String, required: true },
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
    description: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    isAvailable: { type: Boolean, default: true }
}, { timestamps: true })

export default mongoose.model("MenuItem", MenuItemSchema)
