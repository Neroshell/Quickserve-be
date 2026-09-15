import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
    resolveBusinessCapabilities,
    setBusinessModuleEnabled,
} from "./src/services/businessCapabilityService.js"
import {
    assertInventoryDomainAllowedForBusiness,
    resolveInventoryReadDomainsForBusiness,
} from "./src/services/inventoryDomainService.js"
import {
    readInventoryItemsPage,
    readInventoryOverview,
} from "./src/services/ownerInventoryReadService.js"

const read = (path) => readFile(new URL(path, import.meta.url), "utf8")
const [businessController, ownerRoutes, recipeService, simpleStockService, roomTemplateService, roomUsageService, movementModel] = await Promise.all([
    read("./src/controllers/businessController.js"),
    read("./src/routes/owner-route.js"),
    read("./src/services/menuInventoryRecipeService.js"),
    read("./src/services/simpleStockMenuService.js"),
    read("./src/services/hotelRoomSupplyTemplateService.js"),
    read("./src/services/inventoryRoomUsageService.js"),
    read("./src/models/InventoryMovement.js"),
])

const hotelOnly = { businessType: "hotel", modules: ["lodging"] }
const foodOnly = { businessType: "restaurant", modules: ["foodService"] }
const mixed = { businessType: "hotel", modules: ["lodging", "foodService"] }

function overviewCapture(domain) {
    const capture = {}
    const InventoryItemModel = {
        collection: { name: "inventoryitems" },
        async aggregate(pipeline) {
            capture.itemPipeline = pipeline
            return []
        },
    }
    const InventoryMovementModel = {
        async aggregate(pipeline) {
            capture.movementPipeline = pipeline
            return []
        },
    }
    return readInventoryOverview({ businessId: "biz_alpha", domain }, {
        InventoryItemModel,
        InventoryMovementModel,
    }).then(() => capture)
}

test("matrix 13: disabling Food Service does not delete InventoryItems", () => {
    const section = businessController.slice(businessController.indexOf("updateOwnerBusinessModules"), businessController.indexOf("updateOperatingHours"))
    assert.doesNotMatch(section, /InventoryItem|deleteMany|deleteOne/)
})

test("matrix 14: disabling Food Service does not delete recipes", () => {
    const section = businessController.slice(businessController.indexOf("updateOwnerBusinessModules"), businessController.indexOf("updateOperatingHours"))
    assert.doesNotMatch(section, /MenuInventoryRecipe|removeIngredientRecipe|deleteMany/)
})

test("matrix 15: re-enabling Food Service restores its capability context", () => {
    const disabled = { ...mixed, modules: setBusinessModuleEnabled(mixed, "foodService", false) }
    const enabled = { ...disabled, modules: setBusinessModuleEnabled(disabled, "foodService", true) }
    assert.deepEqual(resolveBusinessCapabilities(disabled).inventory.contexts, ["hotelOperations"])
    assert.deepEqual(resolveBusinessCapabilities(enabled).inventory.contexts, ["hotelOperations", "foodService"])
})

test("matrix 17: hotel item reads exclude food_service", () => {
    assert.deepEqual(resolveInventoryReadDomainsForBusiness(hotelOnly), [
        "housekeeping", "guest_supplies", "cleaning", "linen", "general",
    ])
})

test("matrix 18: hotel domain subfilters are accepted", () => {
    assert.deepEqual(resolveInventoryReadDomainsForBusiness(hotelOnly, "linen,cleaning"), ["linen", "cleaning"])
})

test("matrix 21: Standard Supply Templates keep the Phase 2 architecture", () => {
    assert.match(roomTemplateService, /standardSupplyTemplate/)
    assert.match(roomTemplateService, /isHotelOperationalInventoryDomain/)
    assert.doesNotMatch(roomTemplateService, /HotelInventoryItem|RoomSupplyTemplateModel/)
})

test("matrix 22: Food Service item reads exclude hotel domains", () => {
    assert.deepEqual(resolveInventoryReadDomainsForBusiness(foodOnly), ["food_service"])
})

test("matrix 24: recipe item validation remains Food Service-only", () => {
    assert.match(recipeService, /assertFoodServiceInventoryItem/)
    assert.match(recipeService, /INVENTORY_ITEM_NOT_FOOD_SERVICE/)
})

