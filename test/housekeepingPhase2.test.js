import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import mongoose from "mongoose"

import { PERMISSIONS } from "../src/constants/permissions.js"
import HousekeepingOperation from "../src/models/HousekeepingOperation.js"
import {
    completeHousekeepingOperation,
    operationDTO,
    readHousekeepingRooms,
    startHousekeepingOperation,
} from "../src/services/housekeepingService.js"
import {
    acknowledgeHousekeepingInventoryException,
    assignHousekeepingOperation,
    readHousekeepingHistory,
    recordHousekeepingInventoryException,
    resolveHousekeepingInventoryException,
    setHousekeepingPriority,
    updateHousekeepingSettings,
} from "../src/services/housekeepingManagementService.js"

const HOTEL = { _id: "business_1", businessId: "hotel_a", businessType: "hotel", modules: ["lodging"] }
const MANAGER = { actorId: "MGR-1001", staffId: "MGR-1001", name: "Alex", role: "manager" }
const SARAH = { actorId: "HSK-1001", staffId: "HSK-1001", name: "Sarah", role: "housekeeping" }
const JOHN = { actorId: "HSK-1002", staffId: "HSK-1002", name: "John", role: "housekeeping" }

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

function valueAt(source, path) {
    return path.split(".").reduce((value, key) => value?.[key], source)
}

function setAt(source, path, value) {
    const keys = path.split(".")
    const final = keys.pop()
    let current = source
    for (const key of keys) current = current[key] ||= {}
    current[final] = clone(value)
}

function matchesCondition(actual, expected) {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        if (Object.hasOwn(expected, "$exists")) return expected.$exists ? actual !== undefined : actual === undefined
        if (Object.hasOwn(expected, "$in")) return expected.$in.includes(actual)
        if (Object.hasOwn(expected, "$all")) return expected.$all.every((value) => (actual || []).includes(value))
    }
    return actual === expected
}

function matches(source, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        if (key === "$or") return expected.some((candidate) => matches(source, candidate))
        if (key === "$and") return expected.every((candidate) => matches(source, candidate))
        if (key === "_id") return String(source._id) === String(expected)
        return matchesCondition(valueAt(source, key), expected)
    })
}

function buildHarness() {
    let persisted = {
        operation: {
            _id: "operation_1",
            housekeepingOperationId: "hko_1",
            businessId: "hotel_a",
            servicePointId: "room_401",
            operationType: "checkout_turnover",
            triggerType: "reservation_checkout",
            triggerId: "reservation_1",
            status: "needs_cleaning",
            active: true,
            priority: "normal",
            assignedTo: null,
            assignedToName: null,
            assignedToRole: null,
            assignedAt: null,
            assignedBy: null,
            assignedByName: null,
            assignedByRole: null,
            assignmentHistory: [],
            claimedBy: null,
            claimedByName: null,
            claimedByRole: null,
            startedAt: null,
            completedBy: null,
            completedByName: null,
            completedByRole: null,
            completedAt: null,
            supplyOutcome: "pending",
            roomUsageOperationId: null,
            inventoryException: null,
            commandReceipts: {},
            createdAt: new Date("2026-09-16T10:00:00.000Z"),
            updatedAt: new Date("2026-09-16T10:00:00.000Z"),
        },
        room: {
            businessId: "hotel_a",
            servicePointId: "room_401",
            servicePointType: "room",
            isActive: true,
            roomReadiness: { state: "needs_cleaning", operationId: "hko_1" },
        },
    }
    const staff = [
        { businessId: "hotel_a", staffId: "HSK-1001", name: "Sarah", role: "housekeeping", accountStatus: "active", permissions: [PERMISSIONS.HOUSEKEEPING_VIEW, PERMISSIONS.HOUSEKEEPING_PERFORM] },
        { businessId: "hotel_a", staffId: "HSK-1002", name: "John", role: "housekeeping", accountStatus: "active", permissions: [PERMISSIONS.HOUSEKEEPING_VIEW, PERMISSIONS.HOUSEKEEPING_PERFORM] },
        { businessId: "hotel_b", staffId: "HSK-OTHER", name: "Other", role: "housekeeping", accountStatus: "active", permissions: [PERMISSIONS.HOUSEKEEPING_VIEW, PERMISSIONS.HOUSEKEEPING_PERFORM] },
        { businessId: "hotel_a", staffId: "HSK-OFF", name: "Disabled", role: "housekeeping", accountStatus: "disabled", permissions: [PERMISSIONS.HOUSEKEEPING_VIEW, PERMISSIONS.HOUSEKEEPING_PERFORM] },
        { businessId: "hotel_a", staffId: "WTR-1", name: "Waiter", role: "waiter", accountStatus: "active", permissions: [] },
    ]
    function stateFor(session) {
        return session?.state || persisted
    }
    const BusinessModel = {
        async findOne(filter) {
            return filter.businessId === HOTEL.businessId ? clone(HOTEL) : null
        },
    }
    const StaffModel = {
        async findOne(filter) {
            return clone(staff.find((candidate) => matches(candidate, filter)) || null)
        },
    }
    const HousekeepingOperationModel = {
        async findOne(filter, _projection, options = {}) {
            const operation = stateFor(options.session).operation
            return matches(operation, filter) ? document(operation) : null
        },
        async findOneAndUpdate(filter, update, options = {}) {
            const operation = stateFor(options.session).operation
            if (!matches(operation, filter)) return null
            for (const [path, value] of Object.entries(update.$set || {})) setAt(operation, path, value)
            for (const [path, value] of Object.entries(update.$inc || {})) setAt(operation, path, (valueAt(operation, path) || 0) + value)
            for (const [path, spec] of Object.entries(update.$push || {})) {
                const values = [...(valueAt(operation, path) || []), ...(spec.$each || [spec])]
                setAt(operation, path, spec.$slice ? values.slice(spec.$slice) : values)
            }
            return document(operation)
        },
    }
    const ServicePointModel = {
        async findOneAndUpdate(filter, update, options = {}) {
            const room = stateFor(options.session).room
            if (!matches(room, filter)) return null
            for (const [path, value] of Object.entries(update.$set || {})) setAt(room, path, value)
            return clone(room)
        },
    }
    const startSession = async () => ({
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
    })
    return {
        management: { BusinessModel, StaffModel, HousekeepingOperationModel, startSession },
        lifecycle: { BusinessModel, HousekeepingOperationModel, ServicePointModel, startSession },
        exception: { HousekeepingOperationModel },
        snapshot: () => clone(persisted),
    }
}

