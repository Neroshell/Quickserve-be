import assert from "node:assert/strict"
import test from "node:test"

import { createMenuItem, updateMenuItem } from "../src/controllers/menuController.js"
import MenuInventoryRecipe from "../src/models/MenuInventoryRecipe.js"
import MenuItem from "../src/models/menuItem.js"
import { responseCache } from "../src/services/responseCacheService.js"
import { createSimpleStockMenuItem } from "../src/services/simpleStockMenuService.js"
import {
    MENU_ITEM_PRICE_ERROR,
    parseMenuItemPrice,
} from "../src/utils/menuItemPrice.js"

function createResponse() {
    return {
        statusCode: null,
        body: null,
        status(statusCode) {
            this.statusCode = statusCode
            return this
        },
        json(body) {
            if (this.statusCode === null) this.statusCode = 200
            this.body = body
            return this
        },
    }
}

function createMenuPayload(price = 12.5) {
    return {
        businessId: "biz_price_integrity",
        name: "Price Integrity Item",
        price,
        prepTimeMinutes: 10,
        category: "mains",
        type: "food",
        fulfillmentStation: "kitchen",
        fulfillmentBehavior: "prepared",
    }
}

function createMenuDocument(price) {
    const payload = createMenuPayload()
    payload.price = price
    return new MenuItem(payload)
}

function createSimpleStockInput(price) {
    return {
        name: "Tracked Price Integrity Item",
        price,
        prepTimeMinutes: 10,
        category: "mains",
        type: "food",
        fulfillmentStation: "kitchen",
        fulfillmentBehavior: "prepared",
        openingQuantity: 0,
        lowStockThreshold: 0,
        stockUnit: "piece",
    }
}

const actor = { staffId: "owner_price", role: "owner", name: "Price Owner" }

test("price parser accepts positive decimal values and rejects unsafe representations", () => {
    assert.equal(parseMenuItemPrice(12), 12)
    assert.equal(parseMenuItemPrice("12.50"), 12.5)
    assert.equal(parseMenuItemPrice(" .5 "), 0.5)

    for (const value of [undefined, null, "", "   ", 0, "0", "0.00", -1, "-1", Number.NaN, Number.POSITIVE_INFINITY, "Infinity", "12abc", "0x10"]) {
        assert.equal(parseMenuItemPrice(value), null, `expected ${String(value)} to be rejected`)
    }
})

test("MenuItem model enforces a finite price greater than zero", () => {
    assert.equal(createMenuDocument(12.5).validateSync(), undefined)

    for (const price of [undefined, null, "", 0, -1, Number.POSITIVE_INFINITY]) {
        const validationError = createMenuDocument(price).validateSync()
        assert.ok(validationError?.errors?.price)
    }
})

test("standard MenuItem creation rejects invalid prices before persistence", async () => {
    for (const price of [undefined, null, "", "   ", 0, "0", "0.00", -1, "-1", Number.NaN, Number.POSITIVE_INFINITY, "Infinity", "12abc"]) {
        const response = createResponse()
        const body = createMenuPayload()
        body.price = price
        await createMenuItem({ body, query: {} }, response)
        assert.equal(response.statusCode, 400, `expected ${String(price)} to be rejected`)
        assert.equal(response.body.error, MENU_ITEM_PRICE_ERROR)
    }
})

test("standard MenuItem creation stores a normalized positive price", async (t) => {
    t.mock.method(MenuItem.prototype, "save", async function save() {
        return this
    })
    t.mock.method(responseCache, "delMany", async () => true)

    const response = createResponse()
    await createMenuItem({ body: createMenuPayload("12.50"), query: {} }, response)

    assert.equal(response.statusCode, 201)
    assert.equal(response.body.price, 12.5)
})

test("standard MenuItem update accepts no-price and positive-price changes but rejects invalid supplied prices", async (t) => {
    const existingItem = createMenuPayload(12.5)
    const updates = []

    t.mock.method(MenuItem, "findOne", () => ({ lean: async () => existingItem }))
    t.mock.method(MenuInventoryRecipe, "exists", async () => null)
    t.mock.method(MenuItem, "findOneAndUpdate", async (_filter, update) => {
        updates.push(update)
        return { ...existingItem, ...update.$set }
    })
    t.mock.method(responseCache, "delMany", async () => true)

    const noPriceResponse = createResponse()
    await updateMenuItem({
        params: { id: "507f1f77bcf86cd799439011" },
        body: { businessId: existingItem.businessId, description: "Updated description" },
        query: {},
    }, noPriceResponse)
    assert.equal(noPriceResponse.statusCode, 200)
    assert.equal(updates[0].$set.price, undefined)

    const positivePriceResponse = createResponse()
    await updateMenuItem({
        params: { id: "507f1f77bcf86cd799439011" },
        body: { businessId: existingItem.businessId, price: "19.95" },
        query: {},
    }, positivePriceResponse)
    assert.equal(positivePriceResponse.statusCode, 200)
    assert.equal(updates[1].$set.price, 19.95)

    for (const price of [null, "", "   ", 0, "0", "0.00", -1, "-1", Number.NaN, Number.POSITIVE_INFINITY, "Infinity", "12abc"]) {
        const response = createResponse()
        await updateMenuItem({
            params: { id: "507f1f77bcf86cd799439011" },
            body: { businessId: existingItem.businessId, price },
            query: {},
        }, response)
        assert.equal(response.statusCode, 400, `expected ${String(price)} to be rejected`)
        assert.equal(response.body.error, MENU_ITEM_PRICE_ERROR)
    }
})

test("Simple Stock rejects empty and invalid prices before inventory work", async () => {
    for (const price of [undefined, null, "", "   ", 0, "0", "0.00", -1, "-1", Number.NaN, Number.POSITIVE_INFINITY, "Infinity", "12abc"]) {
        await assert.rejects(
            createSimpleStockMenuItem({
                businessId: "biz_price_integrity",
                input: createSimpleStockInput(price),
                actor,
                idempotencyKey: `invalid-price:${String(price)}`,
            }),
            (error) => error?.message === MENU_ITEM_PRICE_ERROR && error?.code === "INVALID_SIMPLE_STOCK_INPUT",
        )
    }
})

test("Simple Stock persists a normalized positive price through its canonical create path", async () => {
    const createdItems = []
    const inventoryItem = {
        inventoryItemId: "inv_price_integrity",
        onHandQuantity: 0,
        reservedQuantity: 0,
        lowStockThreshold: 0,
        isActive: true,
    }
    const menuItem = {
        _id: "507f1f77bcf86cd799439011",
        save: async () => menuItem,
    }
    const session = {
        withTransaction: async (work) => work(),
        endSession: async () => {},
    }

    const result = await createSimpleStockMenuItem({
        businessId: "biz_price_integrity",
        input: createSimpleStockInput("6.50"),
        actor,
        idempotencyKey: "valid-price",
    }, {
        InventoryItemModel: {
            findOne: async () => inventoryItem,
        },
        MenuItemModel: {
            findOne: async () => null,
            create: async ([item]) => {
                createdItems.push(item)
                return [menuItem]
            },
        },
        MenuInventoryRecipeModel: {
            create: async () => [],
        },
        createInventoryItemCommand: async () => {},
        enrichMenuItems: async ({ menuItems }) => menuItems,
        invalidateMenu: async () => true,
        startSession: async () => session,
    })

    assert.equal(createdItems[0].price, 6.5)
    assert.equal(result.item, menuItem)
})
