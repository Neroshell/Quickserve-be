import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import mongoose from "mongoose"

import InventoryItem from "../src/models/InventoryItem.js"
import {
    createInventoryItem,
    normalizeInventoryItemCategory,
    normalizeInventoryItemName,
    toInventoryMovementDTO,
    updateInventoryItem,
} from "../src/services/canonicalInventoryService.js"
import { removeInventoryItemFromWorkspace } from "../src/services/inventoryItemLifecycleService.js"
import { readInventoryItem } from "../src/services/ownerInventoryReadService.js"
import {
    archiveMappedMenuItem,
    createSimpleStockMenuItem,
    readSimpleStockMenuRemovalPreview,
    removeSimpleStockMenuAndInventory,
} from "../src/services/simpleStockMenuService.js"

const ACTOR = { staffId: "owner_1", role: "owner", name: "Owner One" }
const FIXED_TIME = new Date("2026-09-06T12:00:00.000Z")

function plainDocument(raw, onSave = null) {
    return {
        ...raw,
        async save(options = {}) {
            await onSave?.(this, options)
            return this
        },
        toObject() {
            const value = { ...this }
            delete value.save
            delete value.toObject
            return value
        },
    }
}

function duplicateHarness({ synchronizeFirstTwoFinds = false } = {}) {
    const items = []
    let id = 0
    let waitingFinds = 0
    let releaseFinds
    const firstFindsReleased = new Promise((resolve) => { releaseFinds = resolve })

    function duplicateKeyError(data) {
        const error = new Error("duplicate key")
        error.code = 11000
        error.keyPattern = { businessId: 1, duplicateIdentityKey: 1 }
        error.keyValue = {
            businessId: data.businessId,
            duplicateIdentityKey: data.duplicateIdentityKey,
        }
        return error
    }

    function matchesFindFilter(item, filter) {
        if (item.businessId !== filter.businessId || item.trackingUnit !== filter.trackingUnit) return false
        if (item.deletedAt) return false
        if (filter.inventoryItemId?.$ne === item.inventoryItemId) return false
        const requestedName = filter.$or?.[0]?.normalizedName
        return normalizeInventoryItemName(item.name) === requestedName
    }

    function toDocument(raw) {
        const document = plainDocument(raw, async (saving) => {
            if (
                saving.duplicateIdentityKey &&
                items.some((candidate) => (
                    candidate !== saving &&
                    !candidate.deletedAt &&
                    candidate.businessId === saving.businessId &&
                    candidate.duplicateIdentityKey === saving.duplicateIdentityKey
                ))
            ) {
                throw duplicateKeyError(saving)
            }
        })
        return document
    }

    const InventoryItemModel = {
        async find(filter) {
            if (synchronizeFirstTwoFinds && items.length === 0 && waitingFinds < 2) {
                waitingFinds += 1
                if (waitingFinds === 2) releaseFinds()
                await firstFindsReleased
            }
            return items.filter((item) => matchesFindFilter(item, filter))
        },
        async findOne(filter) {
            return items.find((item) => (
                item.businessId === filter.businessId &&
                item.inventoryItemId === filter.inventoryItemId
            )) || null
        },
        async create(data) {
            if (
                data.duplicateIdentityKey &&
                items.some((candidate) => (
                    !candidate.deletedAt &&
                    candidate.businessId === data.businessId &&
                    candidate.duplicateIdentityKey === data.duplicateIdentityKey
                ))
            ) {
                throw duplicateKeyError(data)
            }
            const document = toDocument({
                ...data,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
            })
            items.push(document)
            return document
        },
    }

    return {
        InventoryItemModel,
        dependencies: {
            InventoryItemModel,
            InventoryMovementModel: { async exists() { return false } },
            generateId: () => `inv_${++id}`,
        },
        items,
        seed(raw) {
            const document = toDocument({
                onHandQuantity: 0,
                reservedQuantity: 0,
                lowStockThreshold: 0,
                unitCostMinor: null,
                costCurrency: null,
                isActive: true,
                createdAt: FIXED_TIME,
                updatedAt: FIXED_TIME,
                ...raw,
            })
            items.push(document)
            return document
        },
    }
}