test("Phase 2 schema is additive, bounded, and indexed for operational reads", () => {
    const legacy = new HousekeepingOperation({
        housekeepingOperationId: "hko_legacy",
        businessId: "hotel_a",
        servicePointId: "room_1",
        operationType: "checkout_turnover",
        triggerType: "reservation_checkout",
        triggerId: "reservation_legacy",
        status: "needs_cleaning",
        active: true,
    })
    assert.equal(legacy.validateSync(), undefined)
    assert.equal(legacy.priority, "normal")
    assert.equal(legacy.assignedTo, null)
    assert.equal(legacy.inventoryException, null)
    const indexes = HousekeepingOperation.schema.indexes().map(([keys]) => keys)
    assert.ok(indexes.some((keys) => keys.businessId === 1 && keys.priority === 1 && keys.createdAt === 1))
    assert.ok(indexes.some((keys) => keys.businessId === 1 && keys.completedAt === -1))
})

test("assignment validates eligibility, preserves audit identity, and is replay safe", async () => {
    const harness = buildHarness()
    const first = await assignHousekeepingOperation({
        businessId: "hotel_a",
        operationId: "hko_1",
        assigneeStaffId: SARAH.staffId,
        expectedAssignedTo: null,
        actor: MANAGER,
        idempotencyKey: "assign-1",
    }, { ...harness.management, now: () => new Date("2026-09-16T10:05:00.000Z") })
    assert.equal(first.replayed, false)
    assert.equal(first.operation.assignedTo, SARAH.staffId)
    assert.equal(first.operation.assignedBy, MANAGER.staffId)
    assert.equal(first.operation.status, "needs_cleaning")
    assert.equal(first.operation.claimedBy, null)
    assert.equal(first.operation.assignmentHistory[0].assignee.name, "Sarah")

    const replay = await assignHousekeepingOperation({
        businessId: "hotel_a",
        operationId: "hko_1",
        assigneeStaffId: SARAH.staffId,
        expectedAssignedTo: null,
        actor: MANAGER,
        idempotencyKey: "assign-1",
    }, harness.management)
    assert.equal(replay.replayed, true)

    for (const assigneeStaffId of ["HSK-OTHER", "HSK-OFF", "WTR-1"]) {
        const fresh = buildHarness()
        await assert.rejects(
            assignHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", assigneeStaffId, expectedAssignedTo: null, actor: MANAGER }, fresh.management),
            (error) => error.code === "HOUSEKEEPING_ASSIGNEE_NOT_ELIGIBLE",
        )
    }
})

