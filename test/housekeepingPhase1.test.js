import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { HOUSEKEEPING_DEFAULT_PERMISSIONS, PERMISSIONS } from "../src/constants/permissions.js"
import { requireOperationalPermission } from "../src/middleware/authMiddleware.js"
import Business from "../src/models/Business.js"
import HousekeepingOperation from "../src/models/HousekeepingOperation.js"
import ServicePoint from "../src/models/ServicePoint.js"
import Staff from "../src/models/Staff.js"
import {
    broadcastLocal,
    HOUSEKEEPING_CHANGED_EVENT,
    publishHousekeepingChanged,
    sseHandler,
} from "../src/utils/sseManager.js"
import {
    checkoutReservationIntoHousekeeping,
    completeHousekeepingOperation,
    markNoSuppliesUsed,
    startHousekeepingOperation,
} from "../src/services/housekeepingService.js"

const HOTEL = { businessId: "hotel_a", businessType: "hotel", modules: ["lodging"] }
const SARAH = { actorId: "STF-1001", staffId: "STF-1001", name: "Sarah", role: "housekeeping" }
const JOHN = { actorId: "STF-1002", staffId: "STF-1002", name: "John", role: "housekeeping" }

function clone(value) {
    return structuredClone(value)
}

function document(value) {
    return {
        ...clone(value),
        toObject() {
            const source = { ...this }
            delete source.toObject
            return clone(source)
        },
    }
}

