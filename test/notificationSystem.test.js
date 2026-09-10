import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import Notification from "../src/models/Notification.js"
import NotificationIntent from "../src/models/NotificationIntent.js"
import {
    NOTIFICATION_RETENTION_MS,
    NOTIFICATION_TYPES,
} from "../src/constants/notifications.js"
import { MANAGEMENT_ACCESS_AREAS } from "../src/constants/managementAccess.js"
import { PERMISSIONS } from "../src/constants/permissions.js"
import { prepareNotificationEvent } from "../src/services/notificationEventRegistry.js"
import { resolveNotificationRecipients } from "../src/services/notificationRecipientService.js"
import {
    NotificationReadError,
    getAccessibleNotificationTypes,
    listNotifications,
    markAllNotificationsRead,
    markNotificationRead,
    resolveNotificationAccessContext,
} from "../src/services/notificationReadService.js"
import {
    buildNotificationIdempotencyKey,
    processNotificationIntent,
    recordNotificationIntent,
} from "../src/services/notificationService.js"
import {
    NOTIFICATION_JOB_OPTIONS,
    buildNotificationIntentJobId,
    enqueueNotificationIntent,
} from "../src/queues/notificationQueue.js"
import { NOTIFICATION_JOB_NAMES, QUEUE_NAMES } from "../src/queues/queueNames.js"
import { processNotificationJob } from "../src/workers/processors/notificationProcessor.js"
import {
    NOTIFICATION_REPAIR_SCHEDULER_ID,
    registerWorkerSchedulers,
} from "../src/workers/registerSchedulers.js"
import { getWorkerDefinitions } from "../src/workers/workerRuntime.js"
import {
    NOTIFICATION_CHANGED_EVENT,
    broadcastLocal,
    notificationSseHandler,
} from "../src/utils/sseManager.js"

const OWNER_ID = "507f1f77bcf86cd799439011"
const CO_OWNER_ID = "507f1f77bcf86cd799439012"
const MANAGER_ID = "507f1f77bcf86cd799439013"
const OTHER_MANAGER_ID = "507f1f77bcf86cd799439014"
const INTENT_ID = "507f1f77bcf86cd799439020"
const NOTICE_A_ID = "507f1f77bcf86cd799439021"
const NOTICE_B_ID = "507f1f77bcf86cd799439022"

function queryResult(value) {
    return {
        select() { return this },
        sort() { return this },
        limit() { return this },
        session() { return this },
        async lean() { return value },
    }
}

function findIndex(indexes, expected) {
    return indexes.find(([fields]) => JSON.stringify(fields) === JSON.stringify(expected))
}

test("notification schemas enforce recipient uniqueness and 30-day TTL retention", () => {
    const notificationIndexes = Notification.schema.indexes()
    const unique = findIndex(notificationIndexes, {
        businessId: 1,
        recipientKind: 1,
        recipientId: 1,
        idempotencyKey: 1,
    })
    const ttl = findIndex(notificationIndexes, { expiresAt: 1 })
    const intentUnique = findIndex(NotificationIntent.schema.indexes(), {
        businessId: 1,
        idempotencyKey: 1,
    })

    assert.equal(unique?.[1]?.unique, true)
    assert.equal(ttl?.[1]?.expireAfterSeconds, 0)
    assert.equal(intentUnique?.[1]?.unique, true)
    assert.equal(NOTIFICATION_RETENTION_MS, 30 * 24 * 60 * 60 * 1000)
})