test("matrix 25: Simple Stock keeps its canonical service", () => {
    assert.match(simpleStockService, /executeInventoryMovementWithSimpleStockProjection/)
    assert.match(ownerRoutes, /requireBusinessModule\("foodService"\)[\s\S]*createOwnerSimpleStockMenuItem/)
})

test("matrix 26: Hotel Overview scopes counts to hotel domains", async () => {
    const capture = await overviewCapture("housekeeping,guest_supplies,cleaning,linen,general")
    assert.deepEqual(capture.itemPipeline[0].$match.$or, [{
        domain: { $in: ["housekeeping", "guest_supplies", "cleaning", "linen", "general"] },
    }])
})

test("matrix 27: Food Service Overview includes food_service and legacy fallback", async () => {
    const capture = await overviewCapture("food_service")
    assert.deepEqual(capture.itemPipeline[0].$match.$or, [
        { domain: { $in: ["food_service"] } },
        { domain: { $exists: false } },
        { domain: null },
    ])
})

test("matrix 28: mixed Overview contexts produce distinct server filters", async () => {
    const [hotel, food] = await Promise.all([
        overviewCapture("housekeeping,guest_supplies,cleaning,linen,general"),
        overviewCapture("food_service"),
    ])
    assert.notDeepEqual(hotel.itemPipeline[0].$match.$or, food.itemPipeline[0].$match.$or)
    assert.ok(hotel.movementPipeline)
    assert.ok(food.movementPipeline)
})

test("matrix 31: backend rejects capability-invalid domain mutations", () => {
    assert.throws(
        () => assertInventoryDomainAllowedForBusiness(hotelOnly, "food_service"),
        (error) => error.code === "INVENTORY_DOMAIN_NOT_ENABLED",
    )
    assert.throws(
        () => assertInventoryDomainAllowedForBusiness(foodOnly, "linen"),
        (error) => error.code === "INVENTORY_DOMAIN_NOT_ENABLED",
    )
})

test("matrix 32: capability gates do not replace recipe RBAC", () => {
    assert.match(ownerRoutes, /"\/inventory\/recipes"[\s\S]*requireBusinessModule\("foodService"\)[\s\S]*PERMISSIONS\.MENU_VIEW[\s\S]*PERMISSIONS\.INVENTORY_VIEW/)
})

test("matrix 33: Inventory mutation routes remain permission protected", () => {
    assert.match(ownerRoutes, /"\/inventory\/items"[\s\S]*PERMISSIONS\.INVENTORY_MANAGE[\s\S]*createOwnerInventoryItem/)
})

test("matrix 34: operational item filters remain tenant scoped", async () => {
    let filter
    const InventoryItemModel = {
        find(value) {
            filter = value
            return {
                sort() { return this },
                limit() { return this },
                async lean() { return [] },
            }
        },
    }
    await readInventoryItemsPage({ businessId: "biz_alpha", domain: "linen" }, { InventoryItemModel })
    assert.equal(filter.businessId, "biz_alpha")
})

test("matrix 35: Room Usage still delegates to the canonical command", () => {
    assert.match(roomUsageService, /withCanonicalInventoryTransaction/)
    assert.match(roomUsageService, /sourceType: "room_usage"/)
})

test("matrix 37: Standard Supplies still resolve tenant Room Types and items", () => {
    assert.match(roomTemplateService, /BusinessModel\.findOne\(\{ businessId: tenantId \}\)/)
    assert.match(roomTemplateService, /InventoryItemModel\.find\([\s\S]*businessId: tenantId/)
})

test("matrix 38: canonical CONSUME and immutable movement rules are unchanged", () => {
    assert.match(movementModel, /type === "CONSUME"/)
    assert.match(movementModel, /InventoryMovement is immutable/)
    assert.match(movementModel, /sourceType === "room_usage"/)
})

test("matrix 39: Inventory notifications retain post-commit isolation", () => {
    assert.match(roomUsageService, /safelyNotifyInventoryStockTransitions/)
    assert.match(roomUsageService, /if \(!result\.replayed\)/)
})
