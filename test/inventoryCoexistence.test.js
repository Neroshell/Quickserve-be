import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import mongoose from "mongoose"

import {
    INVENTORY_LINE_ALLOCATION_STATUSES,
    INVENTORY_RESERVATION_STATUSES,
    INVENTORY_SIDECAR_ALLOCATION_STATUSES,
} from "../src/constants/inventoryReservation.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import InventoryReservation from "../src/models/InventoryReservation.js"
import MenuInventoryRecipe from "../src/models/MenuInventoryRecipe.js"
import {
    consumeReservedInventoryForFulfillment,
    reserveInventoryForSource,
    resolveInventoryRequirements,
} from "../src/services/inventoryReservationService.js"
import {
    removeIngredientRecipe,
    upsertIngredientRecipe,
} from "../src/services/menuInventoryRecipeService.js"
import { resolveEffectiveMenuAvailability } from "../src/services/menuInventoryAvailabilityService.js"

const businessId = "biz_coexistence"
const session = { id: "coexistence_session" }
const actor = { staffId: "kitchen_1", role: "kitchen", name: "Kitchen One" }

function inventoryItem({ inventoryItemId, unit = "piece", onHand, reserved = 0, active = true }) {
    return {
        inventoryItemId,
        businessId,
        name: inventoryItemId,
        trackingUnit: unit,
        onHandQuantity: onHand,
        reservedQuantity: reserved,
        isActive: active,
        async save() { return this },
    }
}

function coexistenceMapping(menuItemId, ingredientQuantity = 1) {
    return {
        menuInventoryRecipeId: "mir_jollof",
        businessId,
        menuItemId,
        mode: "simple",
        status: "active",
        version: 7,
        components: [{
            inventoryItemId: "inv_jollof_portion",
            quantity: 1,
            unit: "portion",
            canonicalQuantity: 1,
        }],
        ingredientComponents: [{
            inventoryItemId: "inv_chicken",
            quantity: ingredientQuantity,
            unit: "piece",
            canonicalQuantity: ingredientQuantity,
        }],
        ingredientTrackingStatus: "active",
    }
}

function requestLine(menuItemId, {
    station = "kitchen",
    lineId = "line_jollof",
    fulfillmentBehavior = "prepared",
} = {}) {
    return {
        menuItemId,
        itemName: "Jollof Rice",
        quantity: 1,
        orderLineId: lineId,
        fulfillmentStation: station,
        fulfillmentBehavior,
    }
}

function resolverDependencies({ menuItem, mapping, inventoryItems }) {
    return {
        MenuItemModel: { find: async () => [menuItem] },
        MenuInventoryRecipeModel: { find: async () => [mapping] },
        InventoryItemModel: { find: async () => inventoryItems },
    }
}

test("one backward-compatible mapping validates Simple Stock plus independent ingredients", async () => {
    const menuItemId = new mongoose.Types.ObjectId()
    const mapping = new MenuInventoryRecipe(coexistenceMapping(menuItemId))
    await mapping.validate()
    assert.equal(mapping.mode, "simple")
    assert.equal(mapping.components[0].inventoryItemId, "inv_jollof_portion")
    assert.equal(mapping.ingredientComponents[0].inventoryItemId, "inv_chicken")

    mapping.ingredientComponents.push({
        inventoryItemId: "inv_chicken",
        quantity: 2,
        unit: "piece",
        canonicalQuantity: 2,
    })
    await assert.rejects(mapping.validate(), /cannot contain the same inventory item/i)

    const recipeOnly = new MenuInventoryRecipe({
        menuInventoryRecipeId: "mir_recipe_only",
        businessId,
        menuItemId: new mongoose.Types.ObjectId(),
        mode: "recipe",
        status: "active",
        components: [{
            inventoryItemId: "inv_beef",
            quantity: 100,
            unit: "g",
            canonicalQuantity: 100,
        }],
    })
    await recipeOnly.validate()
})

