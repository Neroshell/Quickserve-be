import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
    HOTEL_OPERATIONAL_INVENTORY_DOMAINS,
    INVENTORY_ITEM_DOMAINS,
} from "../src/constants/inventory.js"
import InventoryItem from "../src/models/InventoryItem.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import {
    createInventoryItem,
    toInventoryItemDTO,
    updateInventoryItem,
} from "../src/services/canonicalInventoryService.js"
import {
    assertInventoryDomainAllowedForBusiness,
    resolveAllowedInventoryDomains,
} from "../src/services/inventoryDomainService.js"
import { resolveInventoryStockTransition } from "../src/services/inventoryNotificationService.js"
import { recordRoomUsage } from "../src/services/inventoryRoomUsageService.js"
import {
    assertInventoryItemRecipeDomainChange,
    validateIngredientRecipeRelationship,
} from "../src/services/menuInventoryRecipeService.js"

const ACTOR = { staffId: "owner_1", role: "owner", name: "Owner One" }
const HOTEL = { businessId: "hotel_a", businessType: "hotel", modules: ["lodging"] }
const MIXED_HOTEL = { ...HOTEL, modules: ["lodging", "foodService"] }

function clone(value) {
    return structuredClone(value)
}

function itemDocument(raw, save) {
    return {
        ...clone(raw),
        async save() {
            await save(this)
            return this
        },
        toObject() {
            const value = { ...this }
            delete value.save
            delete value.toObject
            return clone(value)
        },
    }
}