test("event registry supports only locked v1 events and allowlists metadata", () => {
    const arrival = prepareNotificationEvent({
        type: NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED,
        facts: {
            guestName: "Sarah Johnson",
            partySize: 4,
            reservationTime: "7:30 PM",
            servicePointDisplayName: "Table 12",
            email: "must-not-be-persisted@example.com",
            token: "must-not-be-persisted",
        },
    })
    assert.equal(arrival.title, "Sarah Johnson has arrived")
    assert.equal(arrival.message, "Reservation for 4 · 7:30 PM · Table 12")
    assert.deepEqual(arrival.metadata, {
        partySize: 4,
        reservationTime: "7:30 PM",
        servicePointDisplayName: "Table 12",
    })
    assert.equal("email" in arrival.metadata, false)
    assert.equal("token" in arrival.metadata, false)

    assert.throws(() => prepareNotificationEvent({
        type: NOTIFICATION_TYPES.FEEDBACK_LOW_RATING_RECEIVED,
        facts: { rating: 3 },
    }), /1 through 2/)
    assert.throws(() => prepareNotificationEvent({
        type: "order.created",
        facts: {},
    }), /Unsupported notification type/)
})

test("recipient resolution freezes only active eligible accounts", async () => {
    const BusinessModel = {
        findOne(filter) {
            assert.deepEqual(filter, { businessId: "biz_alpha" })
            return queryResult({
                _id: OWNER_ID,
                businessId: "biz_alpha",
                ownerStatus: "active",
            })
        },
    }
    const StaffModel = {
        find(filter) {
            assert.equal(filter.businessId, "biz_alpha")
            assert.equal(filter.accountStatus, "active")
            return queryResult([
                {
                    _id: CO_OWNER_ID,
                    role: "co_owner",
                    accountStatus: "active",
                    coOwnerRestrictions: [],
                },
                {
                    _id: MANAGER_ID,
                    role: "manager",
                    accountStatus: "active",
                    permissions: [PERMISSIONS.RESERVATIONS_VIEW],
                },
                {
                    _id: OTHER_MANAGER_ID,
                    role: "manager",
                    accountStatus: "active",
                    permissions: [PERMISSIONS.FEEDBACK_VIEW],
                },
            ])
        },
    }

    const recipients = await resolveNotificationRecipients({
        businessId: "biz_alpha",
        requiredAccessArea: MANAGEMENT_ACCESS_AREAS.RESERVATIONS,
        managerPermissions: [PERMISSIONS.RESERVATIONS_VIEW],
        managersEligible: true,
    }, { BusinessModel, StaffModel })
    assert.deepEqual(recipients.map((item) => String(item.recipientId)), [
        OWNER_ID,
        CO_OWNER_ID,
        MANAGER_ID,
    ])

    const financial = await resolveNotificationRecipients({
        businessId: "biz_alpha",
        requiredAccessArea: MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING,
        managerPermissions: [],
        managersEligible: false,
    }, { BusinessModel, StaffModel })
    assert.deepEqual(financial.map((item) => String(item.recipientId)), [
        OWNER_ID,
        CO_OWNER_ID,
    ])
})

function createIntentModel() {
    let intent = null
    return {
        get intent() { return intent },
        findOne(filter) {
            const matches = intent &&
                String(intent._id) === String(filter._id || intent._id) &&
                intent.businessId === filter.businessId &&
                (!filter.idempotencyKey || intent.idempotencyKey === filter.idempotencyKey)
            return queryResult(matches ? structuredClone(intent) : null)
        },
        findOneAndUpdate(filter, update, options = {}) {
            if (options.upsert) {
                if (!intent) intent = { _id: INTENT_ID, ...structuredClone(update.$setOnInsert) }
                return queryResult(structuredClone(intent))
            }
            if (!intent || String(intent._id) !== String(filter._id) ||
                intent.businessId !== filter.businessId ||
                !["pending", "failed"].includes(intent.status)) {
                return queryResult(null)
            }
            intent = {
                ...intent,
                ...structuredClone(update.$set),
                attemptCount: intent.attemptCount + update.$inc.attemptCount,
            }
            return queryResult(structuredClone(intent))
        },
        async updateOne(filter, update) {
            if (intent && String(intent._id) === String(filter._id) &&
                intent.businessId === filter.businessId) {
                intent = { ...intent, ...structuredClone(update.$set) }
                return { matchedCount: 1, modifiedCount: 1 }
            }
            return { matchedCount: 0, modifiedCount: 0 }
        },
    }
}