function buildHarness({ failRoomUpdate = false, activeRoomConflict = false } = {}) {
    const existingOperation = activeRoomConflict
        ? {
            _id: "operation_existing",
            housekeepingOperationId: "hko_existing",
            businessId: "hotel_a",
            servicePointId: "sp_room_401",
            operationType: "checkout_turnover",
            triggerType: "reservation_checkout",
            triggerId: "reservation_prior",
            status: "needs_cleaning",
            active: true,
            supplyOutcome: "pending",
            createdAt: new Date("2026-09-16T09:00:00.000Z"),
            updatedAt: new Date("2026-09-16T09:00:00.000Z"),
        }
        : null
    let persisted = {
        reservation: {
            _id: "reservation_1",
            businessId: "hotel_a",
            servicePointId: "sp_room_401",
            status: "checked_in",
            activeRefundId: null,
            checkedOutAt: null,
            checkedOutBy: null,
        },
        room: {
            _id: "room_1",
            businessId: "hotel_a",
            servicePointId: "sp_room_401",
            servicePointType: "room",
            label: "Room 401",
            roomType: "Deluxe King",
            isActive: true,
            roomReadiness: activeRoomConflict
                ? { state: "needs_cleaning", operationId: "hko_existing" }
                : { state: "ready", operationId: null },
        },
        operations: existingOperation ? [existingOperation] : [],
    }

    function stateFor(session) {
        return session?.state || persisted
    }

    const BusinessModel = {
        async findOne(filter) {
            return filter.businessId === HOTEL.businessId ? clone(HOTEL) : null
        },
    }
    const ReservationModel = {
        async findOne(filter, _projection, options = {}) {
            const reservation = stateFor(options.session).reservation
            return reservation && reservation._id === String(filter._id) && reservation.businessId === filter.businessId
                ? document(reservation)
                : null
        },
        async findOneAndUpdate(filter, update, options = {}) {
            const state = stateFor(options.session)
            const reservation = state.reservation
            if (
                reservation._id !== String(filter._id) ||
                reservation.businessId !== filter.businessId ||
                (filter.status && reservation.status !== filter.status) ||
                (Object.hasOwn(filter, "activeRefundId") && reservation.activeRefundId !== filter.activeRefundId)
            ) return null
            Object.assign(reservation, clone(update.$set || {}))
            return document(reservation)
        },
    }
    const ServicePointModel = {
        async findOne(filter, _projection, options = {}) {
            const room = stateFor(options.session).room
            return room.businessId === filter.businessId && room.servicePointId === filter.servicePointId && room.servicePointType === filter.servicePointType
                ? clone(room)
                : null
        },
        async findOneAndUpdate(filter, update, options = {}) {
            if (failRoomUpdate) return null
            const room = stateFor(options.session).room
            if (
                room.businessId !== filter.businessId ||
                room.servicePointId !== filter.servicePointId ||
                room.servicePointType !== filter.servicePointType ||
                (Object.hasOwn(filter, "isActive") && room.isActive !== filter.isActive) ||
                (filter["roomReadiness.state"] && room.roomReadiness?.state !== filter["roomReadiness.state"]) ||
                (filter["roomReadiness.operationId"] && room.roomReadiness?.operationId !== filter["roomReadiness.operationId"])
            ) return null
            if (filter.$or) {
                const canTurnover = room.roomReadiness == null || room.roomReadiness.state === "ready"
                if (!canTurnover) return null
            }
            Object.assign(room, clone(update.$set || {}))
            return clone(room)
        },
    }
    const HousekeepingOperationModel = {
        async create(inputs, { session }) {
            const state = stateFor(session)
            const conflict = inputs.find((input) => state.operations.some((operation) => (
                operation.businessId === input.businessId &&
                operation.servicePointId === input.servicePointId &&
                operation.active === true
            )))
            if (conflict) {
                const error = new Error("duplicate active Housekeeping operation")
                error.code = 11000
                error.keyPattern = { businessId: 1, servicePointId: 1, active: 1 }
                error.keyValue = {
                    businessId: conflict.businessId,
                    servicePointId: conflict.servicePointId,
                    active: true,
                }
                throw error
            }
            const created = inputs.map((input, index) => document({
                _id: `operation_${state.operations.length + index + 1}`,
                ...clone(input),
                claimedBy: null,
                claimedByName: null,
                claimedByRole: null,
                startedAt: null,
                completedBy: null,
                completedByName: null,
                completedByRole: null,
                completedAt: null,
                roomUsageOperationId: null,
                createdAt: new Date("2026-09-16T10:00:00.000Z"),
                updatedAt: new Date("2026-09-16T10:00:00.000Z"),
            }))
            state.operations.push(...created.map((entry) => entry.toObject()))
            return created
        },
        async findOne(filter, _projection, options = {}) {
            const result = stateFor(options.session).operations.find((operation) => (
                operation.businessId === filter.businessId &&
                (!filter.housekeepingOperationId || operation.housekeepingOperationId === filter.housekeepingOperationId) &&
                (!filter.triggerType || operation.triggerType === filter.triggerType) &&
                (!filter.triggerId || operation.triggerId === filter.triggerId) &&
                (!filter.servicePointId || operation.servicePointId === filter.servicePointId) &&
                (!Object.hasOwn(filter, "active") || operation.active === filter.active)
            ))
            return result ? document(result) : null
        },
        async findOneAndUpdate(filter, update, options = {}) {
            const state = stateFor(options.session)
            const operation = state.operations.find((candidate) => candidate._id === String(filter._id))
            if (!operation || operation.businessId !== filter.businessId) return null
            for (const field of ["status", "active", "claimedBy", "supplyOutcome", "servicePointId"]) {
                if (Object.hasOwn(filter, field) && operation[field] !== filter[field]) return null
            }
            Object.assign(operation, clone(update.$set || {}))
            return document(operation)
        },
    }
    const dependencies = {
        BusinessModel,
        ReservationModel,
        ServicePointModel,
        HousekeepingOperationModel,
        startSession: async () => ({
            state: null,
            async withTransaction(work) {
                this.state = clone(persisted)
                try {
                    await work()
                    persisted = clone(this.state)
                } finally {
                    this.state = null
                }
            },
            async endSession() {},
        }),
    }
    return {
        dependencies,
        snapshot: () => clone(persisted),
    }
}

test("Housekeeping is an official narrow-permission Staff role", () => {
    assert.deepEqual(HOUSEKEEPING_DEFAULT_PERMISSIONS, [
        PERMISSIONS.HOUSEKEEPING_VIEW,
        PERMISSIONS.HOUSEKEEPING_PERFORM,
        PERMISSIONS.INVENTORY_ROOM_USAGE_RECORD,
    ])
    assert.equal(HOUSEKEEPING_DEFAULT_PERMISSIONS.includes(PERMISSIONS.INVENTORY_MANAGE), false)
    const staff = new Staff({
        businessId: "hotel_a",
        staffId: "HSK-1001",
        role: "housekeeping",
        name: "Sarah",
        email: "sarah@example.com",
        permissions: HOUSEKEEPING_DEFAULT_PERMISSIONS,
    })
    assert.equal(staff.validateSync(), undefined)
})

