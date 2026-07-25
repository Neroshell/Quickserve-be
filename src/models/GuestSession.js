import mongoose from "mongoose"

const TableSessionSchema = new mongoose.Schema(
  {
    businessId: { type: String, required: true, index: true },
    servicePointId: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true, index: true },

    // first device that successfully places an order binds the token
    boundSessionId: { type: String, default: null },

    // TTL: Mongo will auto-delete after expiresAt passes
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
)

// TTL index (Mongo deletes docs when expiresAt < now)
TableSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.models.GuestSession || mongoose.model("GuestSession", TableSessionSchema)