function createNotificationModel() {
    const records = new Map()
    return {
        records,
        async bulkWrite(operations) {
            let upsertedCount = 0
            for (const operation of operations) {
                const value = structuredClone(operation.updateOne.update.$setOnInsert)
                const key = [
                    value.businessId,
                    value.recipientKind,
                    String(value.recipientId),
                    value.idempotencyKey,
                ].join("|")
                if (!records.has(key)) {
                    records.set(key, value)
                    upsertedCount += 1
                }
            }
            return { upsertedCount }
        },
    }
}

test("durable intent creation snapshots recipients and processing is idempotent", async () => {
    const NotificationIntentModel = createIntentModel()
    const NotificationModel = createNotificationModel()
    const invalidations = []
    let recipientResolutions = 0
    const event = {
        businessId: "biz_alpha",
        type: NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED,
        entityId: "reservation-1",
        occurredAt: "2026-09-08T18:00:00.000Z",
        idempotencyKey: buildNotificationIdempotencyKey({
            type: NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED,
            entityId: "reservation-1",
            occurrenceId: "arrival-transition-v1",
        }),
        facts: {
            guestName: "Sarah Johnson",
            partySize: 4,
            reservationTime: "7:30 PM",
        },
    }
    const dependencies = {
        NotificationIntentModel,
        recipientResolver: async () => {
            recipientResolutions += 1
            return [
                { recipientKind: "owner", recipientId: OWNER_ID, role: "owner" },
                { recipientKind: "staff", recipientId: MANAGER_ID, role: "manager" },
            ]
        },
        now: new Date("2026-09-08T18:00:00.000Z"),
    }

    const first = await recordNotificationIntent(event, dependencies)
    const duplicate = await recordNotificationIntent(event, dependencies)
    assert.equal(first.created, true)
    assert.equal(duplicate.created, false)
    assert.equal(recipientResolutions, 1)
    assert.equal(first.intent.recipients.length, 2)
    await assert.rejects(
        recordNotificationIntent({ ...event, entityId: "reservation-2" }, dependencies),
        (error) => error.statusCode === 409 &&
            error.code === "NOTIFICATION_IDEMPOTENCY_CONFLICT",
    )

    const processed = await processNotificationIntent({
        businessId: "biz_alpha",
        intentId: INTENT_ID,
        now: new Date("2026-09-08T18:00:01.000Z"),
    }, {
        NotificationIntentModel,
        NotificationModel,
        publishChange: async (value) => invalidations.push(value),
    })
    const retried = await processNotificationIntent({
        businessId: "biz_alpha",
        intentId: INTENT_ID,
        now: new Date("2026-09-08T18:00:02.000Z"),
    }, {
        NotificationIntentModel,
        NotificationModel,
        publishChange: async (value) => invalidations.push(value),
    })

    assert.equal(processed.completed, true)
    assert.equal(processed.upsertedCount, 2)
    assert.equal(NotificationModel.records.size, 2)
    assert.equal(invalidations.length, 1)
    assert.deepEqual(invalidations[0].recipients, first.intent.recipients)
    assert.deepEqual(retried, { skipped: true, reason: "intent_completed" })
})