function createItem(harness, {
    businessId = "biz_alpha",
    name = "Chicken",
    category = "Desserts",
    trackingUnit = "portion",
    allowCategoryVariant = false,
} = {}) {
    return createInventoryItem({
        businessId,
        input: { name, category, trackingUnit },
        allowCategoryVariant,
    }, harness.dependencies)
}

test("normalized duplicate rules block strong matches while category, unit, and tenant variants stay intentional", async () => {
    const harness = duplicateHarness()
    const original = await createItem(harness)

    await assert.rejects(
        createItem(harness, { name: "  chicken  ", category: " desserts " }),
        (error) => {
            assert.equal(error.code, "INVENTORY_ITEM_DUPLICATE")
            assert.equal(error.details.conflictType, "strong")
            assert.equal(error.details.canContinue, false)
            assert.equal(error.details.candidate.inventoryItemId, original.inventoryItemId)
            assert.equal("businessId" in error.details.candidate, false)
            return true
        },
    )

    await assert.rejects(
        createItem(harness, { category: "Appetizers" }),
        (error) => error.code === "INVENTORY_ITEM_CATEGORY_VARIANT" &&
            error.details.conflictType === "category_variant" &&
            error.details.canContinue === true,
    )
    await createItem(harness, { category: "Appetizers", allowCategoryVariant: true })
    await createItem(harness, { trackingUnit: "piece" })
    await createItem(harness, { businessId: "biz_other" })

    assert.equal(harness.items.length, 4)
    assert.equal(normalizeInventoryItemName("  CHICKEN   breast "), "chicken breast")
    assert.equal(normalizeInventoryItemCategory("  Main   Kitchen "), "main kitchen")
})

test("the tenant-scoped partial unique key elects one winner during concurrent strong creation", async () => {
    const harness = duplicateHarness({ synchronizeFirstTwoFinds: true })
    const results = await Promise.allSettled([
        createItem(harness),
        createItem(harness),
    ])

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
    const rejected = results.find((result) => result.status === "rejected")
    assert.equal(rejected.reason.code, "INVENTORY_ITEM_DUPLICATE")
    assert.equal(rejected.reason.details.conflictType, "strong")
    assert.equal(harness.items.length, 1)

    const indexes = InventoryItem.schema.indexes()
    assert.ok(indexes.some(([fields, options]) => (
        fields.businessId === 1 &&
        fields.duplicateIdentityKey === 1 &&
        options.unique === true &&
        options.partialFilterExpression?.duplicateIdentityKey?.$type === "string" &&
        options.partialFilterExpression?.deletedAt === null
    )))
})

test("a historically preserved removed item releases its operational duplicate slot", async () => {
    const harness = duplicateHarness()
    await createItem(harness)
    harness.items[0].isActive = false
    harness.items[0].deletedAt = FIXED_TIME

    const replacement = await createItem(harness)
    assert.notEqual(replacement.inventoryItemId, harness.items[0].inventoryItemId)
    assert.equal(harness.items.length, 2)
})

test("renames into a strong duplicate are blocked and legacy duplicates are never auto-merged", async () => {
    const harness = duplicateHarness()
    const chicken = await createItem(harness)
    const breast = await createItem(harness, { name: "Chicken Breast" })

    await assert.rejects(
        updateInventoryItem({
            businessId: "biz_alpha",
            inventoryItemId: breast.inventoryItemId,
            input: { name: " chicken " },
        }, harness.dependencies),
        (error) => error.code === "INVENTORY_ITEM_DUPLICATE" &&
            error.details.candidate.inventoryItemId === chicken.inventoryItemId,
    )

    const legacyHarness = duplicateHarness()
    const first = legacyHarness.seed({
        inventoryItemId: "inv_legacy_1",
        businessId: "biz_alpha",
        name: "Chicken",
        category: "Desserts",
        trackingUnit: "portion",
        baseUnitDimension: "count",
        onHandQuantity: 11,
    })
    legacyHarness.seed({
        inventoryItemId: "inv_legacy_2",
        businessId: "biz_alpha",
        name: " chicken ",
        category: "desserts",
        trackingUnit: "portion",
        baseUnitDimension: "count",
        onHandQuantity: 3,
    })
    await updateInventoryItem({
        businessId: "biz_alpha",
        inventoryItemId: first.inventoryItemId,
        input: { isActive: false },
    }, legacyHarness.dependencies)

    assert.equal(legacyHarness.items.length, 2)
    assert.deepEqual(legacyHarness.items.map((item) => item.onHandQuantity), [11, 3])
    assert.equal(legacyHarness.items[0].duplicateIdentityKey, undefined)
})

