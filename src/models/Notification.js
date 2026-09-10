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

export const NotificationMetadataSchema = new mongoose.Schema({
    partySize: { type: Number, min: 1 },
    reservationTime: { type: String, maxlength: 80, trim: true },
    servicePointDisplayName: { type: String, maxlength: 120, trim: true },
    reservationReference: { type: String, maxlength: 120, trim: true },
    rating: { type: Number, enum: [1, 2] },
    itemName: { type: String, maxlength: 160, trim: true },
    availableQuantity: { type: Number },
    trackingUnit: { type: String, maxlength: 40, trim: true },
    invoiceReference: { type: String, maxlength: 120, trim: true },
}, { _id: false, strict: "throw" })

const NotificationSchema = new mongoose.Schema({
    businessId: { type: String, required: true, index: true },
    recipientKind: {
        type: String,
        enum: NOTIFICATION_RECIPIENT_KIND_VALUES,
        required: true,
    },
    recipientId: { type: mongoose.Schema.Types.ObjectId, required: true },
    recipientRoleSnapshot: { type: String, required: true, maxlength: 40 },
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
    readAt: { type: Date, default: null },
    metadata: { type: NotificationMetadataSchema, default: () => ({}) },
    idempotencyKey: {
        type: String,
        required: true,
        trim: true,
        maxlength: 240,
    },
    expiresAt: { type: Date, required: true },
}, {
    timestamps: { createdAt: true, updatedAt: false },
    strict: "throw",
})

NotificationSchema.index(
    { businessId: 1, recipientKind: 1, recipientId: 1, idempotencyKey: 1 },
    { unique: true, name: "notification_recipient_event_unique" },
)
NotificationSchema.index(
    { businessId: 1, recipientKind: 1, recipientId: 1, createdAt: -1, _id: -1 },
    { name: "notification_recipient_feed" },
)
NotificationSchema.index(
    { businessId: 1, recipientKind: 1, recipientId: 1, readAt: 1, type: 1 },
    { name: "notification_recipient_unread" },
)
NotificationSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "notification_retention_ttl" },
)

export default mongoose.models.Notification ||
    mongoose.model("Notification", NotificationSchema, "notifications")