function buildRoomUsageHarness({
    items,
    roomBusinessId = "hotel_a",
    roomType = "room",
    roomActive = true,
    business = HOTEL,
    failMovementCreate = false,
    housekeepingOperation = null,
    rejectConcurrentSessionReads = false,
} = {}) {
    let persistedItems = clone(items || [
        {
            inventoryItemId: "inv_soap",
            businessId: "hotel_a",
            name: "Soap",
            domain: "guest_supplies",
            category: "Bathroom Amenities",
            trackingUnit: "piece",
            baseUnitDimension: "count",
            onHandQuantity: 10,
            reservedQuantity: 4,
            lowStockThreshold: 3,
            unitCostMinor: null,
            costCurrency: null,
            isActive: true,
            deletedAt: null,
        },
        {
            inventoryItemId: "inv_shampoo",
            businessId: "hotel_a",
            name: "Shampoo",
            domain: "housekeeping",
            category: "Bathroom Amenities",
            trackingUnit: "bottle",
            baseUnitDimension: "count",
            onHandQuantity: 8,
            reservedQuantity: 1,
            lowStockThreshold: 2,
            unitCostMinor: 100,
            costCurrency: "EUR",
            isActive: true,
            deletedAt: null,
        },
    ])
    let persistedMovements = []
    let persistedHousekeepingOperation = clone(housekeepingOperation)
    let sequence = 0
    let transactionQueue = Promise.resolve()

    function stateFor(session) {
        return session?.state || {
            items: persistedItems,
            movements: persistedMovements,
            housekeepingOperation: persistedHousekeepingOperation,
        }
    }

    async function sessionRead(session, read) {
        if (!rejectConcurrentSessionReads || !session) return read()
        if (session.activeReads > 0) throw new Error("parallel transaction operation")
        session.activeReads = (session.activeReads || 0) + 1
        try {
            await new Promise((resolve) => setImmediate(resolve))
            return read()
        } finally {
            session.activeReads -= 1
        }
    }

    const dependencies = {
        BusinessModel: {
            async findOne(filter, _projection, options = {}) {
                return sessionRead(options.session, () => (
                    filter.businessId === business.businessId ? clone(business) : null
                ))
            },
        },
        ServicePointModel: {
            async findOne(filter, _projection, options = {}) {
                return sessionRead(options.session, () => {
                    if (
                        filter.businessId !== roomBusinessId ||
                        filter.servicePointId !== "sp_room_401" ||
                        filter.servicePointType !== roomType ||
                        filter.isActive !== roomActive
                    ) return null
                    return {
                        businessId: roomBusinessId,
                        servicePointId: "sp_room_401",
                        servicePointType: roomType,
                        isActive: roomActive,
                        label: "Room 401",
                        roomType: "Deluxe King",
                    }
                })
            },
        },
        InventoryItemModel: {
            async find(filter, _projection, options = {}) {
                const state = stateFor(options.session)
                const ids = new Set(filter.inventoryItemId.$in)
                return state.items
                    .filter((item) => item.businessId === filter.businessId && ids.has(item.inventoryItemId) && !item.deletedAt)
                    .map((raw) => itemDocument(raw, async (document) => {
                        const index = state.items.findIndex((item) => item.inventoryItemId === document.inventoryItemId)
                        const value = document.toObject()
                        state.items[index] = value
                    }))
            },
        },
        InventoryMovementModel: {
            async find(filter, _projection, options = {}) {
                const state = stateFor(options.session)
                return state.movements.filter((movement) => (
                    movement.businessId === filter.businessId &&
                    movement.sourceType === filter.sourceType &&
                    movement.operationId === filter.operationId
                ))
            },
            async create(inputs, { session, ordered }) {
                assert.equal(
                    ordered,
                    true,
                    "multi-item Room Usage must use an ordered insert inside its MongoDB session",
                )
                if (failMovementCreate) throw new Error("injected ledger failure")
                const state = stateFor(session)
                const movements = inputs.map((input) => ({
                    _id: `movement_${input.movementId}`,
                    ...clone(input),
                    createdAt: new Date(),
                }))
                state.movements.push(...movements)
                return movements
            },
        },
        HousekeepingOperationModel: {
            async findOne(filter, _projection, options = {}) {
                const operation = stateFor(options.session).housekeepingOperation
                if (
                    !operation ||
                    operation.businessId !== filter.businessId ||
                    operation.housekeepingOperationId !== filter.housekeepingOperationId
                ) return null
                return clone(operation)
            },
            async findOneAndUpdate(filter, update, options = {}) {
                const state = stateFor(options.session)
                const operation = state.housekeepingOperation
                if (!operation || operation._id !== filter._id || operation.businessId !== filter.businessId) return null
                for (const field of ["servicePointId", "status", "active", "supplyOutcome"]) {
                    if (Object.hasOwn(filter, field) && operation[field] !== filter[field]) return null
                }
                Object.assign(operation, clone(update.$set || {}))
                return clone(operation)
            },
        },
        generateMovementId: () => `imv_${++sequence}`,
        startSession: async () => ({
            state: null,
            async withTransaction(work) {
                let release
                const previous = transactionQueue
                transactionQueue = new Promise((resolve) => { release = resolve })
                await previous
                this.state = {
                    items: clone(persistedItems),
                    movements: clone(persistedMovements),
                    housekeepingOperation: clone(persistedHousekeepingOperation),
                }
                try {
                    await work()
                    persistedItems = clone(this.state.items)
                    persistedMovements = clone(this.state.movements)
                    persistedHousekeepingOperation = clone(this.state.housekeepingOperation)
                } finally {
                    this.state = null
                    release()
                }
            },
            async endSession() {},
        }),
        notifyInventoryTransitions: async () => ({ created: 0 }),
    }

    return {
        dependencies,
        snapshot() {
            return {
                items: clone(persistedItems),
                movements: clone(persistedMovements),
                housekeepingOperation: clone(persistedHousekeepingOperation),
            }
        },
    }
}

function command(overrides = {}) {
    return {
        businessId: "hotel_a",
        servicePointId: "sp_room_401",
        items: [
            { inventoryItemId: "inv_soap", quantity: 2, unit: "piece" },
            { inventoryItemId: "inv_shampoo", quantity: 2, unit: "bottle" },
        ],
        note: "Evening room service",
        actor: ACTOR,
        idempotencyKey: "room-usage-request-1",
        ...overrides,
    }
}

