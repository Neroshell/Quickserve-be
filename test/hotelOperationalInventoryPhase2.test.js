import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import Business from "../src/models/Business.js"
import {
    readRoomTypeSupplyTemplate,
    readRoomUsageContext,
    updateRoomTypeSupplyTemplate,
} from "../src/services/hotelRoomSupplyTemplateService.js"

const HOTEL_ITEM = {
    inventoryItemId: "inv_soap",
    businessId: "hotel_a",
    name: "Soap",
    domain: "guest_supplies",
    category: "Bathroom Amenities",
    trackingUnit: "piece",
    baseUnitDimension: "count",
    onHandQuantity: 20,
    reservedQuantity: 4,
    lowStockThreshold: 5,
    unitCostMinor: null,
    costCurrency: null,
    isActive: true,
    deletedAt: null,
}

function clone(value) {
    return structuredClone(value)
}

function hotelBusiness(overrides = {}) {
    return {
        businessId: "hotel_a",
        businessType: "hotel",
        modules: ["lodging"],
        hotelRoomTypes: [{
            name: "Deluxe King",
            active: true,
            isDefault: false,
            standardSupplyTemplate: [],
        }],
        async save() {},
        ...overrides,
    }
}

function updateDependencies({ business = hotelBusiness(), inventoryItems = [HOTEL_ITEM] } = {}) {
    return {
        business,
        dependencies: {
            BusinessModel: {
                async findOne(filter) {
                    return filter.businessId === business.businessId ? business : null
                },
            },
            InventoryItemModel: {
                async find(filter) {
                    const ids = new Set(filter.inventoryItemId.$in)
                    return inventoryItems.filter((item) => (
                        item.businessId === filter.businessId &&
                        ids.has(item.inventoryItemId) &&
                        (!Object.hasOwn(filter, "deletedAt") || item.deletedAt === filter.deletedAt)
                    )).map(clone)
                },
            },
        },
    }
}