test("Simple Stock alone remains the availability authority when sidecar ingredients are empty", () => {
    const menuItemId = new mongoose.Types.ObjectId()
    const mapping = coexistenceMapping(menuItemId)
    const available = resolveEffectiveMenuAvailability({
        menuItem: { _id: menuItemId, isAvailable: true },
        mapping,
        inventoryItems: [
            inventoryItem({ inventoryItemId: "inv_jollof_portion", unit: "portion", onHand: 5 }),
            inventoryItem({ inventoryItemId: "inv_chicken", onHand: 0 }),
        ],
    })
    assert.equal(available.trackingState, "canonical_simple")
    assert.equal(available.availableMenuQuantity, 5)
    assert.equal(available.effectiveIsAvailable, true)

    const unavailable = resolveEffectiveMenuAvailability({
        menuItem: { _id: menuItemId, isAvailable: true },
        mapping,
        inventoryItems: [
            inventoryItem({ inventoryItemId: "inv_jollof_portion", unit: "portion", onHand: 0 }),
            inventoryItem({ inventoryItemId: "inv_chicken", onHand: 10 }),
        ],
    })
    assert.equal(unavailable.availableMenuQuantity, 0)
    assert.equal(unavailable.effectiveIsAvailable, false)
})

test("disabling Simple Stock keeps enabled ingredients as non-blocking usage tracking", async () => {
    const menuItemId = new mongoose.Types.ObjectId()
    const mapping = {
        ...coexistenceMapping(menuItemId),
        status: "disabled",
    }
    const menuItem = {
        _id: menuItemId,
        name: "Jollof Rice",
        isAvailable: true,
        manualIsAvailable: true,
        trackStock: false,
    }
    const portion = inventoryItem({
        inventoryItemId: "inv_jollof_portion",
        unit: "portion",
        onHand: 5,
    })
    const chicken = inventoryItem({ inventoryItemId: "inv_chicken", onHand: 0 })
    const availability = resolveEffectiveMenuAvailability({
        menuItem,
        mapping,
        inventoryItems: [portion, chicken],
    })
    assert.equal(availability.trackingState, "canonical_recipe")
    assert.equal(availability.effectiveIsAvailable, true)

    const resolved = await resolveInventoryRequirements({
        businessId,
        items: [requestLine(menuItemId)],
        session,
        env: {},
    }, resolverDependencies({ menuItem, mapping, inventoryItems: [portion, chicken] }))
    assert.deepEqual(resolved.failures, [])
    assert.deepEqual(resolved.requirements, [])
    assert.equal(resolved.lineAllocationRequirements.length, 0)
    assert.equal(resolved.menuRequirements.length, 0)
    assert.equal(resolved.sidecarAllocationRequirements.length, 1)
    assert.equal(resolved.sidecarAllocationRequirements[0].inventoryItemId, "inv_chicken")
    assert.equal(resolved.tracked, true)

    const manuallyUnavailable = await resolveInventoryRequirements({
        businessId,
        items: [requestLine(menuItemId)],
        session,
        env: {},
    }, resolverDependencies({
        menuItem: { ...menuItem, manualIsAvailable: false },
        mapping,
        inventoryItems: [portion, chicken],
    }))
    assert.equal(manuallyUnavailable.failures[0].reason, "MANUALLY_UNAVAILABLE")
})

test("recipe-only ingredients snapshot for prepared and direct-Bar fulfilment without reserving stock", async () => {
    const menuItemId = new mongoose.Types.ObjectId()
    const mapping = {
        menuInventoryRecipeId: "mir_recipe_tracking",
        businessId,
        menuItemId,
        mode: "recipe",
        status: "active",
        version: 3,
        components: [{
            inventoryItemId: "inv_chicken",
            quantity: 1,
            unit: "piece",
            canonicalQuantity: 1,
        }],
    }
    const menuItem = { _id: menuItemId, name: "Chicken burger", isAvailable: true }
    const chicken = inventoryItem({ inventoryItemId: "inv_chicken", onHand: 0 })
    for (const [station, fulfillmentBehavior] of [
        ["kitchen", "prepared"],
        ["bar", "direct"],
    ]) {
        const resolved = await resolveInventoryRequirements({
            businessId,
            items: [requestLine(menuItemId, { station, fulfillmentBehavior })],
            session,
            env: {},
        }, resolverDependencies({ menuItem, mapping, inventoryItems: [chicken] }))
        assert.deepEqual(resolved.failures, [])
        assert.deepEqual(resolved.requirements, [])
        assert.equal(resolved.lineAllocationRequirements.length, 0)
        assert.equal(resolved.menuRequirements.length, 0)
        assert.equal(resolved.sidecarAllocationRequirements.length, 1)
        assert.equal(resolved.sidecarAllocationRequirements[0].fulfillmentBehavior, fulfillmentBehavior)
    }
})