test("hotel inventory domains are validated, capability-aware, and backward compatible", async () => {
    assert.deepEqual(resolveAllowedInventoryDomains(HOTEL), HOTEL_OPERATIONAL_INVENTORY_DOMAINS)
    assert.deepEqual(resolveAllowedInventoryDomains(MIXED_HOTEL), [
        INVENTORY_ITEM_DOMAINS.FOOD_SERVICE,
        ...HOTEL_OPERATIONAL_INVENTORY_DOMAINS,
    ])
    assert.equal(assertInventoryDomainAllowedForBusiness(HOTEL, "guest_supplies"), "guest_supplies")
    assert.throws(
        () => assertInventoryDomainAllowedForBusiness(HOTEL, "food_service"),
        (error) => error.code === "INVENTORY_DOMAIN_NOT_ENABLED",
    )
    assert.throws(
        () => assertInventoryDomainAllowedForBusiness(HOTEL, "minibar"),
        (error) => error.code === "INVALID_INVENTORY_DOMAIN",
    )
    assert.equal(toInventoryItemDTO({
        inventoryItemId: "legacy_food",
        name: "Tomatoes",
        trackingUnit: "g",
        onHandQuantity: 10,
        reservedQuantity: 0,
        lowStockThreshold: 1,
    }).domain, "food_service")
})

test("canonical item create and edit preserve the hotel domain", async () => {
    let stored = null
    const InventoryItemModel = {
        async find() { return [] },
        async create(input) {
            stored = clone(input)
            return itemDocument(input, async () => {})
        },
        async findOne(filter) {
            if (!stored || stored.inventoryItemId !== filter.inventoryItemId) return null
            return itemDocument(stored, async (document) => { stored = document.toObject() })
        },
    }
    const created = await createInventoryItem({
        businessId: "hotel_a",
        input: {
            name: "Shampoo Bottle",
            domain: "guest_supplies",
            category: "Bathroom Amenities",
            trackingUnit: "bottle",
            lowStockThreshold: 20,
        },
    }, { InventoryItemModel, generateId: () => "inv_shampoo" })
    assert.equal(created.domain, "guest_supplies")

    const updated = await updateInventoryItem({
        businessId: "hotel_a",
        inventoryItemId: "inv_shampoo",
        input: { domain: "housekeeping" },
    }, {
        InventoryItemModel,
        InventoryMovementModel: { async exists() { return false } },
    })
    assert.equal(updated.domain, "housekeeping")
})

test("recipes accept legacy Food Service items and reject hotel operational domains", async () => {
    const menuItemId = "507f1f77bcf86cd799439099"
    const MenuItemModel = {
        async findOne() {
            return { _id: menuItemId, businessId: "hotel_a", archivedAt: null }
        },
    }
    const validateWithItem = (inventoryItem) => validateIngredientRecipeRelationship({
        businessId: "hotel_a",
        menuItemId,
        components: [{ inventoryItemId: inventoryItem.inventoryItemId, quantity: 1, unit: "piece" }],
    }, {
        MenuItemModel,
        InventoryItemModel: { async find() { return [inventoryItem] } },
    })

    const legacy = await validateWithItem({
        inventoryItemId: "inv_legacy_food",
        businessId: "hotel_a",
        trackingUnit: "piece",
        isActive: true,
    })
    assert.equal(legacy.components[0].inventoryItemId, "inv_legacy_food")

    await assert.rejects(
        validateWithItem({
            inventoryItemId: "inv_guest_supply",
            businessId: "hotel_a",
            domain: "guest_supplies",
            trackingUnit: "piece",
            isActive: true,
        }),
        (error) => error.code === "INVENTORY_ITEM_NOT_FOOD_SERVICE" && error.statusCode === 409,
    )

    await assertInventoryItemRecipeDomainChange({
        businessId: "hotel_a",
        inventoryItemId: "inv_unlinked",
        domain: "linen",
    }, { MenuInventoryRecipeModel: { async exists() { return false } } })
    await assert.rejects(
        assertInventoryItemRecipeDomainChange({
            businessId: "hotel_a",
            inventoryItemId: "inv_linked",
            domain: "linen",
        }, { MenuInventoryRecipeModel: { async exists() { return true } } }),
        (error) => error.code === "INVENTORY_ITEM_HAS_MENU_RELATIONSHIP" && error.statusCode === 409,
    )
})