test("Room Types store a standard supply template without introducing a new persistence model", async () => {
    const roomTypeSchema = Business.schema.path("hotelRoomTypes").schema
    const templatePath = roomTypeSchema.path("standardSupplyTemplate")
    assert.ok(templatePath)
    assert.ok(templatePath.schema.path("inventoryItemId"))
    assert.ok(templatePath.schema.path("quantity"))
    assert.ok(templatePath.schema.path("unit"))
    assert.ok(templatePath.schema.path("canonicalQuantity"))

    const serviceSource = await readFile(
        new URL("../src/services/hotelRoomSupplyTemplateService.js", import.meta.url),
        "utf8",
    )
    assert.doesNotMatch(serviceSource, /mongoose\.model\(|InventoryMovement\.create|HotelInventory/i)
})

test("standard supplies validate tenant-owned active hotel inventory and canonical quantities", async () => {
    const harness = updateDependencies()
    const result = await updateRoomTypeSupplyTemplate({
        businessId: "hotel_a",
        roomTypeName: "Deluxe King",
        items: [{ inventoryItemId: "inv_soap", quantity: 2, unit: "piece" }],
    }, harness.dependencies)

    assert.equal(result.roomTypeName, "Deluxe King")
    assert.deepEqual(harness.business.hotelRoomTypes[0].standardSupplyTemplate, [{
        inventoryItemId: "inv_soap",
        quantity: 2,
        unit: "piece",
        canonicalQuantity: 2,
    }])
    assert.equal(result.items[0].inventoryItem.name, "Soap")
    assert.equal(result.items[0].status, "available")

    await assert.rejects(
        updateRoomTypeSupplyTemplate({
            businessId: "hotel_a",
            roomTypeName: "Deluxe King",
            items: [
                { inventoryItemId: "inv_soap", quantity: 1, unit: "piece" },
                { inventoryItemId: "inv_soap", quantity: 1, unit: "piece" },
            ],
        }, harness.dependencies),
        (error) => error.code === "DUPLICATE_ROOM_SUPPLY_ITEM",
    )
    await assert.rejects(
        updateRoomTypeSupplyTemplate({
            businessId: "hotel_a",
            roomTypeName: "Deluxe King",
            items: [{ inventoryItemId: "inv_soap", quantity: 0, unit: "piece" }],
        }, harness.dependencies),
        (error) => error.code === "INVALID_QUANTITY",
    )
})

test("standard supplies reject cross-tenant, inactive, food-service, and incompatible items", async () => {
    const cases = [
        {
            item: { ...HOTEL_ITEM, businessId: "hotel_b" },
            code: "ROOM_SUPPLY_INVENTORY_ITEM_NOT_FOUND",
        },
        {
            item: { ...HOTEL_ITEM, isActive: false },
            code: "ROOM_SUPPLY_INVENTORY_ITEM_INACTIVE",
        },
        {
            item: { ...HOTEL_ITEM, domain: "food_service" },
            code: "INVENTORY_ITEM_NOT_ROOM_SUPPLY_ELIGIBLE",
        },
    ]

    for (const scenario of cases) {
        const harness = updateDependencies({ inventoryItems: [scenario.item] })
        await assert.rejects(
            updateRoomTypeSupplyTemplate({
                businessId: "hotel_a",
                roomTypeName: "Deluxe King",
                items: [{ inventoryItemId: "inv_soap", quantity: 1, unit: "piece" }],
            }, harness.dependencies),
            (error) => error.code === scenario.code,
        )
    }

    const harness = updateDependencies()
    await assert.rejects(
        updateRoomTypeSupplyTemplate({
            businessId: "hotel_a",
            roomTypeName: "Deluxe King",
            items: [{ inventoryItemId: "inv_soap", quantity: 1, unit: "ml" }],
        }, harness.dependencies),
        (error) => error.code === "INCOMPATIBLE_INVENTORY_UNIT",
    )
})

test("Room Usage context resolves a Room ServicePoint template as editable suggestions", async () => {
    const business = hotelBusiness({
        hotelRoomTypes: [{
            name: "Deluxe King",
            active: true,
            isDefault: false,
            standardSupplyTemplate: [
                { inventoryItemId: "inv_soap", quantity: 2, unit: "piece", canonicalQuantity: 2 },
                { inventoryItemId: "inv_old", quantity: 1, unit: "piece", canonicalQuantity: 1 },
            ],
        }],
    })
    const items = [HOTEL_ITEM, {
        ...HOTEL_ITEM,
        inventoryItemId: "inv_old",
        name: "Old slippers",
        isActive: false,
    }]
    const result = await readRoomUsageContext({
        businessId: "hotel_a",
        servicePointId: "sp_room_401",
    }, {
        BusinessModel: { async findOne() { return business } },
        ServicePointModel: {
            async find() {
                return [{
                    businessId: "hotel_a",
                    servicePointId: "sp_room_401",
                    servicePointType: "room",
                    isActive: true,
                    label: "Room 401",
                    roomType: "Deluxe King",
                }]
            },
        },
        InventoryItemModel: {
            async find(filter) {
                const ids = filter.inventoryItemId?.$in
                    ? new Set(filter.inventoryItemId.$in)
                    : null
                return items.filter((item) => (
                    item.businessId === filter.businessId &&
                    (!ids || ids.has(item.inventoryItemId)) &&
                    (!Object.hasOwn(filter, "deletedAt") || item.deletedAt === filter.deletedAt) &&
                    (!Object.hasOwn(filter, "isActive") || item.isActive === filter.isActive)
                ))
            },
        },
    })

    assert.equal(result.selectedRoom.servicePointId, "sp_room_401")
    assert.equal(result.template.configured, true)
    assert.equal(result.template.roomTypeName, "Deluxe King")
    assert.deepEqual(result.items.map((item) => item.inventoryItemId), ["inv_soap"])
    assert.deepEqual(result.template.suggestions.map((line) => [
        line.inventoryItemId,
        line.quantity,
        line.unit,
    ]), [["inv_soap", 2, "piece"]])
    assert.deepEqual(result.template.unavailableItems, [{
        inventoryItemId: "inv_old",
        status: "inactive",
        name: "Old slippers",
    }])
})

test("a room without a configured template remains valid for manual Phase 1 usage", async () => {
    const business = hotelBusiness()
    const result = await readRoomUsageContext({
        businessId: "hotel_a",
        servicePointId: "sp_room_402",
    }, {
        BusinessModel: { async findOne() { return business } },
        ServicePointModel: {
            async find() {
                return [{
                    businessId: "hotel_a",
                    servicePointId: "sp_room_402",
                    servicePointType: "room",
                    isActive: true,
                    label: "Room 402",
                    roomType: "Deluxe King",
                }]
            },
        },
        InventoryItemModel: { async find() { return [] } },
    })
    assert.equal(result.template.configured, false)
    assert.deepEqual(result.template.suggestions, [])
})

test("template reads keep unavailable lines visible for owner correction", async () => {
    const business = hotelBusiness({
        hotelRoomTypes: [{
            name: "Deluxe King",
            active: true,
            isDefault: false,
            standardSupplyTemplate: [{
                inventoryItemId: "inv_missing",
                quantity: 2,
                unit: "piece",
                canonicalQuantity: 2,
            }],
        }],
    })
    const result = await readRoomTypeSupplyTemplate({
        businessId: "hotel_a",
        roomTypeName: "Deluxe King",
    }, {
        BusinessModel: { async findOne() { return business } },
        InventoryItemModel: { async find() { return [] } },
    })
    assert.equal(result.items[0].status, "missing")
    assert.equal(result.items[0].inventoryItem, null)
})

test("Phase 2 routes preserve dual permissions and the Phase 1 confirmation command", async () => {
    const [businessRoutes, ownerRoutes, roomUsageService] = await Promise.all([
        readFile(new URL("../src/routes/business-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/services/inventoryRoomUsageService.js", import.meta.url), "utf8"),
    ])
    assert.match(
        businessRoutes,
        /"\/room-types\/supply-template"[\s\S]*SERVICE_POINTS_MANAGE[\s\S]*INVENTORY_MANAGE[\s\S]*updateHotelRoomTypeSupplyTemplate/,
    )
    assert.match(
        ownerRoutes,
        /"\/inventory\/room-usage\/context"[\s\S]*INVENTORY_MANAGE[\s\S]*getOwnerRoomUsageContext/,
    )
    assert.match(roomUsageService, /INVENTORY_MOVEMENT_TYPES\.CONSUME/)
    assert.doesNotMatch(roomUsageService, /standardSupplyTemplate/)
})
