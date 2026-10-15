import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
    isSimpleStockKillSwitchActive,
} from "../src/services/inventoryRuntimePolicy.js"

test("Phase 2B routes compose menu and inventory permissions", async () => {
    const routes = await readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8")
    for (const path of [
        "/inventory/simple-stock/menu-items",
        "/inventory/simple-stock/menu-items/:menuItemId/adjust",
        "/inventory/simple-stock/menu-items/:menuItemId/settings",
        "/inventory/simple-stock/menu-items/:menuItemId/migrate",
        "/inventory/simple-stock/drift",
        "/inventory/simple-stock/reconcile",
        "/inventory/simple-stock/menu-items/:menuItemId/rollback",
    ]) {
        assert.match(routes, new RegExp(path.replace(/[/:]/g, (value) => value === "/" ? "\\/" : value)))
    }
    assert.match(routes, /requirePermission\(PERMISSIONS\.MENU_MANAGE\)/)
    assert.match(routes, /requirePermission\(PERMISSIONS\.INVENTORY_MANAGE\)/)
    assert.match(routes, /requirePermission\(PERMISSIONS\.INVENTORY_ADJUST\)/)
})

test("offline creation and cancellation own one Phase 4 reservation transaction", async () => {
    for (const path of [
        "../src/controllers/orderController.js",
        "../src/controllers/waitstaffOrdersController.js",
    ]) {
        const source = await readFile(new URL(path, import.meta.url), "utf8")
        assert.match(source, /withCanonicalInventoryTransaction/)
        assert.match(source, /reserveInventoryForSource\(\{/)
        assert.doesNotMatch(source, /Failed to deduct stock[\s\S]{0,300}don't fail the order/i)
    }
    const waitstaff = await readFile(
        new URL("../src/controllers/waitstaffOrdersController.js", import.meta.url),
        "utf8",
    )
    assert.match(waitstaff, /releaseInventoryReservationWithinTransaction\(\{/)
    assert.match(waitstaff, /current\.status\s*=\s*"cancelled"/)
})

test("mapped stock cannot use generic MenuItem mutation endpoints", async () => {
    const controller = await readFile(
        new URL("../src/controllers/menuController.js", import.meta.url),
        "utf8",
    )
    assert.match(controller, /SIMPLE_STOCK_CREATE_REQUIRED/)
    assert.match(controller, /DIRECT_MAPPED_STOCK_MUTATION_FORBIDDEN/)
    assert.match(controller, /archiveMappedMenuItem/)
    assert.match(controller, /setMappedMenuManualAvailability/)
})

test("Simple Stock order movements preserve current deduction semantics only", async () => {
    const service = await readFile(
        new URL("../src/services/simpleStockOrderService.js", import.meta.url),
        "utf8",
    )
    assert.match(service, /LEGACY_ORDER_DEDUCTION/)
    assert.match(service, /LEGACY_ORDER_RESTORE/)
    assert.doesNotMatch(service, /INVENTORY_MOVEMENT_TYPES\.(RESERVE|RELEASE|CONSUME)/)
    assert.match(service, /inventoryDeductionLines/)
    assert.match(service, /withCanonicalInventoryTransaction/)
})

test("the operational kill switch parses explicit truthy values only", () => {
    for (const value of ["1", "true", "YES", "on"]) {
        assert.equal(isSimpleStockKillSwitchActive({ SIMPLE_STOCK_KILL_SWITCH: value }), true)
    }
    for (const value of [undefined, "", "0", "false", "off", "anything"] ) {
        assert.equal(isSimpleStockKillSwitchActive({ SIMPLE_STOCK_KILL_SWITCH: value }), false)
    }
})