test("multi-item Room Usage consumes available stock atomically and records canonical context", async () => {
    const harness = buildRoomUsageHarness()
    const result = await recordRoomUsage(command(), harness.dependencies)
    const state = harness.snapshot()

    assert.equal(result.replayed, false)
    assert.equal(result.room.servicePointId, "sp_room_401")
    assert.deepEqual(state.items.map((item) => [item.inventoryItemId, item.onHandQuantity, item.reservedQuantity]), [
        ["inv_soap", 8, 4],
        ["inv_shampoo", 6, 1],
    ])
    assert.equal(state.movements.length, 2)
    for (const movement of state.movements) {
        assert.equal(movement.type, "CONSUME")
        assert.equal(movement.quantityDeltaReserved, 0)
        assert.equal(movement.servicePointId, "sp_room_401")
        assert.equal(movement.sourceType, "room_usage")
        assert.equal(movement.sourceId, result.operationId)
        assert.equal(movement.operationId, result.operationId)
        assert.deepEqual(movement.performedBy, ACTOR)
    }
})

test("Housekeeping supplies reuse canonical Room Usage and persist the operation outcome atomically", async () => {
    const operation = {
        _id: "housekeeping_mongo_1",
        housekeepingOperationId: "hko_room_401",
        businessId: "hotel_a",
        servicePointId: "sp_room_401",
        status: "cleaning",
        active: true,
        claimedBy: "HSK-1001",
        supplyOutcome: "pending",
        roomUsageOperationId: null,
    }
    const housekeeper = { staffId: "HSK-1001", role: "housekeeping", name: "Sarah" }
    const harness = buildRoomUsageHarness({ housekeepingOperation: operation })
    const input = command({
        actor: housekeeper,
        idempotencyKey: undefined,
        housekeepingOperationId: operation.housekeepingOperationId,
    })

    const first = await recordRoomUsage(input, harness.dependencies)
    assert.equal(first.replayed, false)
    assert.equal(first.housekeepingOperationId, operation.housekeepingOperationId)
    assert.equal(harness.snapshot().housekeepingOperation.supplyOutcome, "recorded")
    assert.equal(harness.snapshot().housekeepingOperation.roomUsageOperationId, first.operationId)

    const replay = await recordRoomUsage(input, harness.dependencies)
    assert.equal(replay.replayed, true)
    assert.equal(harness.snapshot().movements.length, 2)
    assert.deepEqual(harness.snapshot().items.map((item) => item.onHandQuantity), [8, 6])

    const insufficient = buildRoomUsageHarness({ housekeepingOperation: operation })
    await assert.rejects(
        recordRoomUsage(command({
            actor: housekeeper,
            idempotencyKey: undefined,
            housekeepingOperationId: operation.housekeepingOperationId,
            items: [{ inventoryItemId: "inv_soap", quantity: 7, unit: "piece" }],
        }), insufficient.dependencies),
        (error) => error.code === "INSUFFICIENT_AVAILABLE_INVENTORY",
    )
    assert.equal(insufficient.snapshot().housekeepingOperation.supplyOutcome, "pending")
    assert.equal(insufficient.snapshot().movements.length, 0)
    assert.deepEqual(insufficient.snapshot().items.map((item) => item.onHandQuantity), [10, 8])
})