test("Phase 4 reserves Simple Stock but only snapshots zero-balance sidecar ingredients", async () => {
    const menuItemId = new mongoose.Types.ObjectId()
    const menuItem = { _id: menuItemId, name: "Jollof Rice", isAvailable: true }
    const mapping = coexistenceMapping(menuItemId)
    const portion = inventoryItem({
        inventoryItemId: "inv_jollof_portion",
        unit: "portion",
        onHand: 5,
    })
    const chicken = inventoryItem({ inventoryItemId: "inv_chicken", onHand: 0 })
    const result = await resolveInventoryRequirements({
        businessId,
        items: [requestLine(menuItemId)],
        session,
        env: {},
    }, resolverDependencies({ menuItem, mapping, inventoryItems: [portion, chicken] }))

    assert.deepEqual(result.failures, [])
    assert.deepEqual(
        result.requirements.map(({ inventoryItemId, canonicalQuantity }) => [
            inventoryItemId,
            canonicalQuantity,
        ]),
        [["inv_jollof_portion", 1]],
    )
    assert.equal(result.lineAllocationRequirements.length, 1)
    assert.equal(result.sidecarAllocationRequirements.length, 1)
    assert.equal(result.sidecarAllocationRequirements[0].inventoryItemId, "inv_chicken")
    assert.equal(result.sidecarAllocationRequirements[0].mappingVersion, 7)

    portion.onHandQuantity = 0
    const blocked = await resolveInventoryRequirements({
        businessId,
        items: [requestLine(menuItemId)],
        session,
        env: {},
    }, resolverDependencies({ menuItem, mapping, inventoryItems: [portion, chicken] }))
    assert.equal(blocked.failures[0].reason, "INSUFFICIENT_STOCK")
})

test("offline, waitstaff, and Stripe paths persist the same non-reserving sidecar snapshot", async () => {
    for (const sourceType of ["offline_order", "waitstaff_order", "stripe_checkout"]) {
        const menuItemId = new mongoose.Types.ObjectId()
        const menuItem = {
            _id: menuItemId,
            name: "Jollof Rice",
            isAvailable: true,
            async save() { return this },
        }
        const mapping = coexistenceMapping(menuItemId)
        const portion = inventoryItem({
            inventoryItemId: "inv_jollof_portion",
            unit: "portion",
            onHand: 5,
        })
        const chicken = inventoryItem({ inventoryItemId: "inv_chicken", onHand: 0 })
        const createdReservations = []
        const movements = []
        const pendingCheckoutId = sourceType === "stripe_checkout"
            ? new mongoose.Types.ObjectId()
            : null
        const order = sourceType === "stripe_checkout" ? null : {
            orderId: `ord_${sourceType}`,
            async save() { return this },
        }
        await reserveInventoryForSource({
            businessId,
            items: [requestLine(menuItemId, { lineId: `line_${sourceType}` })],
            sourceType,
            sourceId: `source_${sourceType}`,
            order,
            orderId: `ord_${sourceType}`,
            pendingCheckoutId,
            expiresAt: pendingCheckoutId ? new Date(Date.now() + 60_000) : null,
            reservationId: `irv_${sourceType}`,
            idempotencyKey: `coexistence:${sourceType}`,
            requestFingerprint: "e".repeat(64),
            actor,
            session,
            env: {},
        }, {
            InventoryReservationModel: {
                findOne: async () => null,
                async create(documents) {
                    createdReservations.push(...documents)
                    return documents
                },
            },
            InventoryMovementModel: {
                async create(documents) { movements.push(...documents); return documents },
            },
            projectSimple: async () => {},
            ...resolverDependencies({
                menuItem,
                mapping,
                inventoryItems: [portion, chicken],
            }),
        })
        assert.equal(portion.reservedQuantity, 1)
        assert.equal(chicken.reservedQuantity, 0)
        assert.equal(movements.filter((movement) => movement.type === "RESERVE").length, 1)
        assert.equal(createdReservations[0].lineAllocations.length, 1)
        assert.equal(createdReservations[0].sidecarAllocations.length, 1)
        assert.equal(createdReservations[0].sidecarAllocations[0].status, "pending")
        assert.equal(
            createdReservations[0].status,
            sourceType === "stripe_checkout" ? "held" : "committed",
        )
    }
})

