import mongoose from "mongoose"
import { PERMISSION_VALUES } from "../constants/permissions.js"
import { MANAGEMENT_ACCESS_AREA_VALUES } from "../constants/managementAccess.js"

const ALLOWED_ROLES = ["waiter", "kitchen", "manager", "bartender", "co_owner"]

const StaffSchema = new mongoose.Schema({
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
    permissions: {
        type: [{ type: String, enum: PERMISSION_VALUES }],
        default: [],
    },
    // Co-owners are default-allow. An absent/empty list therefore preserves
    // broad access for every legacy co-owner without requiring a migration.
    coOwnerRestrictions: {
        type: [{ type: String, enum: MANAGEMENT_ACCESS_AREA_VALUES }],
        default: [],
    },
    passwordHash: { type: String },
    inviteToken: { type: String, select: false },
    inviteTokenExpires: { type: Date },
    passwordResetToken: { type: String, index: true, select: false },
    passwordResetExpires: { type: Date },
}, { timestamps: true })

// Unique staffId per business
StaffSchema.index({ businessId: 1, staffId: 1 }, { unique: true })

// Ensure email is unique per business
StaffSchema.index({ businessId: 1, email: 1 }, { unique: true })

// Keep the canonical collection explicit; never rely on Mongoose pluralization.
export default mongoose.models.Staff || mongoose.model("Staff", StaffSchema, "staff")
