import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import mongoose from "mongoose"

import {
    INVENTORY_MOVEMENT_TYPES,
} from "../src/constants/inventory.js"
import {
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_TRACKING_STATES,
} from "../src/constants/menuInventory.js"
import {
    ORDER_INVENTORY_AUTHORITIES,
    ORDER_INVENTORY_SEMANTICS,
} from "../src/constants/orderInventory.js"
import InventoryItem from "../src/models/InventoryItem.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import MenuInventoryRecipe from "../src/models/MenuInventoryRecipe.js"
import MenuItem from "../src/models/menuItem.js"
import Order from "../src/models/order.js"
import { createInventoryItem } from "../src/services/canonicalInventoryService.js"
import { createInventoryCompatibilityAdapter } from "../src/services/inventoryCompatibilityAdapter.js"
import {
    resolveEffectiveMenuAvailability,
    resolveManualMenuAvailability,
    resolveMenuInventoryTrackingState,
    toMenuInventoryAvailabilityDTO,
} from "../src/services/menuInventoryAvailabilityService.js"
import {
    createSimpleMenuInventoryRecipe,
    transitionMenuInventoryRecipe,
    validateSimpleMenuInventoryRelationship,
} from "../src/services/menuInventoryRecipeService.js"
import {
    buildOrderInventoryDeductionLine,
    buildOrderInventorySemanticsStamp,
    resolveOrderInventorySemantics,
    resolveOrderRestorationAuthority,
} from "../src/services/orderInventorySemanticsService.js"
import {
    buildDeterministicSimpleStockMigrationIdentities,
    buildSimpleStockMigrationDryRun,
    classifyLegacyMenuItemForSimpleStock,
    readSimpleStockMigrationDryRun,
    SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS,
} from "../src/services/simpleStockMigrationService.js"

function makeMovement(overrides = {}) {
    return new InventoryMovement({
        movementId: "imv_phase2a",
        businessId: "biz_alpha",
        inventoryItemId: "inv_alpha",
        type: INVENTORY_MOVEMENT_TYPES.RECEIVE,
        quantityDeltaOnHand: 1,
        quantityDeltaReserved: 0,
        unit: "piece",
        canonicalQuantity: 1,
        onHandBefore: 0,
        onHandAfter: 1,
        reservedBefore: 0,
        reservedAfter: 0,
        sourceType: "test",
        performedBy: { staffId: "owner_1", role: "owner", name: "Owner" },
        idempotencyKey: "phase2a-movement",
        requestFingerprint: "a".repeat(64),
        ...overrides,
    })
}

function leanQuery(result) {
    return {
        select() { return this },
        sort() { return this },
        lean: async () => result,
    }
}

test("Phase 1 hardening validates delta equations and additional immutable paths", async () => {
    await makeMovement().validate()
    await makeMovement({ quantityDeltaOnHand: -1 }).validate().then(
        () => assert.fail("invalid RECEIVE delta should fail"),
        (error) => assert.match(error.message, /requires an On Hand delta/),
    )
    await makeMovement({ onHandAfter: 2 }).validate().then(
        () => assert.fail("invalid balance equation should fail"),
        (error) => assert.match(error.message, /before plus its delta/),
    )
    await makeMovement({
        type: INVENTORY_MOVEMENT_TYPES.LEGACY_ORDER_DEDUCTION,
        quantityDeltaOnHand: -1,
        onHandBefore: 2,
        onHandAfter: 1,
    }).validate()

    await assert.rejects(
        InventoryMovement.findOneAndReplace({}, {}),
        /InventoryMovement is immutable/,
    )
    await assert.rejects(
        InventoryMovement.bulkWrite([{ updateOne: { filter: {}, update: { $set: { note: "x" } } } }]),
        /InventoryMovement is immutable/,
    )
    await assert.rejects(makeMovement().deleteOne(), /InventoryMovement is immutable/)
})

test("canonical item creation can join a caller-owned Mongo session", async () => {
    const fakeSession = { id: "session-a" }
    let createArguments
    const InventoryItemModel = {
        async create(input, options) {
            createArguments = { input, options }
            return [{ ...input[0], createdAt: new Date(), updatedAt: new Date() }]
        },
    }
    const result = await createInventoryItem({
        businessId: "biz_alpha",
        input: { name: "Flour", trackingUnit: "g" },
        session: fakeSession,
    }, {
        InventoryItemModel,
        generateId: () => "inv_session",
    })
    assert.equal(result.inventoryItemId, "inv_session")
    assert.deepEqual(createArguments.options, { session: fakeSession })
    assert.ok(Array.isArray(createArguments.input))
})