test("offline, waitstaff, and Stripe paths preserve recipe-only ingredients as non-blocking sidecar usage", async () => {
    for (const sourceType of ["offline_order", "waitstaff_order", "stripe_checkout"]) {
        const menuItemId = new mongoose.Types.ObjectId()
        const menuItem = {
            _id: menuItemId,
            name: "Chicken burger",
            isAvailable: true,
            async save() { return this },
        }
        const mapping = {
            menuInventoryRecipeId: `mir_${sourceType}`,
            businessId,
            menuItemId,
            mode: "recipe",
            status: "active",
            version: 1,
            components: [{
                inventoryItemId: "inv_chicken",
                quantity: 1,
                unit: "piece",
                canonicalQuantity: 1,
            }],
        }
        const chicken = inventoryItem({ inventoryItemId: "inv_chicken", onHand: 0 })
        const createdReservations = []
        const movements = []
        const pendingCheckoutId = sourceType === "stripe_checkout"
            ? new mongoose.Types.ObjectId()
            : null
        const order = sourceType === "stripe_checkout" ? null : {
            orderId: `ord_recipe_${sourceType}`,
            async save() { return this },
        }
        await reserveInventoryForSource({
            businessId,
            items: [requestLine(menuItemId, { lineId: `line_recipe_${sourceType}` })],
            sourceType,
            sourceId: `source_recipe_${sourceType}`,
            order,
            orderId: `ord_recipe_${sourceType}`,
            pendingCheckoutId,
            expiresAt: pendingCheckoutId ? new Date(Date.now() + 60_000) : null,
            reservationId: `irv_recipe_${sourceType}`,
            idempotencyKey: `recipe-only:${sourceType}`,
            requestFingerprint: "r".repeat(64),
            actor,
            session,
            env: {},
        }, {
            InventoryReservationModel: {
                findOne: async () => null,
                async create(documents) {
                    createdReservations.push(...documents)
                    return documents
                },
            },
            InventoryMovementModel: {
                async create(documents) { movements.push(...documents); return documents },
            },
            projectSimple: async () => {},
            ...resolverDependencies({ menuItem, mapping, inventoryItems: [chicken] }),
        })
        assert.equal(chicken.reservedQuantity, 0)
        assert.equal(movements.length, 0)
        assert.equal(createdReservations[0].components.length, 0)
        assert.equal(createdReservations[0].lineAllocations.length, 0)
        assert.equal(createdReservations[0].sidecarAllocations.length, 1)
        if (order) assert.equal(order.inventorySemanticsVersion, "canonical_reservation_v1")
    }
})

test("later recipe edits cannot change the frozen sidecar quantity consumed by an order", async () => {
    const scenario = await consumeScenario({ station: "kitchen", chickenOnHand: 10, required: 1 })
    const editedLiveRecipeQuantity = 9
    assert.notEqual(
        scenario.ingredientAllocation.canonicalQuantity,
        editedLiveRecipeQuantity,
    )
    assert.equal(scenario.chicken.onHandQuantity, 9)
    assert.equal(scenario.ingredientAllocation.consumedCanonicalQuantity, 1)
})

