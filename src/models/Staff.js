import mongoose from "mongoose"
import { PERMISSION_VALUES } from "../constants/permissions.js"
import { MANAGEMENT_ACCESS_AREA_VALUES } from "../constants/managementAccess.js"

const ALLOWED_ROLES = ["waiter", "kitchen", "manager", "bartender", "housekeeping", "co_owner"]

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
    // Incremented after security-sensitive authority or credential changes.
    // Sessions keep the version observed at login so old devices stay revoked
    // even if an account is later re-enabled, without requiring a Redis scan.
    authVersion: { type: Number, default: 0, min: 0 },
    inviteToken: { type: String, select: false },
    inviteTokenExpires: { type: Date },
    passwordResetToken: { type: String, index: true, select: false },
    passwordResetExpires: { type: Date },
}, { timestamps: true })

// Unique staffId per business
StaffSchema.index({ businessId: 1, staffId: 1 }, { unique: true })

// Ensure email is unique per business
StaffSchema.index({ businessId: 1, email: 1 }, { unique: true })

// Password controllers increment authVersion explicitly so the new version is
// persisted in the same save as the replacement hash. Model hooks cover every
// canonical role/account-status mutation, including future management flows.
const AUTH_VERSION_PATHS = ["accountStatus", "role"]

StaffSchema.pre("save", function incrementAuthVersionForSensitiveSave() {
    if (this.isNew || !AUTH_VERSION_PATHS.some((path) => this.isModified(path))) return
    const current = Number(this.authVersion)
    this.authVersion = (Number.isSafeInteger(current) && current >= 0 ? current : 0) + 1
})

function updateTouchesSensitiveAuthState(update = {}) {
    return AUTH_VERSION_PATHS.some((path) => (
        Object.hasOwn(update, path) ||
        Object.hasOwn(update.$set || {}, path) ||
        Object.hasOwn(update.$unset || {}, path)
    ))
}

function incrementAuthVersionForSensitiveQueryUpdate() {
    const update = this.getUpdate() || {}
    if (!updateTouchesSensitiveAuthState(update)) return

    delete update.authVersion
    if (update.$set) delete update.$set.authVersion
    update.$inc = {
        ...(update.$inc || {}),
        authVersion: Number(update.$inc?.authVersion || 0) + 1,
    }
    this.setUpdate(update)
}

StaffSchema.pre("findOneAndUpdate", incrementAuthVersionForSensitiveQueryUpdate)
StaffSchema.pre("updateOne", incrementAuthVersionForSensitiveQueryUpdate)
StaffSchema.pre("updateMany", incrementAuthVersionForSensitiveQueryUpdate)

// Keep the canonical collection explicit; never rely on Mongoose pluralization.
export default mongoose.models.Staff || mongoose.model("Staff", StaffSchema, "staff")
