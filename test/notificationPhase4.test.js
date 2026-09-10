import assert from "node:assert/strict"
import test from "node:test"

import { NOTIFICATION_TYPES } from "../src/constants/notifications.js"
import { INVENTORY_MOVEMENT_TYPES } from "../src/constants/inventory.js"
import { PERMISSIONS } from "../src/constants/permissions.js"
import { submitFeedback } from "../src/controllers/feedbackController.js"
import { transitionOrderFulfillment } from "../src/services/orderFulfillmentService.js"
import {
    classifyFeedbackSentiment,
    isLowFeedbackRating,
} from "../src/services/feedbackRatingService.js"
import { notifyLowRatingFeedback } from "../src/services/feedbackNotificationService.js"
import {
    createInventoryStockTransitionNotifications,
    resolveInventoryStockTransition,
} from "../src/services/inventoryNotificationService.js"
import { safelyNotifyInventoryStockTransitions } from "../src/services/inventoryNotificationIntegrationService.js"
import {
    INVENTORY_STOCK_STATUSES,
    resolveInventoryStockStatus,
} from "../src/services/inventoryStockStatusService.js"
import { prepareNotificationEvent } from "../src/services/notificationEventRegistry.js"
import { resolveNotificationRecipients } from "../src/services/notificationRecipientService.js"

function queryResult(value) {
    return {
        select() { return this },
        session() { return this },
        async lean() { return value },
    }
}

function responseRecorder() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code
            return this
        },
        json(value) {
            this.body = value
            return this
        },
    }
}

function feedbackRequest(overallRating = 2) {
    return {
        body: {
            orderId: "order-1",
            businessId: "biz-alpha",
            overallRating,
            tags: ["service"],
            comment: "Bounded feedback",
            wouldRecommend: false,
            sessionId: "guest-session-1",
        },
    }
}

function feedbackDependencies({
    createError = null,
    notify = async () => {},
} = {}) {
    const calls = { created: [], updated: [], notified: [] }
    const OrderModel = {
        findOne(filter) {
            assert.deepEqual(filter, { orderId: "order-1", businessId: "biz-alpha" })
            return queryResult({
                _id: "order-object-1",
                orderId: "order-1",
                businessId: "biz-alpha",
                sessionId: "guest-session-1",
                status: "completed",
                orderType: "dine-in",
                servicePointLabel: "Table 12",
                total: 42.5,
            })
        },
        async updateOne(filter, update) {
            calls.updated.push({ filter, update })
            return { matchedCount: 1, modifiedCount: 1 }
        },
    }
    const FeedbackModel = {
        async create(value) {
            calls.created.push(value)
            if (createError) throw createError
            return {
                _id: "feedback-1",
                createdAt: new Date("2026-09-08T12:00:00.000Z"),
                ...value,
            }
        },
    }
    return {
        calls,
        dependencies: {
            FeedbackModel,
            OrderModel,
            notifyLowRating: async (value) => {
                calls.notified.push(value)
                return notify(value)
            },
        },
    }
}

test("canonical Feedback low-rating semantics are 1-2 stars", () => {
    assert.equal(isLowFeedbackRating(1), true)
    assert.equal(isLowFeedbackRating(2), true)
    assert.equal(isLowFeedbackRating(1.5), true)
    assert.equal(isLowFeedbackRating(3), false)
    assert.equal(classifyFeedbackSentiment(2), "negative")
    assert.equal(classifyFeedbackSentiment(3), "neutral")
    assert.equal(classifyFeedbackSentiment(4), "positive")
})

test("qualifying persisted customer feedback creates exactly one notification attempt", async () => {
    const { calls, dependencies } = feedbackDependencies()
    const res = responseRecorder()
    await submitFeedback(feedbackRequest(2), res, dependencies)

    assert.equal(res.statusCode, 201)
    assert.equal(calls.created.length, 1)
    assert.equal(calls.updated.length, 1)
    assert.equal(calls.notified.length, 1)
    assert.equal(calls.notified[0].feedback._id, "feedback-1")
    assert.equal(calls.notified[0].feedback.businessId, "biz-alpha")
})

