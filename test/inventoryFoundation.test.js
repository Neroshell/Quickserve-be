import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
    INVENTORY_MOVEMENT_TYPES,
    MAX_INVENTORY_QUANTITY,
} from "../src/constants/inventory.js"
import { normalizePermissions, PERMISSIONS } from "../src/constants/permissions.js"
import { MANAGEMENT_ACCESS_AREAS } from "../src/constants/managementAccess.js"
import InventoryItem from "../src/models/InventoryItem.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import {
    adjustInventory,
    createInventoryItem,
    InventoryDomainError,
    receiveInventory,
    recordInventoryWaste,
    updateInventoryItem,
} from "../src/services/canonicalInventoryService.js"
import {
    InventoryUomError,
    normalizeInventoryQuantity,
} from "../src/services/inventoryUomService.js"

function clone(value) {
    return structuredClone(value)
}

function makeDocument(raw, save) {
    const doc = {
        ...clone(raw),
        async save(options = {}) {
            await save(this, options)
            return this
        },
        toObject() {
            const plain = { ...this }
            delete plain.save
            delete plain.toObject
            return clone(plain)
        },
    }
    return doc
}

function buildTransactionalHarness({
    businessId = "biz_alpha",
    inventoryItemId = "inv_alpha",
    onHandQuantity = 0,
    reservedQuantity = 0,
    failMovementCreate = false,
} = {}) {
    let persistedItem = {
        _id: "507f1f77bcf86cd799439011",
        inventoryItemId,
        businessId,
        name: "Chicken Breast",
        category: "Ingredients",
        trackingUnit: "g",
        baseUnitDimension: "weight",
        onHandQuantity,
        reservedQuantity,
        lowStockThreshold: 500,
        unitCostMinor: null,
        costCurrency: null,
        isActive: true,
        createdAt: new Date("2026-09-01T10:00:00.000Z"),
        updatedAt: new Date("2026-09-01T10:00:00.000Z"),
    }
    let persistedMovements = []
    let movementSequence = 0

    function stateFor(session) {
        return session?.transactionState || {
            get item() { return persistedItem },
            set item(value) { persistedItem = value },
            get movements() { return persistedMovements },
            set movements(value) { persistedMovements = value },
        }
    }

    function itemDocument(state) {
        return makeDocument(state.item, async (doc) => {
            const next = doc.toObject()
            next.updatedAt = new Date()
            state.item = next
        })
    }

    function movementDocument(raw) {
        return {
            ...clone(raw),
            toObject() {
                const plain = { ...this }
                delete plain.toObject
                return clone(plain)
            },
        }
    }

    const InventoryItemModel = {
        async findOne(filter, _projection, options = {}) {
            const state = stateFor(options?.session)
            if (
                filter.businessId !== state.item.businessId ||
                filter.inventoryItemId !== state.item.inventoryItemId
            ) return null
            return itemDocument(state)
        },
    }

    const InventoryMovementModel = {
        async findOne(filter, _projection, options = {}) {
            const state = stateFor(options?.session)
            const found = state.movements.find((movement) => (
                movement.businessId === filter.businessId &&
                movement.idempotencyKey === filter.idempotencyKey
            ))
            return found ? movementDocument(found) : null
        },
        async create([data], { session }) {
            if (failMovementCreate) throw new Error("injected movement failure")
            const state = stateFor(session)
            movementSequence += 1
            const movement = {
                _id: `507f1f77bcf86cd7994390${String(movementSequence).padStart(2, "0")}`,
                ...clone(data),
                createdAt: new Date(),
            }
            state.movements = [...state.movements, movement]
            return [movementDocument(movement)]
        },
        async exists(filter) {
            return persistedMovements.some((movement) => (
                movement.businessId === filter.businessId &&
                movement.inventoryItemId === filter.inventoryItemId
            ))
        },
    }

    function startSession() {
        return Promise.resolve({
            transactionState: null,
            async withTransaction(work) {
                this.transactionState = {
                    item: clone(persistedItem),
                    movements: clone(persistedMovements),
                }
                try {
                    await work()
                    persistedItem = clone(this.transactionState.item)
                    persistedMovements = clone(this.transactionState.movements)
                } finally {
                    this.transactionState = null
                }
            },
            async endSession() {},
        })
    }

    return {
        dependencies: {
            InventoryItemModel,
            InventoryMovementModel,
            startSession,
            generateMovementId: () => `imv_${movementSequence + 1}`,
        },
        snapshot() {
            return {
                item: clone(persistedItem),
                movements: clone(persistedMovements),
            }
        },
    }
}

const ACTOR = { staffId: "owner_1", role: "owner", name: "Owner One" }