test("Housekeeping Room Usage keeps MongoDB transaction reads sequential", async () => {
    const operation = {
        _id: "housekeeping_mongo_sequential",
        housekeepingOperationId: "hko_room_401_sequential",
        businessId: "hotel_a",
        servicePointId: "sp_room_401",
        status: "cleaning",
        active: true,
        claimedBy: "HSK-1001",
        supplyOutcome: "pending",
        roomUsageOperationId: null,
    }
    const harness = buildRoomUsageHarness({
        housekeepingOperation: operation,
        rejectConcurrentSessionReads: true,
    })

    const result = await recordRoomUsage(command({
        actor: { staffId: "HSK-1001", role: "housekeeping", name: "Sarah" },
        idempotencyKey: undefined,
        housekeepingOperationId: operation.housekeepingOperationId,
    }), harness.dependencies)

    assert.equal(result.replayed, false)
    assert.equal(harness.snapshot().housekeepingOperation.supplyOutcome, "recorded")
})

test("Room Usage validates canonical room and tenant-owned active hotel items", async () => {
    const wrongRoom = buildRoomUsageHarness({ roomBusinessId: "hotel_b" })
    await assert.rejects(
        recordRoomUsage(command(), wrongRoom.dependencies),
        (error) => error.code === "ROOM_SERVICE_POINT_NOT_FOUND",
    )

    const crossTenantItem = buildRoomUsageHarness({
        items: [{
            inventoryItemId: "inv_soap",
            businessId: "hotel_b",
            name: "Soap",
            domain: "guest_supplies",
            trackingUnit: "piece",
            onHandQuantity: 10,
            reservedQuantity: 0,
            lowStockThreshold: 2,
            isActive: true,
            deletedAt: null,
        }],
    })
    await assert.rejects(
        recordRoomUsage(command({ items: [{ inventoryItemId: "inv_soap", quantity: 1, unit: "piece" }] }), crossTenantItem.dependencies),
        (error) => error.code === "ROOM_USAGE_INVENTORY_ITEM_NOT_FOUND",
    )

    const foodItem = buildRoomUsageHarness({
        items: [{
            inventoryItemId: "inv_soap",
            businessId: "hotel_a",
            name: "Soup",
            domain: "food_service",
            trackingUnit: "piece",
            onHandQuantity: 10,
            reservedQuantity: 0,
            lowStockThreshold: 2,
            isActive: true,
            deletedAt: null,
        }],
    })
    await assert.rejects(
        recordRoomUsage(command({ items: [{ inventoryItemId: "inv_soap", quantity: 1, unit: "piece" }] }), foodItem.dependencies),
        (error) => error.code === "INVENTORY_ITEM_NOT_ROOM_USAGE_ELIGIBLE",
    )
})

test("Room Usage rejects duplicate, invalid, inactive, archived, and insufficient lines", async () => {
    const harness = buildRoomUsageHarness()
    await assert.rejects(
        recordRoomUsage(command({ items: [
            { inventoryItemId: "inv_soap", quantity: 1, unit: "piece" },
            { inventoryItemId: "inv_soap", quantity: 1, unit: "piece" },
        ] }), harness.dependencies),
        (error) => error.code === "DUPLICATE_ROOM_USAGE_ITEM",
    )
    await assert.rejects(
        recordRoomUsage(command({ items: [{ inventoryItemId: "inv_soap", quantity: 0, unit: "piece" }] }), harness.dependencies),
        /greater than zero/,
    )
    await assert.rejects(
        recordRoomUsage(command({ items: [{ inventoryItemId: "inv_soap", quantity: 1, unit: "ml" }] }), harness.dependencies),
        /Cannot convert/,
    )
    await assert.rejects(
        recordRoomUsage(command({ items: [{ inventoryItemId: "inv_soap", quantity: 7, unit: "piece" }] }), harness.dependencies),
        (error) => error.code === "INSUFFICIENT_AVAILABLE_INVENTORY",
    )

    const inactive = buildRoomUsageHarness({ items: [{
        inventoryItemId: "inv_soap",
        businessId: "hotel_a",
        name: "Soap",
        domain: "guest_supplies",
        trackingUnit: "piece",
        onHandQuantity: 10,
        reservedQuantity: 0,
        lowStockThreshold: 2,
        isActive: false,
        deletedAt: null,
    }] })
    await assert.rejects(
        recordRoomUsage(command({ items: [{ inventoryItemId: "inv_soap", quantity: 1, unit: "piece" }] }), inactive.dependencies),
        (error) => error.code === "INVENTORY_ITEM_INACTIVE",
    )

    const archived = buildRoomUsageHarness({ items: [{
        inventoryItemId: "inv_soap",
        businessId: "hotel_a",
        name: "Soap",
        domain: "guest_supplies",
        trackingUnit: "piece",
        onHandQuantity: 10,
        reservedQuantity: 0,
        lowStockThreshold: 2,
        isActive: true,
        deletedAt: new Date(),
    }] })
    await assert.rejects(
        recordRoomUsage(command({ items: [{ inventoryItemId: "inv_soap", quantity: 1, unit: "piece" }] }), archived.dependencies),
        (error) => error.code === "ROOM_USAGE_INVENTORY_ITEM_NOT_FOUND",
    )
})