test("non-low, failed, and duplicate Feedback submissions do not notify", async () => {
    const high = feedbackDependencies()
    const highResponse = responseRecorder()
    await submitFeedback(feedbackRequest(3), highResponse, high.dependencies)
    assert.equal(highResponse.statusCode, 201)
    assert.equal(high.calls.notified.length, 0)

    const failed = feedbackDependencies({ createError: new Error("database unavailable") })
    const failedResponse = responseRecorder()
    await submitFeedback(feedbackRequest(1), failedResponse, failed.dependencies)
    assert.equal(failedResponse.statusCode, 500)
    assert.equal(failed.calls.notified.length, 0)

    const duplicateError = Object.assign(new Error("duplicate"), { code: 11000 })
    const duplicate = feedbackDependencies({ createError: duplicateError })
    const duplicateResponse = responseRecorder()
    await submitFeedback(feedbackRequest(1), duplicateResponse, duplicate.dependencies)
    assert.equal(duplicateResponse.statusCode, 409)
    assert.equal(duplicate.calls.notified.length, 0)
})

test("notification failure does not change a successful Feedback response", async () => {
    const originalError = console.error
    console.error = () => {}
    try {
        const { calls, dependencies } = feedbackDependencies({
            notify: async () => { throw new Error("notification unavailable") },
        })
        const res = responseRecorder()
        await submitFeedback(feedbackRequest(1), res, dependencies)
        assert.equal(res.statusCode, 201)
        assert.equal(calls.updated.length, 1)
        assert.equal(calls.notified.length, 1)
    } finally {
        console.error = originalError
    }
})

test("Feedback notification uses the persisted record identity and stable occurrence", async () => {
    const captured = []
    const feedback = {
        _id: "feedback-42",
        businessId: "biz-alpha",
        overallRating: 2,
        servicePointId: "Table 7",
        createdAt: new Date("2026-09-08T12:00:00.000Z"),
    }
    await notifyLowRatingFeedback({ feedback }, {
        createEvent: async (event) => {
            captured.push(event)
            return { created: true }
        },
    })
    await notifyLowRatingFeedback({ feedback }, {
        createEvent: async (event) => {
            captured.push(event)
            return { created: false }
        },
    })
    await notifyLowRatingFeedback({ feedback: { ...feedback, overallRating: 4 } }, {
        createEvent: async () => { throw new Error("must not run") },
    })

    assert.equal(captured.length, 2)
    assert.equal(captured[0].type, NOTIFICATION_TYPES.FEEDBACK_LOW_RATING_RECEIVED)
    assert.equal(captured[0].businessId, "biz-alpha")
    assert.equal(captured[0].entityId, "feedback-42")
    assert.equal(
        captured[0].idempotencyKey,
        "feedback.low_rating_received:feedback-42:created-v1",
    )
    assert.equal(captured[1].idempotencyKey, captured[0].idempotencyKey)
    assert.deepEqual(captured[0].facts, {
        rating: 2,
        servicePointDisplayName: "Table 7",
    })
})

function stockItem(overrides = {}) {
    return {
        inventoryItemId: "inv-chicken",
        businessId: "biz-alpha",
        name: "Chicken",
        trackingUnit: "g",
        lowStockThreshold: 4,
        ...overrides,
    }
}

function movement({
    movementId,
    type,
    onHandBefore,
    reservedBefore = 0,
    onHandAfter,
    reservedAfter = 0,
}) {
    return {
        movementId,
        businessId: "biz-alpha",
        inventoryItemId: "inv-chicken",
        type,
        onHandBefore,
        reservedBefore,
        onHandAfter,
        reservedAfter,
        createdAt: new Date("2026-09-08T13:00:00.000Z"),
    }
}

