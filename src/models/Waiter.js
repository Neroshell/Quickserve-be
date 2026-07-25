import mongoose from "mongoose"

const ALLOWED_ROLES = ["waiter", "kitchen", "manager"]

const WaiterSchema = new mongoose.Schema({
    businessId: { type: String, required: true, index: true },

    // Unified staff identifier (STF-XXXX). Required for all new records.
    staffId: { type: String, required: true },

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

// Unique staffId per business
WaiterSchema.index({ businessId: 1, staffId: 1 }, { unique: true })

// Ensure email is unique per business
WaiterSchema.index({ businessId: 1, email: 1 }, { unique: true })

export default mongoose.models.Waiter || mongoose.model("Waiter", WaiterSchema)