test("UOM normalization uses exact canonical integer arithmetic", () => {
    assert.deepEqual(
        normalizeInventoryQuantity({ quantity: "2.5", unit: "kg", trackingUnit: "g" }),
        {
            submittedUnit: "kg",
            trackingUnit: "g",
            dimension: "weight",
            canonicalQuantity: 2500,
        },
    )
    assert.equal(
        normalizeInventoryQuantity({ quantity: "1.75", unit: "L", trackingUnit: "ml" }).canonicalQuantity,
        1750,
    )
    assert.equal(
        normalizeInventoryQuantity({ quantity: "12", unit: "bottle", trackingUnit: "bottle" }).canonicalQuantity,
        12,
    )
    assert.throws(
        () => normalizeInventoryQuantity({ quantity: "1", unit: "kg", trackingUnit: "ml" }),
        (error) => error instanceof InventoryUomError && error.code === "INCOMPATIBLE_INVENTORY_UNIT",
    )
    assert.throws(
        () => normalizeInventoryQuantity({ quantity: "1", unit: "pack", trackingUnit: "piece" }),
        /cannot be treated as/,
    )
    assert.throws(
        () => normalizeInventoryQuantity({ quantity: "0.5", unit: "g", trackingUnit: "g" }),
        /whole g/,
    )
    assert.throws(
        () => normalizeInventoryQuantity({ quantity: String(MAX_INVENTORY_QUANTITY + 1), unit: "g", trackingUnit: "g" }),
        /maximum safe/,
    )
})

test("InventoryItem enforces canonical balance and cost invariants", async () => {
    const item = new InventoryItem({
        inventoryItemId: "inv_test",
        businessId: "biz_alpha",
        name: "Cooking Oil",
        trackingUnit: "ml",
        baseUnitDimension: "volume",
        onHandQuantity: 1000,
        reservedQuantity: 250,
        lowStockThreshold: 200,
    })
    await item.validate()

    item.onHandQuantity = 100
    await assert.rejects(item.validate(), /lower than reservedQuantity/)

    const mismatched = new InventoryItem({
        inventoryItemId: "inv_bad",
        businessId: "biz_alpha",
        name: "Bad Unit",
        trackingUnit: "g",
        baseUnitDimension: "volume",
    })
    await assert.rejects(mismatched.validate(), /baseUnitDimension must be weight/)

    const incompleteCost = new InventoryItem({
        inventoryItemId: "inv_cost",
        businessId: "biz_alpha",
        name: "Costed",
        trackingUnit: "piece",
        baseUnitDimension: "count",
        unitCostMinor: 50,
    })
    await assert.rejects(incompleteCost.validate(), /provided together/)
})

test("inventory schemas declare tenant, history, and idempotency indexes", () => {
    const itemIndexes = InventoryItem.schema.indexes().map(([fields, options]) => ({ fields, options }))
    const movementIndexes = InventoryMovement.schema.indexes().map(([fields, options]) => ({ fields, options }))

    assert.ok(itemIndexes.some(({ fields, options }) => (
        fields.businessId === 1 && fields.inventoryItemId === 1 && options.unique === true
    )))
    assert.ok(movementIndexes.some(({ fields, options }) => (
        fields.businessId === 1 && fields.idempotencyKey === 1 && options.unique === true
    )))
    assert.ok(movementIndexes.some(({ fields }) => (
        fields.businessId === 1 && fields.inventoryItemId === 1 && fields.createdAt === -1
    )))
    assert.ok(movementIndexes.some(({ fields }) => (
        fields.businessId === 1 && fields.sourceType === 1 && fields.sourceId === 1
    )))
})

test("inventory item creation always starts at zero and rejects direct balance input", async () => {
    let written = null
    const InventoryItemModel = {
        async create(data) {
            written = data
            return { ...data, createdAt: new Date(), updatedAt: new Date() }
        },
    }
    const item = await createInventoryItem({
        businessId: "biz_alpha",
        input: {
            name: "Burger Buns",
            category: "Bakery",
            trackingUnit: "piece",
            lowStockThreshold: 10,
        },
    }, {
        InventoryItemModel,
        generateId: () => "inv_buns",
    })

    assert.equal(written.businessId, "biz_alpha")
    assert.equal(written.onHandQuantity, 0)
    assert.equal(written.reservedQuantity, 0)
    assert.equal(item.availableQuantity, 0)

    await assert.rejects(
        createInventoryItem({
            businessId: "biz_alpha",
            input: { name: "Unsafe", trackingUnit: "piece", onHandQuantity: 100 },
        }, { InventoryItemModel }),
        (error) => error instanceof InventoryDomainError && error.code === "INVENTORY_BALANCE_FIELD_FORBIDDEN",
    )
})