test("canonical Inventory stock status uses Available = OnHand - Reserved at exact boundaries", () => {
    assert.deepEqual(resolveInventoryStockStatus({
        onHandQuantity: 10,
        reservedQuantity: 5,
        lowStockThreshold: 4,
    }), { status: INVENTORY_STOCK_STATUSES.HEALTHY, availableQuantity: 5 })
    assert.deepEqual(resolveInventoryStockStatus({
        onHandQuantity: 10,
        reservedQuantity: 6,
        lowStockThreshold: 4,
    }), { status: INVENTORY_STOCK_STATUSES.LOW_STOCK, availableQuantity: 4 })
    assert.deepEqual(resolveInventoryStockStatus({
        onHandQuantity: 10,
        reservedQuantity: 10,
        lowStockThreshold: 4,
    }), { status: INVENTORY_STOCK_STATUSES.OUT_OF_STOCK, availableQuantity: 0 })
})

test("Inventory state-entry matrix emits only the state actually entered", () => {
    const item = stockItem()
    const cases = [
        ["healthy-low", 10, 0, 4, 0, NOTIFICATION_TYPES.INVENTORY_LOW_STOCK_ENTERED],
        ["low-low", 4, 0, 3, 0, null],
        ["low-out", 1, 0, 0, 0, NOTIFICATION_TYPES.INVENTORY_OUT_OF_STOCK_ENTERED],
        ["out-out", 0, 0, 1, 1, null],
        ["out-healthy", 0, 0, 10, 0, null],
        ["out-low", 0, 0, 4, 0, null],
        ["low-healthy", 4, 0, 5, 0, null],
        ["healthy-out", 10, 0, 0, 0, NOTIFICATION_TYPES.INVENTORY_OUT_OF_STOCK_ENTERED],
    ]
    for (const [id, onHandBefore, reservedBefore, onHandAfter, reservedAfter, expected] of cases) {
        const transition = resolveInventoryStockTransition({
            item,
            movement: movement({
                movementId: id,
                type: INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_DECREASE,
                onHandBefore,
                reservedBefore,
                onHandAfter,
                reservedAfter,
            }),
        })
        assert.equal(transition?.type || null, expected, id)
    }
})

test("inventory movement paths cover waste, adjustment, Simple Stock, reservation, ingredient, receive, and release semantics", async () => {
    const captured = []
    const movements = [
        movement({
            movementId: "waste-healthy-low",
            type: INVENTORY_MOVEMENT_TYPES.WASTE,
            onHandBefore: 10,
            onHandAfter: 4,
        }),
        movement({
            movementId: "adjust-low-low",
            type: INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_DECREASE,
            onHandBefore: 4,
            onHandAfter: 3,
        }),
        movement({
            movementId: "simple-low-out",
            type: INVENTORY_MOVEMENT_TYPES.LEGACY_ORDER_DEDUCTION,
            onHandBefore: 1,
            onHandAfter: 0,
        }),
        movement({
            movementId: "reservation-healthy-low",
            type: INVENTORY_MOVEMENT_TYPES.RESERVE,
            onHandBefore: 10,
            reservedBefore: 0,
            onHandAfter: 10,
            reservedAfter: 6,
        }),
        movement({
            movementId: "ingredient-low-out",
            type: INVENTORY_MOVEMENT_TYPES.CONSUME,
            onHandBefore: 1,
            onHandAfter: 0,
        }),
        movement({
            movementId: "receive-out-healthy",
            type: INVENTORY_MOVEMENT_TYPES.RECEIVE,
            onHandBefore: 0,
            onHandAfter: 10,
        }),
        movement({
            movementId: "release-out-healthy",
            type: INVENTORY_MOVEMENT_TYPES.RELEASE,
            onHandBefore: 10,
            reservedBefore: 10,
            onHandAfter: 10,
            reservedAfter: 0,
        }),
    ]

    const summary = await createInventoryStockTransitionNotifications({
        businessId: "biz-alpha",
        movements,
        inventoryItems: [stockItem()],
    }, {
        createEvent: async (event) => {
            captured.push(event)
            return { created: true }
        },
    })

    assert.equal(summary.attempted, 4)
    assert.equal(summary.created, 4)
    assert.deepEqual(captured.map((event) => event.type), [
        NOTIFICATION_TYPES.INVENTORY_LOW_STOCK_ENTERED,
        NOTIFICATION_TYPES.INVENTORY_OUT_OF_STOCK_ENTERED,
        NOTIFICATION_TYPES.INVENTORY_LOW_STOCK_ENTERED,
        NOTIFICATION_TYPES.INVENTORY_OUT_OF_STOCK_ENTERED,
    ])
    assert.equal(captured[2].facts.availableQuantity, 4)
    assert.equal(captured[2].entityId, "inv-chicken")
    assert.match(captured[2].idempotencyKey, /reservation-healthy-low$/)
})