test("MenuInventoryRecipe preserves Simple Stock invariants and supports Phase 3 recipes", async () => {
    const menuItemId = new mongoose.Types.ObjectId()
    const valid = new MenuInventoryRecipe({
        menuInventoryRecipeId: "mir_valid",
        businessId: "biz_alpha",
        menuItemId,
        components: [{
            inventoryItemId: "inv_alpha",
            quantity: 1,
            unit: "piece",
            canonicalQuantity: 1,
        }],
    })
    await valid.validate()
    assert.equal(valid.status, MENU_INVENTORY_MAPPING_STATUSES.DISABLED)

    await new MenuInventoryRecipe({
        menuInventoryRecipeId: "mir_many",
        businessId: "biz_alpha",
        menuItemId,
        components: [
            { inventoryItemId: "inv_a", quantity: 1, unit: "piece", canonicalQuantity: 1 },
            { inventoryItemId: "inv_b", quantity: 1, unit: "piece", canonicalQuantity: 1 },
        ],
    }).validate().then(
        () => assert.fail("multi-component recipe must remain disabled in Phase 2A"),
        (error) => assert.match(error.message, /exactly one/),
    )
    const recipe = new MenuInventoryRecipe({
        menuInventoryRecipeId: "mir_recipe",
        businessId: "biz_alpha",
        menuItemId,
        mode: "recipe",
        components: [
            { inventoryItemId: "inv_a", quantity: 0.15, unit: "kg", canonicalQuantity: 150 },
            { inventoryItemId: "inv_b", quantity: 20, unit: "ml", canonicalQuantity: 20 },
        ],
    })
    await recipe.validate()
    await new MenuInventoryRecipe({
        menuInventoryRecipeId: "mir_duplicate_recipe",
        businessId: "biz_alpha",
        menuItemId,
        mode: "recipe",
        components: [
            { inventoryItemId: "inv_a", quantity: 10, unit: "g", canonicalQuantity: 10 },
            { inventoryItemId: "inv_a", quantity: 20, unit: "g", canonicalQuantity: 20 },
        ],
    }).validate().then(
        () => assert.fail("duplicate ingredient components must fail"),
        (error) => assert.match(error.message, /same inventory item more than once/),
    )

    const indexes = MenuInventoryRecipe.schema.indexes()
    assert.ok(indexes.some(([fields, options]) => (
        fields.businessId === 1 && fields.menuItemId === 1 && options.unique === true
    )))
    assert.ok(indexes.some(([fields]) => (
        fields.businessId === 1 &&
        fields["components.inventoryItemId"] === 1 &&
        fields.status === 1
    )))
})

test("mapping validation scopes MenuItem and InventoryItem to one tenant", async () => {
    const menuItemId = new mongoose.Types.ObjectId()
    const menuItem = { _id: menuItemId, businessId: "biz_alpha" }
    const inventoryItem = {
        inventoryItemId: "inv_alpha",
        businessId: "biz_alpha",
        trackingUnit: "piece",
        isActive: true,
    }
    const calls = []
    const dependencies = {
        MenuItemModel: {
            async findOne(filter) {
                calls.push(filter)
                return filter.businessId === "biz_alpha" ? menuItem : null
            },
        },
        InventoryItemModel: {
            async findOne(filter) {
                calls.push(filter)
                return filter.businessId === "biz_alpha" ? inventoryItem : null
            },
        },
    }
    const result = await validateSimpleMenuInventoryRelationship({
        businessId: "biz_alpha",
        menuItemId,
        components: [{ inventoryItemId: "inv_alpha", quantity: 1, unit: "piece" }],
    }, dependencies)
    assert.equal(result.components[0].canonicalQuantity, 1)
    assert.ok(calls.every((filter) => filter.businessId === "biz_alpha"))

    await assert.rejects(
        validateSimpleMenuInventoryRelationship({
            businessId: "biz_beta",
            menuItemId,
            components: [{ inventoryItemId: "inv_alpha", quantity: 1, unit: "piece" }],
        }, dependencies),
        (error) => error.code === "MENU_ITEM_NOT_FOUND",
    )
    await assert.rejects(
        validateSimpleMenuInventoryRelationship({
            businessId: "biz_alpha",
            menuItemId,
            components: [{ inventoryItemId: "inv_alpha", quantity: 1, unit: "bottle" }],
        }, dependencies),
        /cannot be treated as piece/,
    )
})