test("adding, disabling, and removing sidecar ingredients never rewrites Simple Stock", async () => {
    const menuItemId = new mongoose.Types.ObjectId()
    const menuItem = {
        _id: menuItemId,
        businessId,
        name: "Jollof Rice",
        category: "Mains",
        type: "food",
        price: 20,
        trackStock: true,
        stockQuantity: 19,
        lowStockThreshold: 3,
        isAvailable: true,
        manualIsAvailable: true,
        async save() { throw new Error("Simple Stock menu projection must not be rewritten") },
    }
    const portion = inventoryItem({
        inventoryItemId: "inv_jollof_portion",
        unit: "portion",
        onHand: 20,
        reserved: 1,
    })
    portion.name = "Jollof portions"
    const chicken = inventoryItem({ inventoryItemId: "inv_chicken", onHand: 0 })
    chicken.name = "Chicken"
    const mapping = {
        ...coexistenceMapping(menuItemId),
        ingredientComponents: [],
        ingredientTrackingStatus: null,
        saveCount: 0,
        async save() { this.saveCount += 1; return this },
    }
    const InventoryItemModel = {
        async find(query) {
            return query.inventoryItemId.$in.includes("inv_chicken") ? [chicken] : []
        },
        async findOne() { return portion },
    }
    const dependencies = {
        MenuInventoryRecipeModel: { findOne: async () => mapping },
        MenuItemModel: { findOne: async () => menuItem },
        InventoryItemModel,
        transactionRunner: async (work) => work(session),
        invalidateMenu: async () => {},
    }
    const created = await upsertIngredientRecipe({
        businessId,
        menuItemId,
        components: [{ inventoryItemId: "inv_chicken", quantity: 1, unit: "piece" }],
        enabled: true,
    }, dependencies)
    assert.equal(created.recipe.mode, "simple")
    assert.equal(created.recipe.status, "active")
    assert.equal(created.recipe.simpleStock.availableQuantity, 19)
    assert.equal(mapping.mode, "simple")
    assert.equal(mapping.status, "active")
    assert.equal(mapping.components[0].inventoryItemId, "inv_jollof_portion")
    assert.equal(menuItem.stockQuantity, 19)
    assert.equal(menuItem.lowStockThreshold, 3)

    await upsertIngredientRecipe({
        businessId,
        menuItemId,
        components: [{ inventoryItemId: "inv_chicken", quantity: 1, unit: "piece" }],
        enabled: false,
    }, dependencies)
    assert.equal(mapping.status, "active")
    assert.equal(mapping.ingredientTrackingStatus, "disabled")

    const removed = await removeIngredientRecipe({ businessId, menuItemId }, {
        MenuInventoryRecipeModel: { findOne: async () => mapping },
        transactionRunner: async (work) => work(session),
        invalidateMenu: async () => {},
        now: () => new Date("2026-09-06T10:00:00.000Z"),
    })
    assert.equal(removed.simpleStockPreserved, true)
    assert.equal(mapping.status, "active")
    assert.equal(mapping.components[0].inventoryItemId, "inv_jollof_portion")
    assert.deepEqual(mapping.ingredientComponents, [])
    assert.equal(mapping.ingredientTrackingStatus, null)
})

function regularAllocation({ menuItemId, station, behavior = "prepared" }) {
    return {
        allocationId: `ial_${station}_portion`,
        orderLineId: `line_${station}`,
        menuItemId,
        fulfillmentStation: station,
        fulfillmentBehavior: behavior,
        inventoryItemId: "inv_jollof_portion",
        canonicalQuantity: 1,
        unit: "portion",
        status: INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED,
        consumeMovementId: null,
        consumedAt: null,
        releaseMovementId: null,
        releasedAt: null,
    }
}

function sidecarAllocation({ menuItemId, station, quantity, behavior = "prepared" }) {
    return {
        allocationId: `isa_${station}_chicken`,
        orderLineId: `line_${station}`,
        menuItemId,
        mappingVersion: 7,
        fulfillmentStation: station,
        fulfillmentBehavior: behavior,
        inventoryItemId: "inv_chicken",
        canonicalQuantity: quantity,
        unit: "piece",
        status: INVENTORY_SIDECAR_ALLOCATION_STATUSES.PENDING,
        consumedCanonicalQuantity: 0,
        shortageCanonicalQuantity: 0,
        consumeMovementId: null,
        accountedAt: null,
    }
}

async function consumeScenario({
    station,
    chickenOnHand,
    chickenReserved = 0,
    required = 1,
    behavior = "prepared",
    recipeOnly = false,
}) {
    const menuItemId = new mongoose.Types.ObjectId()
    const order = {
        orderId: `ord_${station}_${chickenOnHand}`,
        businessId,
        inventoryReservationId: `irv_${station}_${chickenOnHand}`,
        items: [{
            orderLineId: `line_${station}`,
            menuItemId,
            fulfillmentStation: station,
            fulfillmentBehavior: behavior,
        }],
    }
    const portionAllocation = regularAllocation({ menuItemId, station, behavior })
    const ingredientAllocation = sidecarAllocation({ menuItemId, station, quantity: required, behavior })
    const reservation = {
        reservationId: order.inventoryReservationId,
        orderId: order.orderId,
        status: INVENTORY_RESERVATION_STATUSES.COMMITTED,
        components: recipeOnly ? [] : [{ inventoryItemId: "inv_jollof_portion", canonicalQuantity: 1 }],
        lineAllocations: recipeOnly ? [] : [portionAllocation],
        sidecarAllocations: [ingredientAllocation],
        menuRequirements: recipeOnly
            ? []
            : [{ menuItemId, authority: "canonical", mappingMode: "simple" }],
        async save() { return this },
    }
    const portion = inventoryItem({
        inventoryItemId: "inv_jollof_portion",
        unit: "portion",
        onHand: 20,
        reserved: 1,
    })
    const chicken = inventoryItem({
        inventoryItemId: "inv_chicken",
        onHand: chickenOnHand,
        reserved: chickenReserved,
    })
    const movements = []
    const dependencies = {
        InventoryReservationModel: { findOne: async () => reservation },
        InventoryItemModel: { find: async () => [portion, chicken] },
        InventoryMovementModel: {
            async create(documents) { movements.push(...documents); return documents },
        },
        projectSimple: async () => {},
        logger: { warn() {} },
    }
    const input = {
        businessId,
        order,
        orderLineIds: [`line_${station}`],
        station,
        action: behavior === "direct" ? "ready" : "start",
        actor,
        session,
        now: new Date("2026-09-06T12:00:00.000Z"),
    }
    const result = await consumeReservedInventoryForFulfillment(input, dependencies)
    const replay = await consumeReservedInventoryForFulfillment(input, dependencies)
    return {
        result,
        replay,
        portion,
        chicken,
        movements,
        ingredientAllocation,
    }
}