test("notification SSE is authenticated, recipient-scoped, and content-free", async () => {
    const writes = []
    let closeHandler = null
    let ended = false
    const req = {
        on(event, handler) {
            if (event === "close") closeHandler = handler
        },
    }
    const res = {
        setHeader() {},
        flushHeaders() {},
        write(value) { writes.push(value) },
        end() { ended = true },
        status() { return this },
    }

    await notificationSseHandler(req, res, {
        resolveAccess: async () => ({
            businessId: "biz_alpha",
            recipientKind: "staff",
            recipientId: MANAGER_ID,
            user: { role: "manager", permissions: [PERMISSIONS.RESERVATIONS_VIEW] },
        }),
        revalidateClient: async () => true,
    })
    const heartbeatWrites = writes.length

    await broadcastLocal({
        event: NOTIFICATION_CHANGED_EVENT,
        businessId: "biz_alpha",
        targets: ["notifications"],
        recipientTargets: [{ recipientKind: "staff", recipientId: OTHER_MANAGER_ID }],
        notificationAccess: {
            area: MANAGEMENT_ACCESS_AREAS.RESERVATIONS,
            permission: PERMISSIONS.RESERVATIONS_VIEW,
        },
        payload: { invalidated: true, title: "must not leak", email: "private@example.com" },
    })
    assert.equal(writes.length, heartbeatWrites)

    await broadcastLocal({
        event: NOTIFICATION_CHANGED_EVENT,
        businessId: "biz_alpha",
        targets: ["notifications"],
        recipientTargets: [{ recipientKind: "staff", recipientId: MANAGER_ID }],
        notificationAccess: {
            area: MANAGEMENT_ACCESS_AREAS.RESERVATIONS,
            permission: PERMISSIONS.RESERVATIONS_VIEW,
        },
        payload: { invalidated: true, title: "must not leak", email: "private@example.com" },
    })
    const delivered = writes.at(-1)
    assert.match(delivered, /event: notification_changed/)
    assert.match(delivered, /"invalidated":true/)
    assert.doesNotMatch(delivered, /must not leak|private@example\.com/)

    closeHandler?.()
    assert.equal(ended, false)
})

test("reservation notification deep-link lookup remains tenant scoped and fails closed", async () => {
    const controller = await readFile(
        new URL("../src/controllers/reservationController.js", import.meta.url),
        "utf8",
    )
    assert.match(controller, /if \(reservationId\)/)
    assert.match(controller, /mongoose\.isValidObjectId\(reservationId\)/)
    assert.match(controller, /\.\.\.baseQuery,[\s\S]*_id: reservationId/)
    assert.match(controller, /Reservation not found/)
})

test("notification list queries are always tenant and recipient scoped", async () => {
    let capturedFilter
    const context = {
        businessId: "biz_alpha",
        recipientKind: "staff",
        recipientId: MANAGER_ID,
        user: { role: "manager", permissions: [PERMISSIONS.RESERVATIONS_VIEW] },
    }
    const NotificationModel = {
        find(filter) {
            capturedFilter = filter
            return queryResult([])
        },
    }
    await listNotifications({ context, limit: 20 }, { NotificationModel })

    assert.equal(capturedFilter.businessId, "biz_alpha")
    assert.equal(capturedFilter.recipientKind, "staff")
    assert.equal(String(capturedFilter.recipientId), MANAGER_ID)
    assert.deepEqual(capturedFilter.type.$in, [
        NOTIFICATION_TYPES.RESERVATION_EXTERNAL_CREATED,
        NOTIFICATION_TYPES.RESERVATION_GUEST_CANCELLED,
        NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED,
    ])
    assert.equal("businessId" in context.user, false)
})

test("notification list uses stable cursor pagination bound to the recipient", async () => {
    const context = {
        businessId: "biz_alpha",
        recipientKind: "owner",
        recipientId: OWNER_ID,
        user: { role: "owner" },
    }
    const rows = [NOTICE_A_ID, NOTICE_B_ID].map((id, index) => ({
        _id: id,
        type: NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED,
        category: "reservations",
        title: "Guest has arrived",
        message: "Reservation for 2 · 7:30 PM",
        severity: "info",
        entityType: "reservation",
        entityId: `reservation-${index + 1}`,
        occurredAt: new Date(`2026-09-08T18:0${index}:00.000Z`),
        createdAt: new Date(`2026-09-08T18:0${index}:00.000Z`),
        readAt: null,
        metadata: {},
    }))
    const NotificationModel = { find: () => queryResult(rows) }
    const firstPage = await listNotifications({
        context,
        limit: 1,
        now: new Date("2026-09-08T18:10:00.000Z"),
    }, { NotificationModel })
    assert.equal(firstPage.notifications.length, 1)
    assert.equal(firstPage.pagination.hasNextPage, true)
    assert.ok(firstPage.pagination.nextCursor)

    await assert.rejects(
        listNotifications({
            context: { ...context, recipientId: CO_OWNER_ID },
            cursor: firstPage.pagination.nextCursor,
        }, { NotificationModel }),
        (error) => error instanceof NotificationReadError && /cursor/.test(error.message),
    )
})