test("unstarted reassignment audits the previous assignee and stale managers conflict", async () => {
    const harness = buildHarness()
    await assignHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", assigneeStaffId: SARAH.staffId, expectedAssignedTo: null, actor: MANAGER }, harness.management)
    const reassigned = await assignHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", assigneeStaffId: JOHN.staffId, expectedAssignedTo: SARAH.staffId, actor: MANAGER }, harness.management)
    assert.equal(reassigned.operation.assignedTo, JOHN.staffId)
    assert.equal(reassigned.operation.assignmentHistory[1].previousAssignee.staffId, SARAH.staffId)
    await assert.rejects(
        assignHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", assigneeStaffId: SARAH.staffId, expectedAssignedTo: null, actor: MANAGER }, harness.management),
        (error) => error.code === "HOUSEKEEPING_ASSIGNMENT_CONFLICT",
    )
})

test("assignment and Start Cleaning have one winner and assigned work cannot be stolen", async () => {
    const assignedFirst = buildHarness()
    await assignHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", assigneeStaffId: SARAH.staffId, expectedAssignedTo: null, actor: MANAGER }, assignedFirst.management)
    await assert.rejects(
        startHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", actor: JOHN }, assignedFirst.lifecycle),
        (error) => error.code === "HOUSEKEEPING_ASSIGNED_TO_ANOTHER_STAFF_MEMBER",
    )
    const started = await startHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", actor: SARAH }, assignedFirst.lifecycle)
    assert.equal(started.operation.claimedBy, SARAH.staffId)
    await assert.rejects(
        assignHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", assigneeStaffId: JOHN.staffId, expectedAssignedTo: SARAH.staffId, actor: MANAGER }, assignedFirst.management),
        (error) => error.code === "HOUSEKEEPING_ASSIGNMENT_STATE_CONFLICT",
    )

    const selfClaimFirst = buildHarness()
    await startHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", actor: JOHN }, selfClaimFirst.lifecycle)
    await assert.rejects(
        assignHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", assigneeStaffId: SARAH.staffId, expectedAssignedTo: null, actor: MANAGER }, selfClaimFirst.management),
        (error) => error.code === "HOUSEKEEPING_ASSIGNMENT_STATE_CONFLICT",
    )
})

test("priority is bounded, explicit, CAS protected, and timing overdue is derived", async () => {
    const harness = buildHarness()
    const changed = await setHousekeepingPriority({
        businessId: "hotel_a",
        operationId: "hko_1",
        priority: "urgent",
        expectedPriority: "normal",
        actor: MANAGER,
    }, harness.management)
    assert.equal(changed.operation.priority, "urgent")
    await assert.rejects(
        setHousekeepingPriority({ businessId: "hotel_a", operationId: "hko_1", priority: "priority", expectedPriority: "normal", actor: MANAGER }, harness.management),
        (error) => error.code === "HOUSEKEEPING_PRIORITY_CONFLICT",
    )
    await assert.rejects(
        setHousekeepingPriority({ businessId: "hotel_a", operationId: "hko_1", priority: "vip", expectedPriority: "urgent", actor: MANAGER }, harness.management),
        (error) => error.code === "INVALID_HOUSEKEEPING_PRIORITY",
    )
    const dto = operationDTO(harness.snapshot().operation, {
        now: new Date("2026-09-16T10:31:00.000Z"),
        targetStartMinutes: 30,
        targetCleaningMinutes: null,
    })
    assert.equal(dto.timing.waitingSeconds, 1860)
    assert.equal(dto.timing.waitingOverdue, true)
    assert.equal(dto.status, "needs_cleaning")
})