test("mapping creation defaults dark and standard lifecycle cannot revive archives", async () => {
    const menuItemId = new mongoose.Types.ObjectId()
    const menuItem = { _id: menuItemId, businessId: "biz_alpha" }
    const inventoryItem = {
        inventoryItemId: "inv_alpha",
        businessId: "biz_alpha",
        trackingUnit: "piece",
        isActive: true,
    }
    let createdInput
    const created = await createSimpleMenuInventoryRecipe({
        businessId: "biz_alpha",
        menuItemId,
        components: [{ inventoryItemId: "inv_alpha", quantity: 1, unit: "piece" }],
    }, {
        MenuInventoryRecipeModel: {
            findOne: async () => null,
            async create(input) {
                createdInput = input
                return input
            },
        },
        MenuItemModel: { findOne: async () => menuItem },
        InventoryItemModel: { findOne: async () => inventoryItem },
        generateId: () => "mir_dark",
    })
    assert.equal(created.status, MENU_INVENTORY_MAPPING_STATUSES.DISABLED)
    assert.equal(createdInput.status, MENU_INVENTORY_MAPPING_STATUSES.DISABLED)

    const mappingDocument = new MenuInventoryRecipe({
        menuInventoryRecipeId: "mir_lifecycle",
        businessId: "biz_alpha",
        menuItemId,
        status: MENU_INVENTORY_MAPPING_STATUSES.DISABLED,
        components: [{ inventoryItemId: "inv_alpha", quantity: 1, unit: "piece", canonicalQuantity: 1 }],
    })
    mappingDocument.save = async () => mappingDocument
    const mappingModel = { findOne: async () => mappingDocument }
    const validation = {
        MenuItemModel: { findOne: async () => menuItem },
        InventoryItemModel: { findOne: async () => inventoryItem },
    }
    const active = await transitionMenuInventoryRecipe({
        businessId: "biz_alpha",
        menuInventoryRecipeId: "mir_lifecycle",
        targetStatus: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
    }, { MenuInventoryRecipeModel: mappingModel, ...validation })
    assert.equal(active.status, MENU_INVENTORY_MAPPING_STATUSES.ACTIVE)
    assert.equal(active.version, 2)

    const archived = await transitionMenuInventoryRecipe({
        businessId: "biz_alpha",
        menuInventoryRecipeId: "mir_lifecycle",
        targetStatus: MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED,
    }, { MenuInventoryRecipeModel: mappingModel, ...validation })
    assert.equal(archived.status, MENU_INVENTORY_MAPPING_STATUSES.ARCHIVED)
    await assert.rejects(
        transitionMenuInventoryRecipe({
            businessId: "biz_alpha",
            menuInventoryRecipeId: "mir_lifecycle",
            targetStatus: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
        }, { MenuInventoryRecipeModel: mappingModel, ...validation }),
        (error) => error.code === "INVALID_MENU_INVENTORY_MAPPING_TRANSITION",
    )
})

test("manual and effective availability remain separate and canonical reads fail closed", () => {
    const legacyMenuItem = {
        trackStock: true,
        stockQuantity: 4,
        isAvailable: true,
        manualIsAvailable: null,
    }
    assert.equal(resolveManualMenuAvailability(legacyMenuItem), true)
    assert.equal(resolveMenuInventoryTrackingState({ menuItem: legacyMenuItem }), MENU_INVENTORY_TRACKING_STATES.LEGACY)
    assert.equal(resolveEffectiveMenuAvailability({ menuItem: legacyMenuItem }).effectiveIsAvailable, true)

    const mapping = {
        status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
        mode: "simple",
        components: [{ inventoryItemId: "inv_alpha", canonicalQuantity: 1 }],
    }
    const available = resolveEffectiveMenuAvailability({
        menuItem: { ...legacyMenuItem, manualIsAvailable: true },
        mapping,
        inventoryItems: [{
            inventoryItemId: "inv_alpha",
            onHandQuantity: 7,
            reservedQuantity: 2,
            isActive: true,
        }],
    })
    assert.equal(available.availableMenuQuantity, 5)
    assert.equal(available.effectiveIsAvailable, true)

    const manuallyUnavailable = toMenuInventoryAvailabilityDTO({
        menuItem: { ...legacyMenuItem, manualIsAvailable: false },
        mapping,
        inventoryItems: [{ inventoryItemId: "inv_alpha", onHandQuantity: 7, reservedQuantity: 0 }],
    })
    assert.equal(manuallyUnavailable.manualIsAvailable, false)
    assert.equal(manuallyUnavailable.effectiveIsAvailable, false)
    assert.equal(resolveEffectiveMenuAvailability({ menuItem: legacyMenuItem, mapping }).effectiveIsAvailable, false)

    const invalidBalance = resolveEffectiveMenuAvailability({
        menuItem: legacyMenuItem,
        mapping,
        inventoryItems: [{
            inventoryItemId: "inv_alpha",
            onHandQuantity: 1,
            reservedQuantity: 2,
        }],
    })
    assert.equal(invalidBalance.inventoryAvailabilityState, "invalid")
    assert.equal(invalidBalance.effectiveIsAvailable, false)
})

