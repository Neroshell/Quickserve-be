import mongoose from "mongoose"

const MenuItemSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    price: { type: Number, required: true },
    category: {
        type: String,
        enum: ["food", "drinks"],
        required: true,
        default: "food"
    },
    description: { type: String },
    isAvailable: { type: Boolean, default: true }
}, { timestamps: true })

export default mongoose.model("MenuItem", MenuItemSchema)
