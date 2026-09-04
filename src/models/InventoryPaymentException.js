import mongoose from "mongoose"

const InventoryPaymentExceptionSchema = new mongoose.Schema({
    businessId: { type: String, required: true, trim: true, maxlength: 200 },
    orderId: { type: String, required: true, trim: true, maxlength: 200 },
    pendingCheckoutId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "PendingCheckout",
        required: true,
    },
    inventoryReservationId: { type: String, required: true, trim: true, maxlength: 100 },
    stripeSessionId: { type: String, required: true, trim: true, maxlength: 255 },
    stripeEventId: { type: String, required: true, trim: true, maxlength: 255 },
    reasonCode: { type: String, required: true, trim: true, maxlength: 100 },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedByStaffId: { type: String, default: null, trim: true, maxlength: 200 },
}, { timestamps: true })

InventoryPaymentExceptionSchema.index({ stripeSessionId: 1 }, { unique: true })
InventoryPaymentExceptionSchema.index({ businessId: 1, status: 1, createdAt: -1 })
InventoryPaymentExceptionSchema.index({ businessId: 1, inventoryReservationId: 1 })

export default mongoose.models.InventoryPaymentException || mongoose.model(
    "InventoryPaymentException",
    InventoryPaymentExceptionSchema,
    "inventorypaymentexceptions",
)

