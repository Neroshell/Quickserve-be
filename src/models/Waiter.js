import mongoose from "mongoose"

const WaiterSchema = new mongoose.Schema({
    restaurantId: { type: String, required: true, index: true },
    waiterId: { type: String, required: true },
    name: { type: String, required: true },
    email: { 
        type: String, 
        required: true, 
        lowercase: true, 
        trim: true 
    },
    accountStatus: {
        type: String,
        enum: ["pending", "active", "disabled"],
        default: "pending"
    },
    presenceStatus: {
        type: String,
        enum: ["active", "offline"],
        default: "offline"
    },
    // Keep 'status' for backward compatibility (UI currently uses it)
    status: { 
        type: String, 
        enum: ["active", "offline"], 
        default: "offline" 
    },
    passwordHash: { type: String },
    inviteToken: { type: String },
    inviteTokenExpires: { type: Date }
}, { timestamps: true })

// Ensure waiterId is unique per restaurant
WaiterSchema.index({ restaurantId: 1, waiterId: 1 }, { unique: true })

// Ensure email is unique per restaurant (useful for future login)
WaiterSchema.index({ restaurantId: 1, email: 1 }, { unique: true })

export default mongoose.models.Waiter || mongoose.model("Waiter", WaiterSchema)
