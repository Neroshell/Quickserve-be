import { createHash, randomUUID } from "node:crypto"
import mongoose from "mongoose"

import Notification from "../models/Notification.js"
import NotificationIntent from "../models/NotificationIntent.js"
import {
    NOTIFICATION_RETENTION_MS,
} from "../constants/notifications.js"
import { prepareNotificationEvent } from "./notificationEventRegistry.js"
import { resolveNotificationRecipients } from "./notificationRecipientService.js"
import {
    enqueueNotificationIntent,
    isNotificationQueueEnabled,
} from "../queues/notificationQueue.js"
import { publishNotificationChanged } from "../utils/sseManager.js"

export const NOTIFICATION_INTENT_CLAIM_LEASE_MS = 5 * 60 * 1000
export const NOTIFICATION_REPAIR_BATCH_SIZE = 100

export class NotificationServiceError extends Error {
    constructor(message, statusCode = 400, code = "NOTIFICATION_ERROR") {
        super(message)
        this.name = "NotificationServiceError"
        this.statusCode = statusCode
        this.code = code
    }
}

function requiredString(value, field, maxLength = 200) {
    const normalized = typeof value === "string" ? value.trim() : ""
    if (!normalized) {
        throw new NotificationServiceError(`${field} is required`)
    }
    if (normalized.length > maxLength) {
        throw new NotificationServiceError(`${field} is too long`)
    }
    return normalized
}

function validDate(value, field) {
    const parsed = value instanceof Date ? new Date(value) : new Date(value)
    if (Number.isNaN(parsed.getTime())) {
        throw new NotificationServiceError(`${field} must be a valid date`)
    }
    return parsed
}

function plain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : value
}

async function lean(query, session = null) {
    let nextQuery = query
    if (session && typeof nextQuery?.session === "function") {
        nextQuery = nextQuery.session(session)
    }
    if (typeof nextQuery?.lean === "function") return nextQuery.lean()
    return nextQuery
}