test("one failing line and ledger failure roll back the entire Room Usage operation", async () => {
    const insufficient = buildRoomUsageHarness()
    await assert.rejects(
        recordRoomUsage(command({ items: [
            { inventoryItemId: "inv_soap", quantity: 2, unit: "piece" },
            { inventoryItemId: "inv_shampoo", quantity: 8, unit: "bottle" },
        ] }), insufficient.dependencies),
        (error) => error.code === "INSUFFICIENT_AVAILABLE_INVENTORY",
    )
    assert.deepEqual(insufficient.snapshot().items.map((item) => item.onHandQuantity), [10, 8])
    assert.equal(insufficient.snapshot().movements.length, 0)

    const ledgerFailure = buildRoomUsageHarness({ failMovementCreate: true })
    await assert.rejects(recordRoomUsage(command(), ledgerFailure.dependencies), /ledger failure/)
    assert.deepEqual(ledgerFailure.snapshot().items.map((item) => item.onHandQuantity), [10, 8])
    assert.equal(ledgerFailure.snapshot().movements.length, 0)
})

test("exact retries and rapid duplicate submissions consume once", async () => {
    const harness = buildRoomUsageHarness()
    const [first, second] = await Promise.all([
        recordRoomUsage(command(), harness.dependencies),
        recordRoomUsage(command(), harness.dependencies),
    ])
    const state = harness.snapshot()
    assert.equal([first, second].filter((result) => result.replayed).length, 1)
    assert.deepEqual(state.items.map((item) => item.onHandQuantity), [8, 6])
    assert.equal(state.movements.length, 2)

    await assert.rejects(
        recordRoomUsage(command({
            items: [{ inventoryItemId: "inv_soap", quantity: 1, unit: "piece" }],
        }), harness.dependencies),
        (error) => error.code === "INVENTORY_IDEMPOTENCY_CONFLICT",
    )
})

test("concurrent different Room Usage keys cannot overspend available stock", async () => {
    const harness = buildRoomUsageHarness({ items: [{
        inventoryItemId: "inv_soap",
        businessId: "hotel_a",
        name: "Soap",
        domain: "guest_supplies",
        trackingUnit: "piece",
        onHandQuantity: 5,
        reservedQuantity: 0,
        lowStockThreshold: 1,
        isActive: true,
        deletedAt: null,
    }] })
    const results = await Promise.allSettled([
        recordRoomUsage(command({
            idempotencyKey: "concurrent-a",
            items: [{ inventoryItemId: "inv_soap", quantity: 4, unit: "piece" }],
        }), harness.dependencies),
        recordRoomUsage(command({
            idempotencyKey: "concurrent-b",
            items: [{ inventoryItemId: "inv_soap", quantity: 4, unit: "piece" }],
        }), harness.dependencies),
    ])
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
    assert.equal(results.filter((result) => result.status === "rejected").length, 1)
    assert.equal(harness.snapshot().items[0].onHandQuantity, 1)
    assert.equal(harness.snapshot().movements.length, 1)
})

