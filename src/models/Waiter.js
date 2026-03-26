import mongoose from "mongoose"

const ALLOWED_ROLES = ["waiter", "kitchen", "manager"]

const WaiterSchema = new mongoose.Schema({
    restaurantId: { type: String, required: true, index: true },

    // Unified staff identifier (STF-XXXX). Required for all new records.
    staffId: { type: String, required: true },

    // Legacy identifier kept for backward compatibility
    waiterId: { type: String },

    // Staff role — set by the owner via card selection, never free-text
    role: {
        type: String,
        enum: ALLOWED_ROLES,
        default: "waiter"
    },

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

// Unified staffId must be unique per restaurant
WaiterSchema.index({ restaurantId: 1, staffId: 1 }, { unique: true })

// Legacy waiterId index — sparse so null values are ignored
WaiterSchema.index({ restaurantId: 1, waiterId: 1 }, { unique: true, sparse: true })

// Ensure email is unique per restaurant (useful for future login)
WaiterSchema.index({ restaurantId: 1, email: 1 }, { unique: true })

export default mongoose.models.Waiter || mongoose.model("Waiter", WaiterSchema)