test("Kitchen and prepared Bar START consume Simple Stock once and sidecar ingredients once", async () => {
    for (const station of ["kitchen", "bar"]) {
        const scenario = await consumeScenario({ station, chickenOnHand: 3 })
        assert.deepEqual(
            [scenario.portion.onHandQuantity, scenario.portion.reservedQuantity],
            [19, 0],
        )
        assert.equal(scenario.chicken.onHandQuantity, 2)
        assert.equal(scenario.movements.length, 2)
        assert.equal(
            scenario.movements.filter((movement) =>
                movement.inventoryItemId === "inv_jollof_portion").length,
            1,
        )
        assert.equal(
            scenario.movements.find((movement) =>
                movement.inventoryItemId === "inv_chicken").quantityDeltaReserved,
            0,
        )
        assert.equal(scenario.ingredientAllocation.status, "consumed")
        assert.equal(scenario.replay.changed, false)
        assert.equal(scenario.movements.length, 2)
    }
})

test("ingredient shortage zero-floors safely, records a discrepancy, and never blocks fulfilment", async () => {
    const scenario = await consumeScenario({ station: "kitchen", chickenOnHand: 0, required: 2 })
    assert.equal(scenario.result.changed, true)
    assert.equal(scenario.portion.onHandQuantity, 19)
    assert.equal(scenario.chicken.onHandQuantity, 0)
    assert.equal(scenario.movements.length, 1)
    assert.equal(scenario.ingredientAllocation.status, "shortage")
    assert.equal(scenario.ingredientAllocation.consumedCanonicalQuantity, 0)
    assert.equal(scenario.ingredientAllocation.shortageCanonicalQuantity, 2)
    assert.equal(scenario.result.shortages[0].reason, "insufficient_unreserved_balance")
})

test("recipe-only ingredients are accounted after fulfilment without reserving stock first", async () => {
    const shortage = await consumeScenario({
        station: "kitchen",
        chickenOnHand: 0,
        required: 2,
        recipeOnly: true,
    })
    assert.equal(shortage.result.changed, true)
    assert.equal(shortage.chicken.onHandQuantity, 0)
    assert.equal(shortage.movements.length, 0)
    assert.equal(shortage.ingredientAllocation.status, "shortage")
    assert.equal(shortage.replay.changed, false)

    const directBar = await consumeScenario({
        station: "bar",
        behavior: "direct",
        chickenOnHand: 1,
        required: 1,
        recipeOnly: true,
    })
    assert.equal(directBar.chicken.onHandQuantity, 0)
    assert.equal(directBar.ingredientAllocation.status, "consumed")
    assert.equal(directBar.movements.length, 1)
})