function stableSerialize(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableSerialize).join(",")}]`
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
        return `{${entries.map(([key, item]) => (
            `${JSON.stringify(key)}:${stableSerialize(item)}`
        )).join(",")}}`
    }
    return JSON.stringify(value)
}

function payloadHash(payload) {
    return createHash("sha256").update(stableSerialize(payload)).digest("hex")
}

function safeErrorReason(error) {
    return String(error?.code || error?.name || "notification_processing_failed")
        .slice(0, 100)
}

function isDuplicateKeyError(error) {
    const writeErrors = error?.writeErrors
    if (Array.isArray(writeErrors) && writeErrors.length > 0) {
        return writeErrors.every((item) => item?.code === 11000)
    }
    return error?.code === 11000
}

function assertSameIntent(existing, expectedHash) {
    if (existing.payloadHash !== expectedHash) {
        throw new NotificationServiceError(
            "The idempotency key is already used by a different notification event",
            409,
            "NOTIFICATION_IDEMPOTENCY_CONFLICT",
        )
    }
}

export function buildNotificationIdempotencyKey({ type, entityId, occurrenceId }) {
    return [
        requiredString(type, "type", 80),
        requiredString(entityId, "entityId", 200),
        requiredString(occurrenceId, "occurrenceId", 120),
    ].join(":")
}

export async function recordNotificationIntent({
    businessId,
    type,
    entityId,
    occurredAt,
    idempotencyKey,
    facts = {},
}, {
    NotificationIntentModel = NotificationIntent,
    recipientResolver = resolveNotificationRecipients,
    BusinessModel,
    StaffModel,
    session = null,
    now = new Date(),
} = {}) {
    const normalizedBusinessId = requiredString(businessId, "businessId", 120)
    const normalizedEntityId = requiredString(entityId, "entityId", 200)
    const normalizedIdempotencyKey = requiredString(
        idempotencyKey,
        "idempotencyKey",
        240,
    )
    const normalizedOccurredAt = validDate(occurredAt, "occurredAt")
    const prepared = prepareNotificationEvent({ type, facts })
    const envelope = {
        type: prepared.type,
        category: prepared.category,
        title: prepared.title,
        message: prepared.message,
        severity: prepared.severity,
        entityType: prepared.entityType,
        entityId: normalizedEntityId,
        requiredAccessArea: prepared.requiredAccessArea,
        requiredPermission: prepared.requiredPermission,
        occurredAt: normalizedOccurredAt.toISOString(),
        metadata: prepared.metadata,
    }
    const expectedHash = payloadHash(envelope)
    const identityFilter = {
        businessId: normalizedBusinessId,
        idempotencyKey: normalizedIdempotencyKey,
    }

    const existing = await lean(NotificationIntentModel.findOne(identityFilter), session)
    if (existing) {
        assertSameIntent(existing, expectedHash)
        return { intent: plain(existing), created: false }
    }

    const recipients = await recipientResolver({
        businessId: normalizedBusinessId,
        requiredAccessArea: prepared.requiredAccessArea,
        managerPermissions: prepared.managerPermissions,
        managersEligible: prepared.managersEligible,
    }, { BusinessModel, StaffModel, session })

    const setOnInsert = {
        businessId: normalizedBusinessId,
        ...envelope,
        occurredAt: normalizedOccurredAt,
        recipients,
        idempotencyKey: normalizedIdempotencyKey,
        payloadHash: expectedHash,
        status: "pending",
        expiresAt: new Date(now.getTime() + NOTIFICATION_RETENTION_MS),
    }

    try {
        const intent = await lean(NotificationIntentModel.findOneAndUpdate(
            identityFilter,
            { $setOnInsert: setOnInsert },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
                ...(session ? { session } : {}),
            },
        ))
        assertSameIntent(intent, expectedHash)
        return { intent: plain(intent), created: true }
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error
        const racedIntent = await lean(
            NotificationIntentModel.findOne(identityFilter),
            session,
        )
        if (!racedIntent) throw error
        assertSameIntent(racedIntent, expectedHash)
        return { intent: plain(racedIntent), created: false }
    }
}

export async function persistRecipientNotifications(intentValue, {
    NotificationModel = Notification,
    now = new Date(),
} = {}) {
    const intent = plain(intentValue)
    const recipients = Array.isArray(intent?.recipients) ? intent.recipients : []
    if (recipients.length === 0) return { recipientCount: 0, upsertedCount: 0 }

    const expiresAt = new Date(now.getTime() + NOTIFICATION_RETENTION_MS)
    const operations = recipients.map((recipientValue) => {
        const recipient = plain(recipientValue)
        const filter = {
            businessId: intent.businessId,
            recipientKind: recipient.recipientKind,
            recipientId: recipient.recipientId,
            idempotencyKey: intent.idempotencyKey,
        }
        return {
            updateOne: {
                filter,
                update: {
                    $setOnInsert: {
                        ...filter,
                        recipientRoleSnapshot: recipient.role,
                        type: intent.type,
                        category: intent.category,
                        title: intent.title,
                        message: intent.message,
                        severity: intent.severity,
                        entityType: intent.entityType,
                        entityId: intent.entityId,
                        requiredAccessArea: intent.requiredAccessArea,
                        requiredPermission: intent.requiredPermission || null,
                        occurredAt: intent.occurredAt,
                        readAt: null,
                        metadata: plain(intent.metadata) || {},
                        createdAt: now,
                        expiresAt,
                    },
                },
                upsert: true,
            },
        }
    })

    try {
        const result = await NotificationModel.bulkWrite(operations, { ordered: false })
        return {
            recipientCount: recipients.length,
            upsertedCount: Number(result?.upsertedCount || 0),
        }
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error
        return { recipientCount: recipients.length, upsertedCount: 0 }
    }
}

export async function processNotificationIntent({
    businessId,
    intentId,
    now = new Date(),
}, {
    NotificationIntentModel = NotificationIntent,
    NotificationModel = Notification,
    claimLeaseMs = NOTIFICATION_INTENT_CLAIM_LEASE_MS,
    publishChange = publishNotificationChanged,
} = {}) {
    const normalizedBusinessId = requiredString(businessId, "businessId", 120)
    if (!mongoose.isValidObjectId(intentId)) {
        throw new NotificationServiceError("intentId is invalid")
    }

    const claimId = randomUUID()
    const staleBefore = new Date(now.getTime() - claimLeaseMs)
    const intent = await lean(NotificationIntentModel.findOneAndUpdate({
        _id: intentId,
        businessId: normalizedBusinessId,
        $or: [
            { status: { $in: ["pending", "failed"] } },
            { status: "processing", claimedAt: { $lte: staleBefore } },
        ],
    }, {
        $set: {
            status: "processing",
            claimId,
            claimedAt: now,
            lastError: null,
        },
        $inc: { attemptCount: 1 },
    }, { new: true }))

    if (!intent) {
        const current = await lean(NotificationIntentModel.findOne({
            _id: intentId,
            businessId: normalizedBusinessId,
        }))
        if (!current) return { skipped: true, reason: "intent_not_found" }
        return {
            skipped: true,
            reason: current.status === "completed"
                ? "intent_completed"
                : "intent_already_processing",
        }
    }

    try {
        const result = await persistRecipientNotifications(intent, {
            NotificationModel,
            now,
        })
        await publishChange({
            businessId: normalizedBusinessId,
            recipients: intent.recipients,
            requiredAccessArea: intent.requiredAccessArea,
            requiredPermission: intent.requiredPermission || null,
        })
        await NotificationIntentModel.updateOne({
            _id: intentId,
            businessId: normalizedBusinessId,
            claimId,
            status: "processing",
        }, {
            $set: {
                status: "completed",
                completedAt: now,
                claimId: null,
                claimedAt: null,
                lastError: null,
            },
        })
        return { completed: true, ...result }
    } catch (error) {
        await NotificationIntentModel.updateOne({
            _id: intentId,
            businessId: normalizedBusinessId,
            claimId,
            status: "processing",
        }, {
            $set: {
                status: "failed",
                claimId: null,
                claimedAt: null,
                lastError: safeErrorReason(error),
            },
        }).catch(() => {})
        throw error
    }
}

export async function dispatchNotificationIntent({
    businessId,
    intentId,
    env = process.env,
}, {
    NotificationIntentModel = NotificationIntent,
    NotificationModel = Notification,
    enqueue = enqueueNotificationIntent,
    processIntent = processNotificationIntent,
    claimLeaseMs = NOTIFICATION_INTENT_CLAIM_LEASE_MS,
    publishChange = publishNotificationChanged,
    now = new Date(),
} = {}) {
    if (!isNotificationQueueEnabled(env)) {
        try {
            const result = await processIntent(
                { businessId, intentId, now },
                {
                    NotificationIntentModel,
                    NotificationModel,
                    claimLeaseMs,
                    publishChange,
                },
            )
            return { durable: true, mode: "direct", success: true, result }
        } catch (error) {
            return {
                durable: true,
                mode: "direct",
                success: false,
                reason: safeErrorReason(error),
            }
        }
    }

    try {
        const queued = await enqueue({ businessId, intentId }, { env })
        await NotificationIntentModel.updateOne({ _id: intentId, businessId }, {
            $set: { enqueuedAt: now, enqueueError: null },
        })
        return { durable: true, mode: "queued", ...queued }
    } catch (error) {
        await NotificationIntentModel.updateOne({ _id: intentId, businessId }, {
            $set: { enqueueError: safeErrorReason(error) },
        }).catch(() => {})
        return {
            durable: true,
            mode: "queued",
            queued: false,
            reason: "enqueue_failed",
        }
    }
}

export async function createNotificationEvent(event, dependencies = {}) {
    const recorded = await recordNotificationIntent(event, dependencies)
    if (recorded.intent.status === "completed") {
        return { durable: true, created: false, completed: true }
    }

    const dispatched = await dispatchNotificationIntent({
        businessId: recorded.intent.businessId,
        intentId: String(recorded.intent._id),
        env: dependencies.env || process.env,
    }, dependencies)
    return { created: recorded.created, intentId: String(recorded.intent._id), ...dispatched }
}

export async function scanNotificationIntentRepairs({
    now = new Date(),
    batchSize = NOTIFICATION_REPAIR_BATCH_SIZE,
    maxBatches = 20,
    env = process.env,
}, {
    NotificationIntentModel = NotificationIntent,
    enqueue = enqueueNotificationIntent,
    claimLeaseMs = NOTIFICATION_INTENT_CLAIM_LEASE_MS,
} = {}) {
    const staleBefore = new Date(now.getTime() - claimLeaseMs)
    const summary = { candidates: 0, queued: 0, failed: 0, batches: 0 }
    let lastId = null

    for (let batch = 0; batch < maxBatches; batch += 1) {
        const filter = {
            expiresAt: { $gt: now },
            $or: [
                { status: { $in: ["pending", "failed"] } },
                { status: "processing", claimedAt: { $lte: staleBefore } },
            ],
            ...(lastId ? { _id: { $gt: lastId } } : {}),
        }
        const query = NotificationIntentModel.find(filter)
            .sort({ _id: 1 })
            .limit(batchSize)
            .select("_id businessId")
        const intents = await lean(query)
        if (!intents?.length) break

        summary.batches += 1
        summary.candidates += intents.length
        for (const intent of intents) {
            try {
                const result = await enqueue({
                    businessId: intent.businessId,
                    intentId: String(intent._id),
                }, { env, repair: true })
                if (result.queued) {
                    summary.queued += 1
                    await NotificationIntentModel.updateOne({
                        _id: intent._id,
                        businessId: intent.businessId,
                    }, { $set: { enqueuedAt: now, enqueueError: null } })
                } else {
                    summary.failed += 1
                }
            } catch (error) {
                summary.failed += 1
                await NotificationIntentModel.updateOne({
                    _id: intent._id,
                    businessId: intent.businessId,
                }, { $set: { enqueueError: safeErrorReason(error) } }).catch(() => {})
            }
        }
        lastId = intents.at(-1)._id
        if (intents.length < batchSize) break
    }

    return summary
}