test("Order semantics default legacy and restoration never infers from current mapping", async () => {
    const menuItemId = new mongoose.Types.ObjectId()
const order = new Order({
  orderId: "QS-SEMANTICS",
  businessId: "biz_alpha",
  servicePointId: "sp_1",
  servicePointLabel: "sp_1",
  items: [{ itemName: "Coke", menuItemId, quantity: 1, lineTotal: 3 }],
})
    assert.equal(
        order.inventorySemanticsVersion,
        ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1,
    )
    await order.validate()
    assert.equal(resolveOrderRestorationAuthority({ items: order.items }).version, ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1)

    const canonicalLine = buildOrderInventoryDeductionLine({
        menuItemId,
        authority: ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM,
        orderQuantity: 1,
        inventoryItemId: "inv_alpha",
        canonicalQuantity: 1,
        unit: "piece",
        mappingVersion: 2,
        deductionMovementId: "imv_deduct",
    })
    const stamp = buildOrderInventorySemanticsStamp([canonicalLine])
    assert.equal(stamp.inventorySemanticsVersion, ORDER_INVENTORY_SEMANTICS.CANONICAL_SIMPLE_BRIDGE_V1)
    assert.equal(resolveOrderInventorySemantics(stamp).lines[0].inventoryItemId, "inv_alpha")
    assert.equal(resolveOrderRestorationAuthority(stamp).version, ORDER_INVENTORY_SEMANTICS.CANONICAL_SIMPLE_BRIDGE_V1)
    assert.throws(
        () => buildOrderInventoryDeductionLine({
            menuItemId,
            authority: ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM,
            orderQuantity: 1,
            inventoryItemId: "inv_alpha",
            canonicalQuantity: 1,
            unit: "piece",
            mappingVersion: 2,
        }),
        /deductionMovementId is required/,
    )
    assert.throws(
        () => resolveOrderRestorationAuthority({
            inventorySemanticsVersion: ORDER_INVENTORY_SEMANTICS.CANONICAL_SIMPLE_BRIDGE_V1,
        }),
        /require only canonical/,
    )
    assert.throws(
        () => resolveOrderRestorationAuthority({ inventorySemanticsVersion: "corrupt_v1" }),
        /version is invalid/,
    )

    const inconsistentOrder = new Order({
        orderId: "QS-INCONSISTENT-SEMANTICS",
        businessId: "biz_alpha",
        servicePointLabel: "sp_1",
        items: [{ itemName: "Coke", menuItemId, quantity: 1, lineTotal: 3 }],
        inventorySemanticsVersion: ORDER_INVENTORY_SEMANTICS.CANONICAL_SIMPLE_BRIDGE_V1,
        inventoryDeductionLines: [],
    })
    await assert.rejects(inconsistentOrder.validate(), /require only canonical/)
})