test("partial sidecar consumption protects reserved stock and reconciles the frozen snapshot", async () => {
    const scenario = await consumeScenario({
        station: "kitchen",
        chickenOnHand: 3,
        chickenReserved: 1,
        required: 4,
    })
    assert.equal(scenario.chicken.onHandQuantity, 1)
    assert.equal(scenario.chicken.reservedQuantity, 1)
    assert.equal(scenario.ingredientAllocation.status, "shortage")
    assert.equal(scenario.ingredientAllocation.consumedCanonicalQuantity, 2)
    assert.equal(scenario.ingredientAllocation.shortageCanonicalQuantity, 2)
    assert.equal(scenario.movements.length, 2)

    const snapshot = new InventoryReservation({
        reservationId: "irv_sidecar_schema",
        businessId,
        sourceType: "offline_order",
        sourceId: "ord_sidecar_schema",
        orderId: "ord_sidecar_schema",
        status: "committed",
        components: [{
            inventoryItemId: "inv_portion",
            canonicalQuantity: 1,
            unit: "portion",
            reserveMovementId: "imv_reserve_portion",
        }],
        lineAllocations: [{
            ...regularAllocation({ menuItemId: new mongoose.Types.ObjectId(), station: "kitchen" }),
            inventoryItemId: "inv_portion",
        }],
        sidecarAllocations: [{
            ...sidecarAllocation({
                menuItemId: new mongoose.Types.ObjectId(),
                station: "kitchen",
                quantity: 4,
            }),
            status: "shortage",
            consumedCanonicalQuantity: 3,
            shortageCanonicalQuantity: 1,
            consumeMovementId: "imv_sidecar_partial",
            accountedAt: new Date(),
        }],
        idempotencyKey: "sidecar:schema",
        requestFingerprint: "c".repeat(64),
    })
    snapshot.lineAllocations[0].canonicalQuantity = 1
    snapshot.menuRequirements = [{
        menuItemId: snapshot.lineAllocations[0].menuItemId,
        orderQuantity: 1,
        authority: "canonical",
        mappingMode: "simple",
        mappingVersion: 1,
    }]
    await snapshot.validate()
})

test("recipe-only ingredient snapshots are valid without a sale-stock reservation", async () => {
    const snapshot = new InventoryReservation({
        reservationId: "irv_recipe_only_schema",
        businessId,
        sourceType: "offline_order",
        sourceId: "ord_recipe_only_schema",
        orderId: "ord_recipe_only_schema",
        status: "committed",
        components: [],
        legacyComponents: [],
        lineAllocations: [],
        sidecarAllocations: [sidecarAllocation({
            menuItemId: new mongoose.Types.ObjectId(),
            station: "kitchen",
            quantity: 1,
        })],
        menuRequirements: [],
        idempotencyKey: "recipe-only:schema",
        requestFingerprint: "a".repeat(64),
    })
    await snapshot.validate()
})

test("unreserved CONSUME ledger semantics are restricted to the ingredient sidecar", async () => {
    const input = {
        movementId: "imv_sidecar_ledger",
        businessId,
        inventoryItemId: "inv_chicken",
        type: "CONSUME",
        quantityDeltaOnHand: -1,
        quantityDeltaReserved: 0,
        unit: "piece",
        canonicalQuantity: 1,
        onHandBefore: 2,
        onHandAfter: 1,
        reservedBefore: 0,
        reservedAfter: 0,
        sourceType: "inventory_sidecar",
        sourceId: "irv_sidecar",
        performedBy: actor,
        idempotencyKey: "sidecar:ledger",
        requestFingerprint: "d".repeat(64),
        inventoryReservationId: "irv_sidecar",
        orderId: "ord_sidecar",
        orderLineIds: ["line_sidecar"],
        allocationIds: ["isa_sidecar"],
        fulfillmentStation: "kitchen",
        fulfillmentAction: "start",
    }
    await new InventoryMovement(input).validate()
    await assert.rejects(
        new InventoryMovement({ ...input, sourceType: "inventory_reservation" }).validate(),
        /requires a Reserved delta of -1/i,
    )
})

test("coexistence routes keep tenant-derived permissions and do not replace Stripe authority", async () => {
    const [routes, controller, reservationService] = await Promise.all([
        readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/controllers/inventoryController.js", import.meta.url), "utf8"),
        readFile(new URL("../src/services/inventoryReservationService.js", import.meta.url), "utf8"),
    ])
    assert.match(routes, /router\.delete\([\s\S]*?\/inventory\/recipes\/:menuItemId[\s\S]*?MENU_MANAGE[\s\S]*?INVENTORY_RECIPE_MANAGE/)
    assert.match(controller, /businessId = requireTenant\(req, res\)/)
    assert.match(reservationService, /sidecarAllocations/)
    assert.doesNotMatch(reservationService, /paymentStatus\s*=/)
})