test("recovery permits a later genuine re-entry with a distinct movement identity", async () => {
    const captured = []
    await createInventoryStockTransitionNotifications({
        businessId: "biz-alpha",
        inventoryItems: [stockItem()],
        movements: [
            movement({
                movementId: "entry-1",
                type: INVENTORY_MOVEMENT_TYPES.WASTE,
                onHandBefore: 6,
                onHandAfter: 4,
            }),
            movement({
                movementId: "recovery",
                type: INVENTORY_MOVEMENT_TYPES.RECEIVE,
                onHandBefore: 4,
                onHandAfter: 8,
            }),
            movement({
                movementId: "entry-2",
                type: INVENTORY_MOVEMENT_TYPES.CONSUME,
                onHandBefore: 8,
                onHandAfter: 4,
            }),
        ],
    }, {
        createEvent: async (event) => {
            captured.push(event)
            return { created: true }
        },
    })

    assert.equal(captured.length, 2)
    assert.notEqual(captured[0].idempotencyKey, captured[1].idempotencyKey)
    assert.match(captured[0].idempotencyKey, /entry-1$/)
    assert.match(captured[1].idempotencyKey, /entry-2$/)
})

test("inventory transition dispatch fails closed on cross-tenant movement input", async () => {
    let calls = 0
    const summary = await createInventoryStockTransitionNotifications({
        businessId: "biz-alpha",
        inventoryItems: [stockItem()],
        movements: [{
            ...movement({
                movementId: "cross-tenant-entry",
                type: INVENTORY_MOVEMENT_TYPES.WASTE,
                onHandBefore: 10,
                onHandAfter: 4,
            }),
            businessId: "biz-other",
        }],
    }, {
        createEvent: async () => { calls += 1 },
    })

    assert.equal(calls, 0)
    assert.equal(summary.skipped, 1)
})

test("inventory notification failures are isolated from the completed mutation", async () => {
    const logs = []
    const result = await safelyNotifyInventoryStockTransitions({
        businessId: "biz-alpha",
        movements: [movement({
            movementId: "failure-isolated",
            type: INVENTORY_MOVEMENT_TYPES.WASTE,
            onHandBefore: 10,
            onHandAfter: 4,
        })],
        inventoryItems: [stockItem()],
    }, {
        notify: async () => { throw new Error("notification unavailable") },
        logger: { error: (...args) => logs.push(args) },
    })

    assert.equal(result.failed, 1)
    assert.equal(logs.length, 1)
})