test("inventory metadata cannot bypass balances or change a tracking unit after ledger use", async () => {
    const raw = {
        inventoryItemId: "inv_locked",
        businessId: "biz_alpha",
        name: "Locked Item",
        category: null,
        trackingUnit: "g",
        baseUnitDimension: "weight",
        onHandQuantity: 0,
        reservedQuantity: 0,
        lowStockThreshold: 0,
        unitCostMinor: null,
        costCurrency: null,
        isActive: true,
    }
    const document = makeDocument(raw, async () => {})
    const dependencies = {
        InventoryItemModel: { async findOne() { return document } },
        InventoryMovementModel: { async exists() { return true } },
    }

    await assert.rejects(
        updateInventoryItem({
            businessId: "biz_alpha",
            inventoryItemId: "inv_locked",
            input: { reservedQuantity: 2 },
        }, dependencies),
        (error) => error.code === "INVENTORY_BALANCE_FIELD_FORBIDDEN",
    )
    await assert.rejects(
        updateInventoryItem({
            businessId: "biz_alpha",
            inventoryItemId: "inv_locked",
            input: { trackingUnit: "ml" },
        }, dependencies),
        (error) => error.code === "INVENTORY_TRACKING_UNIT_LOCKED" && error.statusCode === 409,
    )
})

test("InventoryMovement rejects document and query mutation attempts", async () => {
    const movement = new InventoryMovement({
        movementId: "imv_immutable",
        businessId: "biz_alpha",
        inventoryItemId: "inv_alpha",
        type: "RECEIVE",
        quantityDeltaOnHand: 1,
        quantityDeltaReserved: 0,
        unit: "g",
        canonicalQuantity: 1,
        onHandBefore: 0,
        onHandAfter: 1,
        reservedBefore: 0,
        reservedAfter: 0,
        sourceType: "manual_receive",
        performedBy: ACTOR,
        idempotencyKey: "immutable-key",
        requestFingerprint: "a".repeat(64),
    })
    movement.$isNew = false
    await assert.rejects(movement.save(), /InventoryMovement is immutable/)
    await assert.rejects(
        InventoryMovement.updateOne({ movementId: "imv_immutable" }, { $set: { note: "changed" } }),
        /InventoryMovement is immutable/,
    )
})

test("receiving changes On Hand and writes one immutable movement in the same transaction", async () => {
    const harness = buildTransactionalHarness()
    const result = await receiveInventory({
        businessId: "biz_alpha",
        inventoryItemId: "inv_alpha",
        input: { quantity: "2.5", unit: "kg", reference: "DEL-100", note: "Morning delivery" },
        actor: ACTOR,
        idempotencyKey: "receive-1",
    }, harness.dependencies)

    const state = harness.snapshot()
    assert.equal(result.replayed, false)
    assert.equal(state.item.onHandQuantity, 2500)
    assert.equal(state.item.reservedQuantity, 0)
    assert.equal(state.movements.length, 1)
    assert.equal(state.movements[0].type, INVENTORY_MOVEMENT_TYPES.RECEIVE)
    assert.equal(state.movements[0].quantityDeltaOnHand, 2500)
    assert.equal(state.movements[0].quantityDeltaReserved, 0)
    assert.deepEqual(state.movements[0].performedBy, ACTOR)
})

test("movement idempotency replays identical input and conflicts on changed input", async () => {
    const harness = buildTransactionalHarness()
    const command = {
        businessId: "biz_alpha",
        inventoryItemId: "inv_alpha",
        input: { quantity: 100, unit: "g" },
        actor: ACTOR,
        idempotencyKey: "same-key",
    }
    await receiveInventory(command, harness.dependencies)
    const replay = await receiveInventory(command, harness.dependencies)
    assert.equal(replay.replayed, true)
    assert.equal(harness.snapshot().item.onHandQuantity, 100)
    assert.equal(harness.snapshot().movements.length, 1)

    await assert.rejects(
        receiveInventory({ ...command, input: { quantity: 101, unit: "g" } }, harness.dependencies),
        (error) => error.code === "INVENTORY_IDEMPOTENCY_CONFLICT" && error.statusCode === 409,
    )
    assert.equal(harness.snapshot().item.onHandQuantity, 100)
})

