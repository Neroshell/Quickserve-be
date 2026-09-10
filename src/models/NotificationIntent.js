import mongoose from "mongoose"

import {
    NOTIFICATION_CATEGORY_VALUES,
    NOTIFICATION_ENTITY_TYPE_VALUES,
    NOTIFICATION_RECIPIENT_KIND_VALUES,
    NOTIFICATION_SEVERITY_VALUES,
    NOTIFICATION_TYPE_VALUES,
} from "../constants/notifications.js"
import { MANAGEMENT_ACCESS_AREA_VALUES } from "../constants/managementAccess.js"
import { PERMISSION_VALUES } from "../constants/permissions.js"
import { NotificationMetadataSchema } from "./Notification.js"

const NotificationIntentRecipientSchema = new mongoose.Schema({
    recipientKind: {
        type: String,
        enum: NOTIFICATION_RECIPIENT_KIND_VALUES,
        required: true,
    },
    recipientId: { type: mongoose.Schema.Types.ObjectId, required: true },
    role: { type: String, required: true, maxlength: 40 },
}, { _id: false, strict: "throw" })

const NotificationIntentSchema = new mongoose.Schema({
    businessId: { type: String, required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPE_VALUES, required: true },
    category: {
        type: String,
        enum: NOTIFICATION_CATEGORY_VALUES,
        required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    severity: {
        type: String,
        enum: NOTIFICATION_SEVERITY_VALUES,
        required: true,
    },
    entityType: {
        type: String,
        enum: NOTIFICATION_ENTITY_TYPE_VALUES,
        required: true,
    },
    entityId: { type: String, required: true, trim: true, maxlength: 200 },
    requiredAccessArea: {
        type: String,
        enum: MANAGEMENT_ACCESS_AREA_VALUES,
        required: true,
    },
    requiredPermission: {
        type: String,
        enum: [...PERMISSION_VALUES, null],
        default: null,
    },
    occurredAt: { type: Date, required: true },
    metadata: { type: NotificationMetadataSchema, default: () => ({}) },
    recipients: {
        type: [NotificationIntentRecipientSchema],
        required: true,
        default: [],
    },
    idempotencyKey: {
        type: String,
        required: true,
        trim: true,
        maxlength: 240,
    },
    payloadHash: { type: String, required: true, minlength: 64, maxlength: 64 },
    status: {
        type: String,
        enum: ["pending", "processing", "completed", "failed"],
        default: "pending",
        required: true,
    },
    attemptCount: { type: Number, min: 0, default: 0 },
    claimId: { type: String, default: null, maxlength: 100 },
    claimedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    enqueuedAt: { type: Date, default: null },
    enqueueError: { type: String, default: null, maxlength: 100 },
    lastError: { type: String, default: null, maxlength: 100 },
    expiresAt: { type: Date, required: true },
}, { timestamps: true, strict: "throw" })

NotificationIntentSchema.index(
    { businessId: 1, idempotencyKey: 1 },
    { unique: true, name: "notification_intent_event_unique" },
)
NotificationIntentSchema.index(
    { status: 1, claimedAt: 1, createdAt: 1 },
    { name: "notification_intent_recovery" },
)
NotificationIntentSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "notification_intent_retention_ttl" },
)

export default mongoose.models.NotificationIntent || mongoose.model(
    "NotificationIntent",
    NotificationIntentSchema,
    "notification_intents",
)