function lifecycleHarness({
    hasMovement = false,
    hasMapping = false,
    hasReservation = false,
    hasOrder = false,
    onHandQuantity = 0,
    businessId = "biz_alpha",
} = {}) {
    let item = plainDocument({
        inventoryItemId: "inv_lifecycle",
        businessId,
        name: "Gulder Beer",
        category: "Drinks",
        trackingUnit: "bottle",
        baseUnitDimension: "count",
        onHandQuantity,
        reservedQuantity: 0,
        lowStockThreshold: 2,
        unitCostMinor: null,
        costCurrency: null,
        isActive: true,
        deletedAt: null,
        deletedBy: null,
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
    })
    const filters = []
    const existsModel = (value) => ({
        async exists(filter) {
            filters.push(filter)
            return value
        },
    })
    const dependencies = {
        InventoryItemModel: {
            async findOne(filter) {
                filters.push(filter)
                return item && filter.businessId === item.businessId &&
                    filter.inventoryItemId === item.inventoryItemId ? item : null
            },
            async deleteOne(filter) {
                filters.push(filter)
                if (!item || filter.businessId !== item.businessId || filter.inventoryItemId !== item.inventoryItemId) {
                    return { deletedCount: 0 }
                }
                item = null
                return { deletedCount: 1 }
            },
        },
        InventoryMovementModel: existsModel(hasMovement),
        MenuInventoryRecipeModel: {
            ...existsModel(hasMapping),
            async find(filter) {
                filters.push(filter)
                return []
            },
        },
        InventoryReservationModel: existsModel(hasReservation),
        OrderModel: existsModel(hasOrder),
        MenuItemModel: { async updateMany() { return { modifiedCount: 0 } } },
        now: () => FIXED_TIME,
    }
    return {
        dependencies,
        filters,
        get item() { return item },
    }
}

test("archive/reactivate preserves identity and an unused item can be physically removed", async () => {
    const duplicate = duplicateHarness()
    const created = await createItem(duplicate)
    const archived = await updateInventoryItem({
        businessId: "biz_alpha",
        inventoryItemId: created.inventoryItemId,
        input: { isActive: false },
    }, duplicate.dependencies)
    const reactivated = await updateInventoryItem({
        businessId: "biz_alpha",
        inventoryItemId: created.inventoryItemId,
        input: { isActive: true },
    }, duplicate.dependencies)
    assert.equal(archived.isActive, false)
    assert.equal(reactivated.isActive, true)
    assert.equal(reactivated.inventoryItemId, created.inventoryItemId)

    const lifecycle = lifecycleHarness()
    const removal = await removeInventoryItemFromWorkspace({
        businessId: "biz_alpha",
        inventoryItemId: "inv_lifecycle",
        actor: ACTOR,
        session: {},
    }, lifecycle.dependencies)
    assert.equal(removal.preservation, "hard")
    assert.equal(lifecycle.item, null)
    assert.ok(lifecycle.filters.every((filter) => filter.businessId === "biz_alpha"))
})