test("fulfilment commits inventory before notification and remains successful when notification fails", async () => {
    const sequence = []
    let availableQuantity = 10
    const order = {
        orderId: "order-fulfilment-1",
        businessId: "biz-alpha",
        status: "placed",
        inventoryReservationId: "inventory-reservation-1",
        items: [{
            orderLineId: "line-1",
            itemName: "Prepared meal",
            quantity: 1,
            fulfillmentStation: "kitchen",
            fulfillmentBehavior: "prepared",
            fulfillmentStatus: "pending",
            fulfillmentStartedAt: null,
            fulfillmentStartedBy: null,
            fulfillmentReadyAt: null,
            fulfillmentReadyBy: null,
        }],
        async save() { return this },
    }
    const originalError = console.error
    console.error = () => {}
    try {
        const result = await transitionOrderFulfillment({
            businessId: "biz-alpha",
            orderId: order.orderId,
            station: "kitchen",
            action: "start",
            actor: { staffId: "staff-1", role: "kitchen", name: "Kitchen" },
        }, {
            OrderModel: { findOne: async () => order },
            runTransaction: async (work) => {
                const value = await work({ id: "session-1" })
                sequence.push("committed")
                return value
            },
            consumeReservedInventoryForFulfillment: async () => {
                availableQuantity = 4
                return {
                    changed: true,
                    movements: [movement({
                        movementId: "ingredient-fulfilment-entry",
                        type: INVENTORY_MOVEMENT_TYPES.CONSUME,
                        onHandBefore: 10,
                        onHandAfter: 4,
                    })],
                    inventoryItems: [stockItem()],
                }
            },
            notifyInventoryTransitions: async () => {
                sequence.push("notification")
                throw new Error("notification unavailable")
            },
            now: () => new Date("2026-09-08T13:00:00.000Z"),
        })

        assert.equal(result.changed, true)
        assert.equal(result.inventoryChanged, true)
        assert.equal(order.items[0].fulfillmentStatus, "in_progress")
        assert.equal(availableQuantity, 4)
        assert.deepEqual(sequence, ["committed", "notification"])
    } finally {
        console.error = originalError
    }
})

test("Feedback and Inventory events use canonical owner/co-owner/manager recipient resolution", async () => {
    const OWNER = "507f1f77bcf86cd799439101"
    const CO_OWNER = "507f1f77bcf86cd799439102"
    const FEEDBACK_MANAGER = "507f1f77bcf86cd799439103"
    const INVENTORY_MANAGER = "507f1f77bcf86cd799439104"
    const UNAUTHORIZED_MANAGER = "507f1f77bcf86cd799439105"
    const WAITER = "507f1f77bcf86cd799439106"
    const BusinessModel = {
        findOne: () => queryResult({ _id: OWNER, businessId: "biz-alpha", ownerStatus: "active" }),
    }
    const StaffModel = {
        find: () => queryResult([
            { _id: CO_OWNER, role: "co_owner", accountStatus: "active", coOwnerRestrictions: [] },
            { _id: FEEDBACK_MANAGER, role: "manager", accountStatus: "active", permissions: [PERMISSIONS.FEEDBACK_VIEW] },
            { _id: INVENTORY_MANAGER, role: "manager", accountStatus: "active", permissions: [PERMISSIONS.INVENTORY_VIEW] },
            { _id: UNAUTHORIZED_MANAGER, role: "manager", accountStatus: "active", permissions: [] },
            { _id: WAITER, role: "waiter", accountStatus: "active", permissions: [PERMISSIONS.FEEDBACK_VIEW, PERMISSIONS.INVENTORY_VIEW] },
        ]),
    }

    async function recipientsFor(type, facts) {
        const prepared = prepareNotificationEvent({ type, facts })
        return resolveNotificationRecipients({
            businessId: "biz-alpha",
            requiredAccessArea: prepared.requiredAccessArea,
            managerPermissions: prepared.managerPermissions,
            managersEligible: prepared.managersEligible,
        }, { BusinessModel, StaffModel })
    }

    const feedback = await recipientsFor(
        NOTIFICATION_TYPES.FEEDBACK_LOW_RATING_RECEIVED,
        { rating: 2 },
    )
    const inventory = await recipientsFor(
        NOTIFICATION_TYPES.INVENTORY_LOW_STOCK_ENTERED,
        { itemName: "Chicken", availableQuantity: 4, trackingUnit: "g" },
    )

    assert.deepEqual(feedback.map((recipient) => String(recipient.recipientId)), [
        OWNER,
        CO_OWNER,
        FEEDBACK_MANAGER,
    ])
    assert.deepEqual(inventory.map((recipient) => String(recipient.recipientId)), [
        OWNER,
        CO_OWNER,
        INVENTORY_MANAGER,
    ])
})