test("operational permission guard reloads active tenant-scoped Staff and denies stale permission", async () => {
    const originalFindOne = Staff.findOne
    let currentPermissions = [...HOUSEKEEPING_DEFAULT_PERMISSIONS]
    Staff.findOne = () => ({
        select() { return this },
        async lean() {
            return {
                _id: "staff_mongo_1",
                businessId: "hotel_a",
                staffId: "STF-1001",
                role: "housekeeping",
                accountStatus: "active",
                permissions: currentPermissions,
                name: "Sarah",
                email: "sarah@example.com",
            }
        },
    })
    try {
        const middleware = requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_PERFORM)
        const makeReq = () => ({ session: { user: { businessId: "hotel_a", staffId: "STF-1001", role: "housekeeping" } } })
        const response = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
        let allowed = false
        await middleware(makeReq(), response, () => { allowed = true })
        assert.equal(allowed, true)

        currentPermissions = [PERMISSIONS.HOUSEKEEPING_VIEW]
        allowed = false
        await middleware(makeReq(), response, () => { allowed = true })
        assert.equal(allowed, false)
        assert.equal(response.statusCode, 403)
    } finally {
        Staff.findOne = originalFindOne
    }
})

test("ServicePoint readiness is room-only, backward-compatible, and Housekeeping indexes enforce integrity", async () => {
    const room = new ServicePoint({
        servicePointId: "sp_room_401",
        businessId: "hotel_a",
        label: "Room 401",
        code: "401",
        servicePointType: "room",
    })
    await room.validate()
    assert.equal(room.roomReadiness.state, "ready")
    const table = new ServicePoint({
        servicePointId: "sp_table_1",
        businessId: "restaurant_a",
        label: "Table 1",
        code: "T1",
        servicePointType: "table",
        roomReadiness: { state: "ready" },
    })
    await assert.rejects(table.validate(), (error) => Boolean(error?.errors?.roomReadiness))

    const indexes = HousekeepingOperation.schema.indexes()
    assert.ok(indexes.some(([fields, options]) => fields.businessId === 1 && fields.triggerType === 1 && fields.triggerId === 1 && options.unique))
    assert.ok(indexes.some(([fields, options]) => fields.businessId === 1 && fields.servicePointId === 1 && fields.active === 1 && options.unique && options.partialFilterExpression?.active === true))
})

test("checkout atomically creates one turnover and changes room readiness", async () => {
    const harness = buildHarness()
    const first = await checkoutReservationIntoHousekeeping({
        businessId: "hotel_a",
        reservationId: "reservation_1",
        actor: SARAH,
        reservationActor: { userId: SARAH.staffId, name: SARAH.name, role: SARAH.role },
    }, harness.dependencies)
    assert.equal(first.replayed, false)
    let state = harness.snapshot()
    assert.equal(state.reservation.status, "checked_out")
    assert.equal(state.room.roomReadiness.state, "needs_cleaning")
    assert.equal(state.operations.length, 1)
    assert.equal(state.operations[0].triggerId, "reservation_1")

    const replay = await checkoutReservationIntoHousekeeping({
        businessId: "hotel_a",
        reservationId: "reservation_1",
        actor: SARAH,
        reservationActor: { userId: SARAH.staffId, name: SARAH.name, role: SARAH.role },
    }, harness.dependencies)
    assert.equal(replay.replayed, true)
    state = harness.snapshot()
    assert.equal(state.operations.length, 1)
})

test("checkout rolls back reservation and operation when readiness cannot update", async () => {
    const harness = buildHarness({ failRoomUpdate: true })
    await assert.rejects(
        checkoutReservationIntoHousekeeping({
            businessId: "hotel_a",
            reservationId: "reservation_1",
            actor: SARAH,
            reservationActor: { userId: SARAH.staffId, name: SARAH.name, role: SARAH.role },
        }, harness.dependencies),
        (error) => error.code === "ROOM_HOUSEKEEPING_CONFLICT",
    )
    const state = harness.snapshot()
    assert.equal(state.reservation.status, "checked_in")
    assert.equal(state.room.roomReadiness.state, "ready")
    assert.equal(state.operations.length, 0)
})

test("checkout maps an existing active room turnover duplicate to the canonical conflict", async () => {
    const harness = buildHarness({ activeRoomConflict: true })
    await assert.rejects(
        checkoutReservationIntoHousekeeping({
            businessId: "hotel_a",
            reservationId: "reservation_1",
            actor: SARAH,
            reservationActor: { userId: SARAH.staffId, name: SARAH.name, role: SARAH.role },
        }, harness.dependencies),
        (error) => error.code === "ROOM_HOUSEKEEPING_CONFLICT" && error.statusCode === 409,
    )
    const state = harness.snapshot()
    assert.equal(state.reservation.status, "checked_in")
    assert.equal(state.room.roomReadiness.state, "needs_cleaning")
    assert.equal(state.operations.length, 1)
    assert.equal(state.operations[0].housekeepingOperationId, "hko_existing")
})