test("waste and downward adjustments cannot consume inventory already reserved", async () => {
    const harness = buildTransactionalHarness({ onHandQuantity: 10, reservedQuantity: 8 })

    await assert.rejects(
        recordInventoryWaste({
            businessId: "biz_alpha",
            inventoryItemId: "inv_alpha",
            input: { quantity: 3, unit: "g", reason: "spoilage" },
            actor: ACTOR,
            idempotencyKey: "waste-1",
        }, harness.dependencies),
        (error) => error.code === "INVENTORY_RESERVED_STOCK_CONFLICT",
    )
    assert.equal(harness.snapshot().item.onHandQuantity, 10)
    assert.equal(harness.snapshot().movements.length, 0)

    const adjusted = await adjustInventory({
        businessId: "biz_alpha",
        inventoryItemId: "inv_alpha",
        input: {
            quantity: 5,
            unit: "g",
            direction: "increase",
            reason: "opening_balance_correction",
        },
        actor: ACTOR,
        idempotencyKey: "adjust-1",
    }, harness.dependencies)
    assert.equal(adjusted.movement.type, INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_INCREASE)
    assert.equal(harness.snapshot().item.onHandQuantity, 15)
})

test("movement insertion failure rolls the balance mutation back", async () => {
    const harness = buildTransactionalHarness({ failMovementCreate: true })
    await assert.rejects(
        receiveInventory({
            businessId: "biz_alpha",
            inventoryItemId: "inv_alpha",
            input: { quantity: 100, unit: "g" },
            actor: ACTOR,
            idempotencyKey: "rollback-1",
        }, harness.dependencies),
        /injected movement failure/,
    )
    assert.equal(harness.snapshot().item.onHandQuantity, 0)
    assert.equal(harness.snapshot().movements.length, 0)
})

test("canonical commands are tenant scoped and do not trust request payload business IDs", async () => {
    const harness = buildTransactionalHarness({ businessId: "biz_alpha" })
    await assert.rejects(
        receiveInventory({
            businessId: "biz_other",
            inventoryItemId: "inv_alpha",
            input: { quantity: 100, unit: "g" },
            actor: ACTOR,
            idempotencyKey: "tenant-1",
        }, harness.dependencies),
        (error) => error.code === "INVENTORY_ITEM_NOT_FOUND" && error.statusCode === 404,
    )
    assert.equal(harness.snapshot().item.onHandQuantity, 0)
})

test("inventory permissions extend canonical RBAC with view dependencies", () => {
    assert.equal(MANAGEMENT_ACCESS_AREAS.INVENTORY, "inventory")
    assert.deepEqual(
        normalizePermissions([
            PERMISSIONS.INVENTORY_MANAGE,
            PERMISSIONS.INVENTORY_RECEIVE,
            PERMISSIONS.INVENTORY_WASTE,
            PERMISSIONS.INVENTORY_ADJUST,
        ]).filter((permission) => permission.startsWith("inventory.")),
        [
            PERMISSIONS.INVENTORY_VIEW,
            PERMISSIONS.INVENTORY_MANAGE,
            PERMISSIONS.INVENTORY_RECEIVE,
            PERMISSIONS.INVENTORY_WASTE,
            PERMISSIONS.INVENTORY_ADJUST,
        ],
    )
})

test("inventory routes are permission guarded and Phase 4 centralizes reservation ordering", async () => {
    const ownerRoutes = await readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8")
    for (const permission of [
        "INVENTORY_VIEW",
        "INVENTORY_MANAGE",
        "INVENTORY_RECEIVE",
        "INVENTORY_WASTE",
        "INVENTORY_ADJUST",
    ]) {
        assert.match(ownerRoutes, new RegExp(`requirePermission\\(PERMISSIONS\\.${permission}\\)`))
    }

    for (const path of [
        "../src/controllers/kitchenController.js",
        "../src/controllers/barController.js",
    ]) {
        const source = await readFile(new URL(path, import.meta.url), "utf8")
        assert.doesNotMatch(source, /canonicalInventory|InventoryItem|InventoryMovement|MenuInventoryRecipe/)
    }

    const inventoryService = await readFile(
        new URL("../src/services/inventoryService.js", import.meta.url),
        "utf8",
    )
    assert.match(inventoryService, /createInventoryCompatibilityAdapter/)
    assert.match(inventoryService, /isCanonicalSimpleStockEnabled:\s*\(\)\s*=>\s*true/)
    assert.match(inventoryService, /simpleStockOrderService/)
    assert.doesNotMatch(
        inventoryService,
        /from\s+["'][^"']*(canonicalInventoryService|models\/InventoryItem|models\/InventoryMovement|models\/MenuInventoryRecipe)/,
    )

    for (const path of [
        "../src/controllers/orderController.js",
        "../src/controllers/waitstaffOrdersController.js",
        "../src/controllers/paymentController.js",
        "../src/controllers/webhookController.js",
    ]) {
        const source = await readFile(new URL(path, import.meta.url), "utf8")
        assert.match(source, /inventoryReservation|reserveInventoryForSource|finalizePaidOrderWithInventory/)
    }
})
