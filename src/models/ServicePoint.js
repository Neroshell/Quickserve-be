import mongoose from "mongoose"
import crypto from "crypto"

/**
 * generateServicePointId — produces a stable, URL-safe ID like `sp_a3f2b1c9`
 */
export function generateServicePointId() {
    return `sp_${crypto.randomBytes(4).toString("hex")}`
}

/**
 * Derive servicePointType from the business's businessType.
 *   hotel_apartment → "room"
 *   everything else (restaurant, bar_lounge, …) → "table"
 */
export function deriveServicePointType(businessType) {
    return businessType === "hotel_apartment" ? "room" : "table"
}

const ServicePointSchema = new mongoose.Schema(
    {
        // Stable URL-safe identifier — used in QR codes, sessions, etc.
        servicePointId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },

        // Parent business
        businessId: {
            type: String,
            required: true,
            index: true,
        },

        // Human-friendly display label, e.g. "Table 7", "Room 204", "VIP Lounge"
        label: {
            type: String,
            required: true,
            trim: true,
            maxlength: 80,
        },

        // Short code, e.g. "T7", "204"
        code: {
            type: String,
            required: true,
            trim: true,
            maxlength: 20,
        },

        // Auto-derived from businessType — "table" or "room"
        servicePointType: {
            type: String,
            enum: ["table", "room", "booth", "other"],
            default: "table",
        },

        // Optional seating/guest capacity
        capacity: {
            type: Number,
            min: 1,
            default: null,
        },

        // Whether this service point is currently in service
        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },

        // Whether this service point can be selected by customers during reservation
        reservable: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true }
)

// Compound index: fast lookup of a service point within a business
ServicePointSchema.index({ businessId: 1, servicePointId: 1 })
ServicePointSchema.index({ businessId: 1, isActive: 1 })

export default mongoose.models.ServicePoint ||
    mongoose.model("ServicePoint", ServicePointSchema)