test("compatibility adapter is dark by default and restores from recorded semantics", async () => {
    const calls = []
    const legacyStrategy = {
        validateTrackedStock: async () => { calls.push("legacy-validate"); return [] },
        deductTrackedStock: async () => { calls.push("legacy-deduct"); return true },
        restoreTrackedStock: async () => { calls.push("legacy-restore"); return true },
    }
    const canonicalStrategy = {
        validateTrackedStock: async () => { calls.push("canonical-validate"); return [] },
        deductTrackedStock: async () => { calls.push("canonical-deduct"); return true },
        restoreTrackedStock: async () => { calls.push("canonical-restore"); return true },
    }
    const mixedStrategy = {
        restoreTrackedStock: async () => { calls.push("mixed-restore"); return true },
    }
    const dark = createInventoryCompatibilityAdapter({ legacyStrategy, canonicalStrategy })
    await dark.validateTrackedStock([], "biz_alpha")
    await dark.deductTrackedStock({ inventorySemanticsVersion: "legacy_menu_stock_v1" })
    await dark.restoreTrackedStock({})
    assert.deepEqual(calls, ["legacy-validate", "legacy-deduct", "legacy-restore"])

    calls.length = 0
    const enabledForTest = createInventoryCompatibilityAdapter({
        legacyStrategy,
        canonicalStrategy,
        mixedStrategy,
        isCanonicalSimpleStockEnabled: ({ nonProductionTestPath }) => nonProductionTestPath === true,
    })
    const context = { nonProductionTestPath: true }
    await enabledForTest.validateTrackedStock([], "biz_alpha", context)
    await enabledForTest.deductTrackedStock({}, context)
    await enabledForTest.restoreTrackedStock({}, context)
    const menuItemId = new mongoose.Types.ObjectId()
    const canonicalLine = buildOrderInventoryDeductionLine({
        menuItemId,
        authority: ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM,
        orderQuantity: 1,
        inventoryItemId: "inv_alpha",
        canonicalQuantity: 1,
        unit: "piece",
        mappingVersion: 1,
        deductionMovementId: "imv_adapter_deduct",
    })
    await dark.restoreTrackedStock({
        inventorySemanticsVersion: ORDER_INVENTORY_SEMANTICS.CANONICAL_SIMPLE_BRIDGE_V1,
        inventoryDeductionLines: [canonicalLine],
    })
    const legacyLine = buildOrderInventoryDeductionLine({
        menuItemId,
        authority: ORDER_INVENTORY_AUTHORITIES.LEGACY_MENU_ITEM,
        orderQuantity: 1,
    })
    await enabledForTest.restoreTrackedStock({
        inventorySemanticsVersion: ORDER_INVENTORY_SEMANTICS.MIXED_BRIDGE_V1,
        inventoryDeductionLines: [legacyLine, canonicalLine],
    })
    assert.deepEqual(calls, [
        "canonical-validate",
        "canonical-deduct",
        "legacy-restore",
        "canonical-restore",
        "mixed-restore",
    ])
})

test("migration classifier is conservative, deterministic, and unit-neutral", () => {
    const menuItemId = new mongoose.Types.ObjectId().toString()
    const base = {
        _id: menuItemId,
        businessId: "biz_alpha",
        name: "Coke",
        trackStock: true,
        stockQuantity: 24,
        lowStockThreshold: 5,
        isAvailable: true,
    }
    const eligible = classifyLegacyMenuItemForSimpleStock(base)
    assert.equal(eligible.classification, SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS.ELIGIBLE)
    assert.equal(eligible.candidate.trackingUnit, "piece")
    assert.equal(eligible.candidate.openingQuantity, 24)
    assert.equal(eligible.candidate.mapping.status, "disabled")

    const identitiesA = buildDeterministicSimpleStockMigrationIdentities({
        businessId: "biz_alpha",
        menuItemId,
    })
    const identitiesB = buildDeterministicSimpleStockMigrationIdentities({
        businessId: "biz_alpha",
        menuItemId,
    })
    const identitiesOtherTenant = buildDeterministicSimpleStockMigrationIdentities({
        businessId: "biz_beta",
        menuItemId,
    })
    assert.deepEqual(identitiesA, identitiesB)
    assert.notEqual(identitiesA.inventoryItemId, identitiesOtherTenant.inventoryItemId)
    const maximumLengthIdentity = buildDeterministicSimpleStockMigrationIdentities({
        businessId: "b".repeat(200),
        menuItemId,
    })
    assert.ok(maximumLengthIdentity.openingIdempotencyKey.length <= 200)

    const zeroUnavailable = classifyLegacyMenuItemForSimpleStock({
        ...base,
        stockQuantity: 0,
        isAvailable: false,
    })
    assert.equal(zeroUnavailable.candidate.manualIsAvailable, false)
    assert.equal(zeroUnavailable.candidate.requiresOwnerAvailabilityReview, true)

    for (const [stockQuantity, blocker] of [
        [null, "MISSING_STOCK_QUANTITY"],
        [-1, "INVALID_STOCK_QUANTITY"],
        [1.5, "INVALID_STOCK_QUANTITY"],
    ]) {
        const blocked = classifyLegacyMenuItemForSimpleStock({ ...base, stockQuantity })
        assert.equal(blocked.classification, SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS.BLOCKED)
        assert.ok(blocked.blockers.includes(blocker))
    }
    const untracked = classifyLegacyMenuItemForSimpleStock({ ...base, trackStock: false })
    assert.equal(untracked.classification, SIMPLE_STOCK_MIGRATION_CLASSIFICATIONS.NOT_APPLICABLE)
    assert.ok(untracked.warnings.includes("DORMANT_UNTRACKED_STOCK_QUANTITY"))
})