test("permission revocation immediately hides previously addressed notifications", () => {
    const before = getAccessibleNotificationTypes({
        role: "manager",
        permissions: [PERMISSIONS.RESERVATIONS_VIEW],
    })
    const after = getAccessibleNotificationTypes({
        role: "manager",
        permissions: [PERMISSIONS.FEEDBACK_VIEW],
    })
    assert.equal(before.includes(NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED), true)
    assert.equal(after.includes(NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED), false)
    assert.equal(after.includes(NOTIFICATION_TYPES.FEEDBACK_LOW_RATING_RECEIVED), true)
    assert.equal(after.includes(NOTIFICATION_TYPES.BILLING_INVOICE_PAYMENT_FAILED), false)
})

test("access context ignores stale session permissions and uses current staff state", async () => {
    const req = {
        session: {
            user: {
                role: "manager",
                businessId: "biz_alpha",
                staffObjectId: MANAGER_ID,
                permissions: [PERMISSIONS.RESERVATIONS_VIEW],
            },
        },
    }
    const context = await resolveNotificationAccessContext(req, {
        resolveManager: async () => ({
            _id: MANAGER_ID,
            businessId: "biz_alpha",
            role: "manager",
            accountStatus: "active",
            permissions: [PERMISSIONS.FEEDBACK_VIEW],
        }),
    })
    const currentTypes = getAccessibleNotificationTypes(context.user)
    assert.equal(currentTypes.includes(NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED), false)
    assert.equal(currentTypes.includes(NOTIFICATION_TYPES.FEEDBACK_LOW_RATING_RECEIVED), true)
})

function matchesScope(record, filter) {
    return String(record._id) === String(filter._id) &&
        record.businessId === filter.businessId &&
        record.recipientKind === filter.recipientKind &&
        String(record.recipientId) === String(filter.recipientId) &&
        filter.type.$in.includes(record.type)
}

test("read state is independent and cannot cross recipient or business boundaries", async () => {
    const records = [
        {
            _id: NOTICE_A_ID,
            businessId: "biz_alpha",
            recipientKind: "staff",
            recipientId: MANAGER_ID,
            type: NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED,
            category: "reservations",
            title: "Sarah has arrived",
            message: "Reservation for 4 · 7:30 PM",
            severity: "info",
            entityType: "reservation",
            entityId: "reservation-1",
            occurredAt: new Date("2026-09-08T18:00:00.000Z"),
            createdAt: new Date("2026-09-08T18:00:00.000Z"),
            readAt: null,
            metadata: {},
        },
        {
            _id: NOTICE_B_ID,
            businessId: "biz_alpha",
            recipientKind: "staff",
            recipientId: OTHER_MANAGER_ID,
            type: NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED,
            readAt: null,
        },
    ]
    const NotificationModel = {
        findOne(filter) {
            return queryResult(records.find((record) => matchesScope(record, filter)) || null)
        },
        findOneAndUpdate(filter, update) {
            const record = records.find((item) => matchesScope(item, filter) && !item.readAt)
            if (record) record.readAt = update.$set.readAt
            return queryResult(record || null)
        },
    }
    const context = {
        businessId: "biz_alpha",
        recipientKind: "staff",
        recipientId: MANAGER_ID,
        user: { role: "manager", permissions: [PERMISSIONS.RESERVATIONS_VIEW] },
    }
    const result = await markNotificationRead({
        context,
        notificationId: NOTICE_A_ID,
        now: new Date("2026-09-08T18:05:00.000Z"),
    }, { NotificationModel })
    assert.equal(result.notification.read, true)
    assert.equal(records[1].readAt, null)

    await assert.rejects(
        markNotificationRead({ context, notificationId: NOTICE_B_ID }, { NotificationModel }),
        (error) => error instanceof NotificationReadError && error.statusCode === 404,
    )
    await assert.rejects(
        markNotificationRead({
            context: { ...context, businessId: "biz_other" },
            notificationId: NOTICE_A_ID,
        }, { NotificationModel }),
        (error) => error instanceof NotificationReadError && error.statusCode === 404,
    )
})