test("Inventory exception acknowledgment separates physical readiness from stock truth", async () => {
    const harness = buildHarness()
    await startHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", actor: SARAH }, harness.lifecycle)
    const recorded = await recordHousekeepingInventoryException({
        businessId: "hotel_a",
        operationId: "hko_1",
        servicePointId: "room_401",
        attemptedItems: [{ inventoryItemId: "inv_soap", quantity: 2, unit: "piece" }],
        failureCode: "INSUFFICIENT_AVAILABLE_INVENTORY",
        failureMessage: "Insufficient available stock for Soap",
        actor: SARAH,
    }, harness.exception)
    assert.equal(recorded.operation.inventoryException.status, "unresolved")
    assert.equal(recorded.operation.supplyOutcome, "pending")

    const acknowledged = await acknowledgeHousekeepingInventoryException({
        businessId: "hotel_a",
        operationId: "hko_1",
        actor: MANAGER,
        idempotencyKey: "ack-1",
    }, harness.management)
    assert.equal(acknowledged.operation.supplyOutcome, "inventory_exception_acknowledged")
    assert.equal(acknowledged.operation.inventoryException.status, "unresolved")

    const acknowledgedState = harness.snapshot()
    const queue = await readHousekeepingRooms({
        businessId: "hotel_a",
        actor: { ...SARAH, permissions: [PERMISSIONS.HOUSEKEEPING_VIEW, PERMISSIONS.HOUSEKEEPING_PERFORM] },
    }, {
        BusinessModel: { async findOne() { return clone(HOTEL) } },
        ServicePointModel: { async find() { return [{ ...acknowledgedState.room, label: "Room 401" }] } },
        HousekeepingOperationModel: {
            async find(filter) {
                return filter.active === true ? [acknowledgedState.operation] : []
            },
            async countDocuments(filter) {
                assert.deepEqual(filter, {
                    businessId: "hotel_a",
                    "inventoryException.status": "unresolved",
                })
                return 1
            },
            async aggregate() { return [] },
        },
    })
    assert.equal(queue.rooms[0].allowedActions.complete, true)
    assert.equal(queue.overview.inventoryExceptions, 1)

    const completed = await completeHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", actor: MANAGER }, harness.lifecycle)
    assert.equal(completed.operation.status, "completed")
    assert.equal(completed.operation.inventoryException.status, "unresolved")
    assert.equal(harness.snapshot().room.roomReadiness.state, "ready")
})

test("Inventory exception resolution only verifies canonical movements and preserves audit history", async () => {
    const harness = buildHarness()
    await startHousekeepingOperation({ businessId: "hotel_a", operationId: "hko_1", actor: SARAH }, harness.lifecycle)
    await recordHousekeepingInventoryException({
        businessId: "hotel_a",
        operationId: "hko_1",
        servicePointId: "room_401",
        attemptedItems: [{ inventoryItemId: "inv_soap", quantity: 2, unit: "piece" }],
        failureCode: "INSUFFICIENT_AVAILABLE_INVENTORY",
        failureMessage: "Insufficient available stock for Soap",
        actor: SARAH,
    }, harness.exception)
    const inventoryReads = []
    const InventoryMovementModel = {
        async find(filter) {
            inventoryReads.push(clone(filter))
            return [{
                businessId: "hotel_a",
                movementId: "imv_adjustment_1",
                type: "ADJUSTMENT_INCREASE",
            }]
        },
    }
    const resolved = await resolveHousekeepingInventoryException({
        businessId: "hotel_a",
        operationId: "hko_1",
        movementIds: ["imv_adjustment_1"],
        resolutionNote: "Physical count corrected",
        actor: MANAGER,
    }, { ...harness.management, InventoryMovementModel })
    assert.equal(resolved.operation.inventoryException.status, "resolved")
    assert.deepEqual(resolved.operation.inventoryException.reconciliationMovementIds, ["imv_adjustment_1"])
    assert.deepEqual(inventoryReads[0].businessId, "hotel_a")
    assert.ok(inventoryReads[0].type.$in.includes("ADJUSTMENT_INCREASE"))
    assert.equal(typeof InventoryMovementModel.create, "undefined")
})