test("historically used items become hidden tombstones while item and movement history remain readable", async () => {
    const lifecycle = lifecycleHarness({ hasMovement: true, onHandQuantity: 14 })
    const historicalMovement = {
        movementId: "imv_history",
        inventoryItemId: "inv_lifecycle",
        type: "RECEIVE",
        quantityDeltaOnHand: 14,
        quantityDeltaReserved: 0,
        unit: "bottle",
        canonicalQuantity: 14,
        onHandBefore: 0,
        onHandAfter: 14,
        reservedBefore: 0,
        reservedAfter: 0,
        sourceType: "manual_receive",
        performedBy: ACTOR,
        createdAt: FIXED_TIME,
    }
    const removal = await removeInventoryItemFromWorkspace({
        businessId: "biz_alpha",
        inventoryItemId: "inv_lifecycle",
        actor: ACTOR,
        session: {},
    }, lifecycle.dependencies)

    assert.equal(removal.preservation, "historical")
    assert.equal(lifecycle.item.isActive, false)
    assert.equal(lifecycle.item.deletedAt, FIXED_TIME)
    assert.deepEqual(lifecycle.item.deletedBy, ACTOR)
    const historicalItem = await readInventoryItem({
        businessId: "biz_alpha",
        inventoryItemId: "inv_lifecycle",
    }, {
        InventoryItemModel: {
            findOne(filter) {
                assert.deepEqual(filter, {
                    businessId: "biz_alpha",
                    inventoryItemId: "inv_lifecycle",
                })
                return { async lean() { return lifecycle.item.toObject() } }
            },
        },
    })
    assert.equal(historicalItem.name, "Gulder Beer")
    assert.equal(historicalItem.isDeleted, true)
    assert.equal(toInventoryMovementDTO(historicalMovement).onHandAfter, 14)
    assert.equal(historicalMovement.inventoryItemId, historicalItem.inventoryItemId)
})

function sessionFactory() {
    return async () => ({
        async withTransaction(work) { await work() },
        async endSession() {},
    })
}

function simpleStockCreationHarness({ isActive = true } = {}) {
    const inventoryItem = plainDocument({
        inventoryItemId: "inv_existing",
        businessId: "biz_alpha",
        name: "Gulder Beer",
        category: "Beverages",
        trackingUnit: "bottle",
        baseUnitDimension: "count",
        onHandQuantity: 14,
        reservedQuantity: 3,
        lowStockThreshold: 2,
        unitCostMinor: null,
        costCurrency: null,
        isActive,
        deletedAt: null,
    })
    let menuItem = null
    let mapping = null
    let adjustments = 0
    const dependencies = {
        InventoryItemModel: {
            async findOne(filter) {
                return filter.businessId === "biz_alpha" &&
                    filter.inventoryItemId === inventoryItem.inventoryItemId ? inventoryItem : null
            },
        },
        MenuItemModel: {
            async findOne() { return null },
            async create([raw]) {
                menuItem = plainDocument(raw)
                return [menuItem]
            },
        },
        MenuInventoryRecipeModel: {
            async create([raw]) {
                mapping = plainDocument(raw)
                return [mapping]
            },
        },
        async adjustInventoryCommand() { adjustments += 1 },
        async createInventoryItemCommand() { throw new Error("reuse must not create inventory") },
        startSession: sessionFactory(),
        async invalidateMenu() {},
        async enrichMenuItems({ menuItems }) { return menuItems },
    }
    return {
        dependencies,
        inventoryItem,
        get menuItem() { return menuItem },
        get mapping() { return mapping },
        get adjustments() { return adjustments },
    }
}

function createReusedSimpleStock(harness, reactivateInventoryItem = false) {
    return createSimpleStockMenuItem({
        businessId: "biz_alpha",
        input: {
            name: " Gulder   Beer ",
            category: " beverages ",
            price: 500,
            type: "drinks",
            fulfillmentStation: "bar",
            fulfillmentBehavior: "direct",
            prepTimeMinutes: null,
            stockUnit: "bottle",
            openingQuantity: 99,
            lowStockThreshold: 4,
            inventoryItemId: "inv_existing",
            reactivateInventoryItem,
        },
        actor: ACTOR,
        idempotencyKey: `reuse-${reactivateInventoryItem}`,
    }, harness.dependencies)
}