test("invalid IDs fail safely and mark-all uses an explicit non-future cutoff", async () => {
    const context = {
        businessId: "biz_alpha",
        recipientKind: "owner",
        recipientId: OWNER_ID,
        user: { role: "owner" },
    }
    await assert.rejects(
        markNotificationRead({ context, notificationId: "not-an-object-id" }),
        (error) => error instanceof NotificationReadError && error.statusCode === 400,
    )

    let updateFilter
    const result = await markAllNotificationsRead({
        context,
        readThrough: "2026-09-08T18:00:00.000Z",
        now: new Date("2026-09-08T18:01:00.000Z"),
    }, {
        NotificationModel: {
            async updateMany(filter) {
                updateFilter = filter
                return { modifiedCount: 3 }
            },
        },
    })
    assert.equal(result.markedReadCount, 3)
    assert.deepEqual(updateFilter.createdAt, {
        $lte: new Date("2026-09-08T18:00:00.000Z"),
    })
    await assert.rejects(
        markAllNotificationsRead({
            context,
            readThrough: "2026-09-08T18:02:00.000Z",
            now: new Date("2026-09-08T18:01:00.000Z"),
        }),
        /cannot be in the future/,
    )
})

test("notification BullMQ jobs use stable IDs, retries, worker, and repair scheduler", async () => {
    const payload = { businessId: "biz:alpha", intentId: INTENT_ID }
    const added = []
    const queued = await enqueueNotificationIntent(payload, {
        env: { BULLMQ_NOTIFICATIONS_ENABLED: "true" },
        queue: {
            async add(name, data, options) {
                added.push({ name, data, options })
                return { id: options.jobId }
            },
        },
    })
    assert.equal(
        queued.jobId,
        buildNotificationIntentJobId(payload),
    )
    assert.equal(added[0].name, NOTIFICATION_JOB_NAMES.PROCESS_INTENT)
    assert.equal(added[0].options.attempts, 8)
    assert.deepEqual(added[0].options.backoff, NOTIFICATION_JOB_OPTIONS.backoff)

    const processed = await processNotificationJob({
        name: NOTIFICATION_JOB_NAMES.PROCESS_INTENT,
        data: payload,
    }, { processIntent: async (data) => ({ completed: true, ...data }) })
    assert.equal(processed.completed, true)

    const registrations = []
    const schedulerResult = await registerWorkerSchedulers({
        runtime: "worker",
        env: { BULLMQ_NOTIFICATIONS_ENABLED: "true" },
        createQueueFn: () => ({
            async upsertJobScheduler(id, repeat, job) {
                registrations.push({ id, repeat, job })
            },
        }),
    })
    assert.equal(schedulerResult.notifications, true)
    assert.equal(registrations[0].id, NOTIFICATION_REPAIR_SCHEDULER_ID)
    assert.equal(registrations[0].job.name, NOTIFICATION_JOB_NAMES.REPAIR_SCAN)

    const worker = getWorkerDefinitions({ BULLMQ_NOTIFICATIONS_ENABLED: "true" })
        .find((definition) => definition.queueName === QUEUE_NAMES.NOTIFICATIONS)
    assert.equal(worker.enabledForEnvironment, true)
    assert.equal(worker.concurrency, 2)
})