test("dry-run reports eligibility without writes and blocks cancellation risk", async () => {
    const eligibleId = new mongoose.Types.ObjectId()
    const blockedId = new mongoose.Types.ObjectId()
    const menuItems = [
        {
            _id: eligibleId,
            businessId: "biz_alpha",
            name: "Water",
            trackStock: true,
            stockQuantity: 10,
            lowStockThreshold: 2,
            isAvailable: true,
        },
        {
            _id: blockedId,
            businessId: "biz_alpha",
            name: "Beer",
            trackStock: true,
            stockQuantity: 6,
            lowStockThreshold: 2,
            isAvailable: true,
        },
    ]
    const report = buildSimpleStockMigrationDryRun({
        businessId: "biz_alpha",
        menuItems,
        openLegacyCancellationMenuItemIds: [blockedId],
        generatedAt: new Date("2026-09-04T12:00:00.000Z"),
    })
    assert.equal(report.dryRun, true)
    assert.equal(report.wouldWrite, false)
    assert.equal(report.summary.eligible, 1)
    assert.equal(report.summary.blocked, 1)
    assert.ok(report.items[1].blockers.includes("OPEN_LEGACY_CANCELLATION_RISK"))

    const queried = []
    const readReport = await readSimpleStockMigrationDryRun({ businessId: "biz_alpha" }, {
        MenuItemModel: {
            find(filter) { queried.push(filter); return leanQuery(menuItems) },
        },
        MenuInventoryRecipeModel: {
            find(filter) { queried.push(filter); return leanQuery([]) },
        },
        OrderModel: {
            find(filter) {
                queried.push(filter)
                return leanQuery([{ items: [{ itemName: "Beer" }] }])
            },
        },
        now: () => new Date("2026-09-04T12:00:00.000Z"),
    })
    assert.equal(readReport.summary.blocked, 1)
    assert.ok(queried.every((filter) => filter.businessId === "biz_alpha"))
    assert.equal(queried[2].inventoryRestored.$ne, true)
})

test("Phase 2B production stock cuts over through the compatibility boundary", async () => {
    const inventoryServiceSource = await readFile(
        new URL("../src/services/inventoryService.js", import.meta.url),
        "utf8",
    )
    assert.match(inventoryServiceSource, /isCanonicalSimpleStockEnabled:\s*\(\)\s*=>\s*true/)
    assert.match(inventoryServiceSource, /simpleStockOrderService/)
    assert.doesNotMatch(inventoryServiceSource, /process\.env.*CANONICAL/i)

    const dryRunScriptSource = await readFile(
        new URL("../scripts/audit-simple-stock-migration.js", import.meta.url),
        "utf8",
    )
    assert.match(dryRunScriptSource, /readSimpleStockMigrationDryRun/)
    assert.doesNotMatch(
        dryRunScriptSource,
        /\.(create|save|updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany)\s*\(/,
    )

    for (const relativePath of [
        "../src/controllers/kitchenController.js",
        "../src/controllers/barController.js",
    ]) {
        const source = await readFile(new URL(relativePath, import.meta.url), "utf8")
        assert.doesNotMatch(source, /canonicalInventoryService|InventoryItem|MenuInventoryRecipe/)
    }

    const paymentSource = await readFile(
        new URL("../src/controllers/paymentController.js", import.meta.url),
        "utf8",
    )
    const webhookSource = await readFile(
        new URL("../src/controllers/webhookController.js", import.meta.url),
        "utf8",
    )
    assert.match(paymentSource, /reserveInventoryForSource/)
    assert.match(webhookSource, /finalizePaidOrderWithInventory/)
})