test("Simple Stock can reuse an active item without overwriting its authoritative balance", async () => {
    const harness = simpleStockCreationHarness()
    await createReusedSimpleStock(harness)

    assert.equal(harness.inventoryItem.onHandQuantity, 14)
    assert.equal(harness.inventoryItem.reservedQuantity, 3)
    assert.equal(harness.adjustments, 0)
    assert.equal(harness.mapping.components[0].inventoryItemId, "inv_existing")
    assert.equal(harness.menuItem.stockQuantity, 11)
})

test("Simple Stock requires explicit recovery before reusing an inactive matching item", async () => {
    const blocked = simpleStockCreationHarness({ isActive: false })
    await assert.rejects(
        createReusedSimpleStock(blocked),
        (error) => error.code === "INVENTORY_ITEM_DUPLICATE" &&
            error.details.candidate.isActive === false,
    )
    assert.equal(blocked.inventoryItem.isActive, false)

    const recovered = simpleStockCreationHarness({ isActive: false })
    await createReusedSimpleStock(recovered, true)
    assert.equal(recovered.inventoryItem.isActive, true)
    assert.equal(recovered.inventoryItem.onHandQuantity, 14)
    assert.equal(recovered.adjustments, 0)
})

function menuRemovalHarness({ sharedCount = 0 } = {}) {
    const menuItem = plainDocument({
        _id: "507f1f77bcf86cd799439011",
        businessId: "biz_alpha",
        name: "Gulder Beer",
        archivedAt: null,
        manualIsAvailable: true,
        isAvailable: true,
    })
    const mapping = plainDocument({
        businessId: "biz_alpha",
        menuItemId: menuItem._id,
        mode: "simple",
        status: "active",
        components: [{ inventoryItemId: "inv_existing" }],
        disabledReason: null,
        disabledAt: null,
        archivedAt: null,
    })
    const inventoryItem = {
        inventoryItemId: "inv_existing",
        businessId: "biz_alpha",
        name: "Gulder Beer",
        trackingUnit: "bottle",
        onHandQuantity: 14,
        reservedQuantity: 0,
    }
    const filters = []
    let inventoryRemovalCalls = 0
    const dependencies = {
        MenuItemModel: {
            async findOne(filter) {
                filters.push(filter)
                return filter.businessId === "biz_alpha" && String(filter._id) === menuItem._id
                    ? menuItem
                    : null
            },
            async countDocuments(filter) {
                filters.push(filter)
                return sharedCount
            },
        },
        MenuInventoryRecipeModel: {
            async findOne(filter) {
                filters.push(filter)
                return filter.businessId === "biz_alpha" && String(filter.menuItemId) === menuItem._id
                    ? mapping
                    : null
            },
            async find(filter) {
                filters.push(filter)
                return sharedCount > 0
                    ? [{ menuItemId: "507f1f77bcf86cd799439012" }]
                    : []
            },
        },
        InventoryItemModel: {
            async findOne(filter) {
                filters.push(filter)
                return filter.businessId === "biz_alpha" &&
                    filter.inventoryItemId === inventoryItem.inventoryItemId ? inventoryItem : null
            },
        },
        async removeInventoryItem(args) {
            inventoryRemovalCalls += 1
            assert.equal(args.businessId, "biz_alpha")
            assert.equal(args.inventoryItemId, "inv_existing")
            return { preservation: "historical" }
        },
        startSession: sessionFactory(),
        now: () => FIXED_TIME,
        async invalidateMenu() {},
    }
    return {
        dependencies,
        filters,
        inventoryItem,
        mapping,
        menuItem,
        get inventoryRemovalCalls() { return inventoryRemovalCalls },
    }
}

test("menu-only removal archives the relationship and leaves InventoryItem state intact", async () => {
    const harness = menuRemovalHarness()
    const before = structuredClone(harness.inventoryItem)
    await archiveMappedMenuItem({
        businessId: "biz_alpha",
        menuItemId: harness.menuItem._id,
    }, harness.dependencies)

    assert.equal(harness.mapping.status, "archived")
    assert.equal(harness.menuItem.archivedAt, FIXED_TIME)
    assert.deepEqual(harness.inventoryItem, before)
    assert.equal(harness.inventoryRemovalCalls, 0)
})