test("history is tenant scoped, bounded, filter bound, labelled, and cursor deterministic", async () => {
    const firstId = new mongoose.Types.ObjectId("68c94f000000000000000002")
    const secondId = new mongoose.Types.ObjectId("68c94f000000000000000001")
    const operations = [
        { ...buildHarness().snapshot().operation, _id: firstId, status: "completed", active: false, servicePointId: "room_401", completedAt: new Date("2026-09-16T11:00:00.000Z"), claimedBy: "HSK-1001", completedBy: "HSK-1001" },
        { ...buildHarness().snapshot().operation, _id: secondId, housekeepingOperationId: "hko_2", status: "completed", active: false, servicePointId: "room_402", completedAt: new Date("2026-09-15T11:00:00.000Z"), claimedBy: "HSK-1002", completedBy: "HSK-1002" },
    ]
    const filters = []
    const HousekeepingOperationModel = {
        find(filter) {
            filters.push(filter)
            let rows = filter.$and ? operations.slice(1) : operations
            const query = {
                sort() { return query },
                limit(value) { rows = rows.slice(0, value); return query },
                async lean() { return rows.map((row) => ({ ...row })) },
            }
            return query
        },
    }
    const dependencies = {
        BusinessModel: { async findOne() { return clone(HOTEL) } },
        HousekeepingOperationModel,
        ServicePointModel: {
            async find(filter) {
                assert.equal(filter.businessId, "hotel_a")
                return [
                    { servicePointId: "room_401", label: "Room 401" },
                    { servicePointId: "room_402", label: "Room 402" },
                ]
            },
        },
    }
    const first = await readHousekeepingHistory({ businessId: "hotel_a", staffId: "HSK-1001", limit: 1 }, dependencies)
    assert.equal(first.operations.length, 1)
    assert.equal(first.operations[0].servicePointLabel, "Room 401")
    assert.equal(first.pagination.hasNextPage, true)
    assert.ok(first.pagination.nextCursor)
    assert.equal(filters[0].businessId, "hotel_a")
    assert.deepEqual(filters[0].$or, [{ assignedTo: "HSK-1001" }, { claimedBy: "HSK-1001" }, { completedBy: "HSK-1001" }])

    const second = await readHousekeepingHistory({ businessId: "hotel_a", staffId: "HSK-1001", limit: 1, cursor: first.pagination.nextCursor }, dependencies)
    assert.equal(second.operations[0].housekeepingOperationId, "hko_2")
    await assert.rejects(
        readHousekeepingHistory({ businessId: "hotel_a", servicePointId: "room_401", limit: 1, cursor: first.pagination.nextCursor }, dependencies),
        (error) => error.code === "INVALID_HOUSEKEEPING_HISTORY_CURSOR",
    )
    await assert.rejects(
        readHousekeepingHistory({ businessId: "hotel_a", limit: 1000 }, dependencies),
        (error) => error.code === "INVALID_HOUSEKEEPING_HISTORY_QUERY",
    )
})

test("SLA configuration has no invented defaults and validates bounded explicit targets", async () => {
    let saved = null
    const BusinessModel = {
        async findOne() { return clone(HOTEL) },
        async findOneAndUpdate(filter, update) {
            assert.equal(filter.businessId, "hotel_a")
            saved = clone(update.$set.housekeepingSettings)
            return { ...HOTEL, housekeepingSettings: saved }
        },
    }
    const cleared = await updateHousekeepingSettings({ businessId: "hotel_a", targetStartMinutes: null, targetCleaningMinutes: "" }, { BusinessModel })
    assert.deepEqual(cleared.settings, { targetStartMinutes: null, targetCleaningMinutes: null })
    const configured = await updateHousekeepingSettings({ businessId: "hotel_a", targetStartMinutes: 20, targetCleaningMinutes: 45 }, { BusinessModel })
    assert.deepEqual(configured.settings, { targetStartMinutes: 20, targetCleaningMinutes: 45 })
    assert.deepEqual(saved, configured.settings)
    await assert.rejects(
        updateHousekeepingSettings({ businessId: "hotel_a", targetStartMinutes: 0, targetCleaningMinutes: 45 }, { BusinessModel }),
        (error) => error.code === "INVALID_HOUSEKEEPING_SETTINGS",
    )
})

test("Phase 2 routes use narrow permissions, existing realtime, and no BullMQ or notification catalog changes", async () => {
    const [routes, controller, management, inventory, notification] = await Promise.all([
        readFile(new URL("../src/routes/housekeeping-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/controllers/housekeepingController.js", import.meta.url), "utf8"),
        readFile(new URL("../src/services/housekeepingManagementService.js", import.meta.url), "utf8"),
        readFile(new URL("../src/controllers/inventoryController.js", import.meta.url), "utf8"),
        readFile(new URL("../src/services/notificationService.js", import.meta.url), "utf8"),
    ])
    assert.match(routes, /HOUSEKEEPING_ASSIGN/)
    assert.match(routes, /HOUSEKEEPING_MANAGE/)
    assert.match(routes, /\/history/)
    assert.match(routes, /inventory-exception\/acknowledge/)
    assert.match(controller, /publishAfterCommit/)
    assert.match(inventory, /INSUFFICIENT_AVAILABLE_INVENTORY[\s\S]*recordHousekeepingInventoryException/)
    assert.doesNotMatch(management, /BullMQ|Queue\(|add\(/)
    assert.doesNotMatch(management, /Notification|createNotification/)
    assert.doesNotMatch(notification, /housekeeping\./)
})