test("self-claim has one winner, same-claimant retry is idempotent, and timestamps remain server-derived", async () => {
    const harness = buildHarness()
    const checkout = await checkoutReservationIntoHousekeeping({
        businessId: "hotel_a",
        reservationId: "reservation_1",
        actor: SARAH,
        reservationActor: { userId: SARAH.staffId, name: SARAH.name, role: SARAH.role },
    }, harness.dependencies)
    const operationId = checkout.operation.housekeepingOperationId
    const startedAt = new Date("2026-09-16T10:12:00.000Z")
    const started = await startHousekeepingOperation({ businessId: "hotel_a", operationId, actor: SARAH }, {
        ...harness.dependencies,
        now: () => startedAt,
    })
    assert.equal(started.operation.claimedBy, SARAH.staffId)
    assert.deepEqual(started.operation.startedAt, startedAt)
    assert.equal(harness.snapshot().room.roomReadiness.state, "cleaning")

    const replay = await startHousekeepingOperation({ businessId: "hotel_a", operationId, actor: SARAH }, harness.dependencies)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.operation.startedAt, startedAt)
    await assert.rejects(
        startHousekeepingOperation({ businessId: "hotel_a", operationId, actor: JOHN }, harness.dependencies),
        (error) => error.code === "HOUSEKEEPING_ALREADY_CLAIMED" && error.statusCode === 409,
    )
})

test("explicit no-supplies permits completion while preserving distinct starter and completer", async () => {
    const harness = buildHarness()
    const checkout = await checkoutReservationIntoHousekeeping({
        businessId: "hotel_a",
        reservationId: "reservation_1",
        actor: SARAH,
        reservationActor: { userId: SARAH.staffId, name: SARAH.name, role: SARAH.role },
    }, harness.dependencies)
    const operationId = checkout.operation.housekeepingOperationId
    await startHousekeepingOperation({ businessId: "hotel_a", operationId, actor: SARAH }, harness.dependencies)

    await assert.rejects(
        completeHousekeepingOperation({ businessId: "hotel_a", operationId, actor: SARAH }, harness.dependencies),
        (error) => error.code === "HOUSEKEEPING_SUPPLY_OUTCOME_REQUIRED",
    )
    await assert.rejects(
        markNoSuppliesUsed({ businessId: "hotel_a", operationId, actor: JOHN }, harness.dependencies),
        (error) => error.code === "HOUSEKEEPING_CLAIM_REQUIRED",
    )
    const outcome = await markNoSuppliesUsed({ businessId: "hotel_a", operationId, actor: SARAH }, harness.dependencies)
    assert.equal(outcome.operation.supplyOutcome, "no_supplies_used")

    const completedAt = new Date("2026-09-16T10:38:00.000Z")
    const manager = { actorId: "STF-9000", staffId: "STF-9000", name: "Manager", role: "manager" }
    const completed = await completeHousekeepingOperation({ businessId: "hotel_a", operationId, actor: manager }, {
        ...harness.dependencies,
        now: () => completedAt,
    })
    assert.equal(completed.operation.claimedBy, SARAH.staffId)
    assert.equal(completed.operation.completedBy, manager.staffId)
    assert.deepEqual(completed.operation.completedAt, completedAt)
    assert.equal(harness.snapshot().room.roomReadiness.state, "ready")

    const replay = await completeHousekeepingOperation({ businessId: "hotel_a", operationId, actor: manager }, harness.dependencies)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.operation.completedAt, completedAt)
})

test("no-supplies keeps MongoDB transaction reads sequential", async () => {
    let businessReadFinished = false
    const operation = document({
        _id: "operation_sequential_reads",
        housekeepingOperationId: "hko_sequential_reads",
        businessId: "hotel_a",
        servicePointId: "sp_room_401",
        operationType: "checkout_turnover",
        triggerType: "reservation_checkout",
        triggerId: "reservation_sequential_reads",
        status: "cleaning",
        active: true,
        priority: "normal",
        claimedBy: SARAH.staffId,
        claimedByName: SARAH.name,
        claimedByRole: SARAH.role,
        startedAt: new Date("2026-09-16T10:12:00.000Z"),
        supplyOutcome: "pending",
        roomUsageOperationId: null,
        createdAt: new Date("2026-09-16T10:00:00.000Z"),
        updatedAt: new Date("2026-09-16T10:12:00.000Z"),
    })
    const BusinessModel = {
        findOne() {
            return new Promise((resolve) => {
                setImmediate(() => {
                    businessReadFinished = true
                    resolve(clone(HOTEL))
                })
            })
        },
    }
    const HousekeepingOperationModel = {
        async findOne() {
            assert.equal(businessReadFinished, true)
            return operation
        },
        async findOneAndUpdate() {
            operation.supplyOutcome = "no_supplies_used"
            return operation
        },
    }
    const result = await markNoSuppliesUsed({
        businessId: "hotel_a",
        operationId: operation.housekeepingOperationId,
        actor: SARAH,
    }, {
        BusinessModel,
        HousekeepingOperationModel,
        startSession: async () => ({
            async withTransaction(work) { await work() },
            async endSession() {},
        }),
    })

    assert.equal(result.operation.supplyOutcome, "no_supplies_used")
})

