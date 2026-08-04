import mongoose from "mongoose";

const CrmLedgerItemSchema = new mongoose.Schema(
  {
    itemName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const CrmOrderProjectionLedgerSchema = new mongoose.Schema(
  {
    businessId: { type: String, required: true, index: true },
    orderId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    orderDate: { type: Date, required: true },
    localVisitDate: { type: String, required: true },
    spendCents: { type: Number, required: true, min: 0 },
    items: { type: [CrmLedgerItemSchema], default: [] },
    status: {
      type: String,
      enum: ["pending", "completed"],
      default: "pending",
      index: true,
    },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

CrmOrderProjectionLedgerSchema.index(
  { businessId: 1, orderId: 1 },
  { unique: true },
);
CrmOrderProjectionLedgerSchema.index({
  businessId: 1,
  email: 1,
  localVisitDate: 1,
  orderDate: 1,
});

export default mongoose.models.CrmOrderProjectionLedger ||
  mongoose.model("CrmOrderProjectionLedger", CrmOrderProjectionLedgerSchema);