test("notification failure is isolated after the authoritative stock commit", async () => {
    const harness = buildRoomUsageHarness()
    harness.dependencies.notifyInventoryTransitions = async () => {
        throw new Error("notification unavailable")
    }
    const result = await recordRoomUsage(command(), harness.dependencies)
    assert.equal(result.replayed, false)
    assert.deepEqual(harness.snapshot().items.map((item) => item.onHandQuantity), [8, 6])
    assert.equal(harness.snapshot().movements.length, 2)
})

test("Room Usage reuses canonical low and out-of-stock transition semantics", () => {
    const item = { lowStockThreshold: 3 }
    assert.equal(resolveInventoryStockTransition({
        item,
        movement: { onHandBefore: 5, reservedBefore: 0, onHandAfter: 3, reservedAfter: 0 },
    }).type, "inventory.low_stock_entered")
    assert.equal(resolveInventoryStockTransition({
        item,
        movement: { onHandBefore: 3, reservedBefore: 0, onHandAfter: 2, reservedAfter: 0 },
    }), null)
    assert.equal(resolveInventoryStockTransition({
        item,
        movement: { onHandBefore: 2, reservedBefore: 0, onHandAfter: 0, reservedAfter: 0 },
    }).type, "inventory.out_of_stock_entered")
    assert.equal(resolveInventoryStockTransition({
        item,
        movement: { onHandBefore: 0, reservedBefore: 0, onHandAfter: 0, reservedAfter: 0 },
    }), null)
    assert.equal(resolveInventoryStockTransition({
        item,
        movement: { onHandBefore: 5, reservedBefore: 0, onHandAfter: 3, reservedAfter: 0 },
    }).type, "inventory.low_stock_entered")
})

test("Room Usage movements validate as immutable canonical CONSUME records", async () => {
    const movement = new InventoryMovement({
        movementId: "imv_room_usage",
        businessId: "hotel_a",
        inventoryItemId: "inv_soap",
        type: "CONSUME",
        quantityDeltaOnHand: -2,
        quantityDeltaReserved: 0,
        unit: "piece",
        canonicalQuantity: 2,
        onHandBefore: 10,
        onHandAfter: 8,
        reservedBefore: 4,
        reservedAfter: 4,
        sourceType: "room_usage",
        sourceId: "iru_1",
        servicePointId: "sp_room_401",
        operationId: "iru_1",
        performedBy: ACTOR,
        idempotencyKey: "iru_1:soap",
        requestFingerprint: "a".repeat(64),
    })
    await movement.validate()
    movement.servicePointId = null
    await assert.rejects(movement.validate(), /Room Usage metadata/)
})

test("route permissions and implementation avoid reservation or check-in integration", async () => {
    const [ownerRoutes, roomUsageSource] = await Promise.all([
        readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/services/inventoryRoomUsageService.js", import.meta.url), "utf8"),
    ])
    assert.match(
        ownerRoutes,
        /"\/inventory\/room-usage"[\s\S]*PERMISSIONS\.INVENTORY_MANAGE[\s\S]*recordOwnerRoomUsage/,
    )
    assert.match(roomUsageSource, /servicePointType: "room"/)
    assert.doesNotMatch(roomUsageSource, /models\/RoomType|MenuInventoryRecipe|check.?in|reservation creation/i)
})

test("InventoryItem accepts hotel domains and rejects unknown domains", async () => {
    const valid = new InventoryItem({
        inventoryItemId: "inv_linen",
        businessId: "hotel_a",
        name: "Bath Towel",
        domain: "linen",
        trackingUnit: "piece",
        baseUnitDimension: "count",
        onHandQuantity: 20,
        reservedQuantity: 0,
        lowStockThreshold: 4,
    })
    await valid.validate()

    valid.domain = "minibar"
    await assert.rejects(valid.validate(), /not a valid enum value/)
})