test("Phase 1 wiring reuses canonical Room Usage and content-free realtime without notification or BullMQ", async () => {
    const [roomUsage, realtime, route, controller] = await Promise.all([
        readFile(new URL("../src/services/inventoryRoomUsageService.js", import.meta.url), "utf8"),
        readFile(new URL("../src/utils/sseManager.js", import.meta.url), "utf8"),
        readFile(new URL("../src/routes/housekeeping-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/controllers/housekeepingController.js", import.meta.url), "utf8"),
    ])
    assert.match(roomUsage, /housekeepingOperationId[\s\S]*supplyOutcome:\s*"recorded"[\s\S]*roomUsageOperationId/)
    assert.match(roomUsage, /withCanonicalInventoryTransaction/)
    assert.match(realtime, /HOUSEKEEPING_CHANGED_EVENT = "housekeeping_changed"/)
    assert.match(realtime, /\["housekeeping"\],[\s\S]*\{ invalidated: true \}/)
    assert.match(route, /HOUSEKEEPING_VIEW[\s\S]*HOUSEKEEPING_PERFORM/)
    assert.doesNotMatch(controller, /Notification|BullMQ|queue/i)
})

test("Housekeeping realtime publishes only a tenant-scoped content-free invalidation", async () => {
    const calls = []
    await publishHousekeepingChanged({
        businessId: "hotel_a",
        publish: async (...args) => calls.push(args),
    })
    assert.deepEqual(calls, [[
        HOUSEKEEPING_CHANGED_EVENT,
        "hotel_a",
        ["housekeeping"],
        { invalidated: true },
    ]])
})

test("Housekeeping SSE is lodging-, tenant-, active-Staff-, and current-permission-scoped", async (t) => {
    let staffRecord = {
        _id: "staff_mongo_1",
        businessId: "hotel_a",
        staffId: "HSK-1001",
        role: "housekeeping",
        accountStatus: "active",
        permissions: [...HOUSEKEEPING_DEFAULT_PERMISSIONS],
        name: "Sarah",
    }
    t.mock.method(Staff, "findOne", (filter) => ({
        select() { return this },
        async lean() {
            if (
                !staffRecord ||
                staffRecord.businessId !== filter.businessId ||
                (filter.role && staffRecord.role !== filter.role) ||
                (filter.accountStatus && staffRecord.accountStatus !== filter.accountStatus)
            ) return null
            return clone(staffRecord)
        },
    }))
    t.mock.method(Business, "findOne", (filter) => ({
        select() { return this },
        async lean() { return filter.businessId === "hotel_a" ? clone(HOTEL) : null },
    }))

    let closeHandler = null
    const writes = []
    const req = {
        session: { user: { role: "housekeeping", businessId: "hotel_a", staffId: "HSK-1001" } },
        query: { role: "housekeeping", businessId: "hotel_a" },
        on(event, handler) { if (event === "close") closeHandler = handler },
    }
    const res = {
        ended: false,
        statusCode: 200,
        setHeader() {},
        flushHeaders() {},
        write(value) { writes.push(value) },
        end() { this.ended = true },
        status(code) { this.statusCode = code; return this },
    }

    await sseHandler(req, res)
    const initialWrites = writes.length
    await broadcastLocal({
        event: HOUSEKEEPING_CHANGED_EVENT,
        businessId: "hotel_b",
        targets: ["housekeeping"],
        payload: { invalidated: true },
    })
    assert.equal(writes.length, initialWrites)

    await broadcastLocal({
        event: HOUSEKEEPING_CHANGED_EVENT,
        businessId: "hotel_a",
        targets: ["housekeeping"],
        payload: { invalidated: true },
    })
    assert.equal(writes.length, initialWrites + 1)

    staffRecord = { ...staffRecord, permissions: [] }
    await broadcastLocal({
        event: HOUSEKEEPING_CHANGED_EVENT,
        businessId: "hotel_a",
        targets: ["housekeeping"],
        payload: { invalidated: true },
    })
    assert.equal(res.ended, true)
    assert.equal(writes.length, initialWrites + 1)
    closeHandler?.()
})