test("exclusive Simple Stock can remove menu and inventory in one lifecycle action", async () => {
    const harness = menuRemovalHarness()
    const preview = await readSimpleStockMenuRemovalPreview({
        businessId: "biz_alpha",
        menuItemId: harness.menuItem._id,
    }, harness.dependencies)
    assert.equal(preview.canRemoveInventory, true)
    assert.equal(preview.inventoryItem.availableQuantity, 14)

    const result = await removeSimpleStockMenuAndInventory({
        businessId: "biz_alpha",
        menuItemId: harness.menuItem._id,
        actor: ACTOR,
    }, harness.dependencies)
    assert.equal(result.removed, true)
    assert.equal(harness.mapping.status, "archived")
    assert.equal(harness.menuItem.archivedAt, FIXED_TIME)
    assert.equal(harness.inventoryRemovalCalls, 1)
    assert.ok(harness.filters.every((filter) => filter.businessId === "biz_alpha"))
})

test("shared active inventory blocks menu-plus-inventory cascade but still permits menu-only removal", async () => {
    const shared = menuRemovalHarness({ sharedCount: 1 })
    const preview = await readSimpleStockMenuRemovalPreview({
        businessId: "biz_alpha",
        menuItemId: shared.menuItem._id,
    }, shared.dependencies)
    assert.equal(preview.canRemoveInventory, false)
    assert.equal(preview.sharedActiveRelationshipCount, 1)
    await assert.rejects(
        removeSimpleStockMenuAndInventory({
            businessId: "biz_alpha",
            menuItemId: shared.menuItem._id,
            actor: ACTOR,
        }, shared.dependencies),
        (error) => error.code === "SIMPLE_STOCK_INVENTORY_SHARED" && error.statusCode === 409,
    )
    assert.equal(shared.inventoryRemovalCalls, 0)
    assert.equal(shared.mapping.status, "active")

    await archiveMappedMenuItem({
        businessId: "biz_alpha",
        menuItemId: shared.menuItem._id,
    }, shared.dependencies)
    assert.equal(shared.mapping.status, "archived")
    assert.equal(shared.inventoryRemovalCalls, 0)
})

test("lifecycle and cascade routes reuse canonical inventory/menu permissions", async () => {
    const routes = await readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8")
    assert.match(
        routes,
        /router\.delete\(\s*"\/inventory\/items\/:inventoryItemId",\s*requirePermission\(PERMISSIONS\.INVENTORY_MANAGE\)/,
    )
    for (const method of ["get", "delete"]) {
        assert.match(
            routes,
            new RegExp(`router\\.${method}\\(\\s*"\\/inventory\\/simple-stock\\/menu-items\\/:menuItemId(?:\\/removal-preview)?",\\s*requirePermission\\(PERMISSIONS\\.MENU_MANAGE\\),\\s*requirePermission\\(PERMISSIONS\\.INVENTORY_MANAGE\\)`),
        )
    }
})

const transactionTestUri = process.env.INVENTORY_TEST_MONGODB_URI

test("real Mongo unique enforcement prevents simultaneous exact duplicate inserts", {
    skip: transactionTestUri
        ? false
        : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async () => {
    const databaseName = `quickserve_inventory_lifecycle_${Date.now()}`
    await mongoose.connect(transactionTestUri, { dbName: databaseName })
    try {
        await InventoryItem.syncIndexes()
        const results = await Promise.allSettled([
            createInventoryItem({
                businessId: "biz_concurrent",
                input: { name: "Chicken", category: "Desserts", trackingUnit: "portion" },
            }),
            createInventoryItem({
                businessId: "biz_concurrent",
                input: { name: " chicken ", category: " desserts ", trackingUnit: "portion" },
            }),
        ])
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
        assert.equal(results.filter((result) => result.status === "rejected").length, 1)
        assert.equal(await InventoryItem.countDocuments({ businessId: "biz_concurrent" }), 1)
    } finally {
        await mongoose.connection.db.dropDatabase()
        await mongoose.disconnect()
    }
})
