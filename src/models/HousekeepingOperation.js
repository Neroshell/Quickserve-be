import crypto from "node:crypto"
import mongoose from "mongoose"

const HousekeepingActorSnapshotSchema = new mongoose.Schema({
    staffId: { type: String, default: null, trim: true, maxlength: 200 },
    name: { type: String, default: null, trim: true, maxlength: 200 },
    role: { type: String, default: null, trim: true, maxlength: 80 },
}, { _id: false })

const HousekeepingAssignmentHistorySchema = new mongoose.Schema({
    action: { type: String, enum: ["assigned", "reassigned"], required: true },
    previousAssignee: { type: HousekeepingActorSnapshotSchema, default: null },
    assignee: { type: HousekeepingActorSnapshotSchema, required: true },
    performedBy: { type: HousekeepingActorSnapshotSchema, required: true },
    occurredAt: { type: Date, required: true },
}, { _id: false })

const HousekeepingCommandReceiptSchema = new mongoose.Schema({
    key: { type: String, default: null, trim: true, maxlength: 200 },
    fingerprint: { type: String, default: null, trim: true, maxlength: 128 },
    recordedAt: { type: Date, default: null },
}, { _id: false })

const HousekeepingInventoryExceptionItemSchema = new mongoose.Schema({
    inventoryItemId: { type: String, required: true, trim: true, maxlength: 100 },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true, trim: true, maxlength: 40 },
}, { _id: false })

const HousekeepingInventoryExceptionSchema = new mongoose.Schema({
    status: { type: String, enum: ["unresolved", "resolved"], required: true },
    attemptFingerprint: { type: String, required: true, trim: true, maxlength: 128 },
    attemptedItems: { type: [HousekeepingInventoryExceptionItemSchema], default: [] },
    failureCode: { type: String, required: true, trim: true, maxlength: 100 },
    failureMessage: { type: String, required: true, trim: true, maxlength: 500 },
    reportedBy: { type: HousekeepingActorSnapshotSchema, required: true },
    firstReportedAt: { type: Date, required: true },
    lastReportedAt: { type: Date, required: true },
    attemptCount: { type: Number, required: true, default: 1, min: 1 },
    acknowledgedBy: { type: HousekeepingActorSnapshotSchema, default: null },
    acknowledgedAt: { type: Date, default: null },
    resolvedBy: { type: HousekeepingActorSnapshotSchema, default: null },
    resolvedAt: { type: Date, default: null },
    reconciliationMovementIds: { type: [String], default: [] },
    resolutionNote: { type: String, default: null, trim: true, maxlength: 1000 },
}, { _id: false })

export function generateHousekeepingOperationId({ businessId, triggerType, triggerId }) {
    return `hko_${crypto.createHash("sha256")
        .update(`${businessId}:${triggerType}:${triggerId}`)
        .digest("hex")
        .slice(0, 40)}`
}

const HousekeepingOperationSchema = new mongoose.Schema({
    housekeepingOperationId: { type: String, required: true },
    businessId: { type: String, required: true },
    servicePointId: { type: String, required: true },
    operationType: {
        type: String,
        enum: ["checkout_turnover", "stayover_service", "ad_hoc_service", "inspection"],
        required: true,
    },
    triggerType: {
        type: String,
        enum: ["reservation_checkout"],
        required: true,
    },
    triggerId: { type: String, required: true },
    status: {
        type: String,
        enum: ["needs_cleaning", "cleaning", "completed"],
        required: true,
        default: "needs_cleaning",
    },
    active: { type: Boolean, required: true, default: true },
    priority: {
        type: String,
        enum: ["normal", "priority", "urgent"],
        required: true,
        default: "normal",
    },
    assignedTo: { type: String, default: null, trim: true, maxlength: 200 },
    assignedToName: { type: String, default: null, trim: true, maxlength: 200 },
    assignedToRole: { type: String, default: null, trim: true, maxlength: 80 },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: String, default: null, trim: true, maxlength: 200 },
    assignedByName: { type: String, default: null, trim: true, maxlength: 200 },
    assignedByRole: { type: String, default: null, trim: true, maxlength: 80 },
    assignmentHistory: { type: [HousekeepingAssignmentHistorySchema], default: [] },
    claimedBy: { type: String, default: null },
    claimedByName: { type: String, default: null },
    claimedByRole: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedBy: { type: String, default: null },
    completedByName: { type: String, default: null },
    completedByRole: { type: String, default: null },
    completedAt: { type: Date, default: null },
    supplyOutcome: {
        type: String,
        enum: ["pending", "recorded", "no_supplies_used", "inventory_exception_acknowledged"],
        required: true,
        default: "pending",
    },
    roomUsageOperationId: { type: String, default: null },
    inventoryException: { type: HousekeepingInventoryExceptionSchema, default: null },
    commandReceipts: {
        assignment: { type: HousekeepingCommandReceiptSchema, default: () => ({}) },
        priority: { type: HousekeepingCommandReceiptSchema, default: () => ({}) },
        exceptionAcknowledgment: { type: HousekeepingCommandReceiptSchema, default: () => ({}) },
        exceptionResolution: { type: HousekeepingCommandReceiptSchema, default: () => ({}) },
    },
    note: { type: String, trim: true, maxlength: 1000, default: null },
}, { timestamps: true })

HousekeepingOperationSchema.index(
    { businessId: 1, housekeepingOperationId: 1 },
    { unique: true },
)
HousekeepingOperationSchema.index(
    { businessId: 1, triggerType: 1, triggerId: 1 },
    { unique: true },
)
HousekeepingOperationSchema.index(
    { businessId: 1, servicePointId: 1, active: 1 },
    { unique: true, partialFilterExpression: { active: true } },
)
HousekeepingOperationSchema.index({ businessId: 1, status: 1, createdAt: 1 })
HousekeepingOperationSchema.index({ businessId: 1, active: 1, priority: 1, createdAt: 1, _id: 1 })
HousekeepingOperationSchema.index({ businessId: 1, servicePointId: 1, createdAt: -1 })
HousekeepingOperationSchema.index({ businessId: 1, completedAt: -1, _id: -1 })
HousekeepingOperationSchema.index({ businessId: 1, "inventoryException.status": 1, createdAt: 1 })

export default mongoose.models.HousekeepingOperation ||
    mongoose.model("HousekeepingOperation", HousekeepingOperationSchema, "housekeeping_operations")
