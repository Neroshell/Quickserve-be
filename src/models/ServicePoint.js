import mongoose from "mongoose"
import crypto from "crypto"

/**
 * generateServicePointId — produces a stable, URL-safe ID like `sp_a3f2b1c9`
 */
export function generateServicePointId() {
    return `sp_${crypto.randomBytes(4).toString("hex")}`
}

/**
 * Historical defaults are now resolved by businessCapabilityService.
 *   hotel → "room"
 *   everything else (restaurant, bar_lounge, …) → "table"
 */
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
        // servicePointType: {
        //     type: String,
        //     enum: ["table", "room", "booth", "other"],
        //     default: "table",
        // },

        // Optional seating/guest capacity
        capacity: {
            type: Number,
            min: 1,
            default: null,
            required: true,
        },

        // Whether this service point is currently in service
        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },

        reservable: {
            type: Boolean,
            default: true,
        },

        // Hotel-specific metadata
        fullDescription: { type: String, trim: true },
        pricePerNight: { type: Number, min: 0 },
        maxGuests: { type: Number, min: 1 },
        beds: { type: Number, min: 0 },
        bedType: { type: String, trim: true },
        amenities: [{ type: String, trim: true }],
        images: [{ type: String, trim: true }],
    },
    { timestamps: true }
)

// Compound index: fast lookup of a service point within a business
ServicePointSchema.index({ businessId: 1, servicePointId: 1 })
ServicePointSchema.index({ businessId: 1, isActive: 1 })

export default mongoose.models.ServicePoint ||
    mongoose.model("ServicePoint", ServicePointSchema)
