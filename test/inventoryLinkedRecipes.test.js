import assert from "node:assert/strict"
import test from "node:test"

import { readIngredientRecipesPage } from "../src/services/menuInventoryRecipeService.js"

const ids = Object.freeze({
    burger: "507f1f77bcf86cd799439001",
    indomie: "507f1f77bcf86cd799439002",
    jollof: "507f1f77bcf86cd799439003",
    pausedBurger: "507f1f77bcf86cd799439004",
    disabledSidecar: "507f1f77bcf86cd799439005",
    removedSidecar: "507f1f77bcf86cd799439006",
    archivedRecipe: "507f1f77bcf86cd799439007",
    otherTenant: "507f1f77bcf86cd799439008",
    simpleDisabledIngredientsActive: "507f1f77bcf86cd799439009",
})

function component(inventoryItemId, quantity = 1, unit = "piece") {
    return { inventoryItemId, quantity, unit, canonicalQuantity: quantity }
}

const mappings = [
    {
        _id: "607f1f77bcf86cd799439101",
        menuInventoryRecipeId: "mir_burger",
        businessId: "biz_alpha",
        menuItemId: ids.burger,
        mode: "recipe",
        status: "active",
        version: 1,
        components: [component("inv_beef"), component("inv_bun"), component("inv_cheese")],
    },
    {
        _id: "607f1f77bcf86cd799439102",
        menuInventoryRecipeId: "mir_indomie",
        businessId: "biz_alpha",
        menuItemId: ids.indomie,
        mode: "simple",
        status: "active",
        version: 1,
        components: [component("inv_indomie_portion", 1, "portion")],
        ingredientComponents: [component("inv_tomatoes"), component("inv_oil", 10, "ml")],
        ingredientTrackingStatus: "active",
    },
    {
        _id: "607f1f77bcf86cd799439103",
        menuInventoryRecipeId: "mir_jollof",
        businessId: "biz_alpha",
        menuItemId: ids.jollof,
        mode: "recipe",
        status: "active",
        version: 1,
        components: [component("inv_tomatoes"), component("inv_rice", 100, "g")],
    },
    {
        _id: "607f1f77bcf86cd799439104",
        menuInventoryRecipeId: "mir_paused_burger",
        businessId: "biz_alpha",
        menuItemId: ids.pausedBurger,
        mode: "recipe",
        status: "disabled",
        version: 1,
        components: [component("inv_beef")],
    },
    {
        _id: "607f1f77bcf86cd799439105",
        menuInventoryRecipeId: "mir_disabled_sidecar",
        businessId: "biz_alpha",
        menuItemId: ids.disabledSidecar,
        mode: "simple",
        status: "active",
        version: 1,
        components: [component("inv_disabled_portion", 1, "portion")],
        ingredientComponents: [component("inv_tomatoes")],
        ingredientTrackingStatus: "disabled",
    },
    {
        _id: "607f1f77bcf86cd799439106",
        menuInventoryRecipeId: "mir_removed_sidecar",
        businessId: "biz_alpha",
        menuItemId: ids.removedSidecar,
        mode: "simple",
        status: "active",
        version: 1,
        components: [component("inv_removed_portion", 1, "portion")],
        ingredientComponents: [],
        ingredientTrackingStatus: null,
    },
    {
        _id: "607f1f77bcf86cd799439107",
        menuInventoryRecipeId: "mir_archived",
        businessId: "biz_alpha",
        menuItemId: ids.archivedRecipe,
        mode: "recipe",
        status: "archived",
        version: 1,
        components: [component("inv_tomatoes")],
    },
    {
        _id: "607f1f77bcf86cd799439108",
        menuInventoryRecipeId: "mir_other_tenant",
        businessId: "biz_beta",
        menuItemId: ids.otherTenant,
        mode: "recipe",
        status: "active",
        version: 1,
        components: [component("inv_tomatoes")],
    },
    {
        _id: "607f1f77bcf86cd799439109",
        menuInventoryRecipeId: "mir_simple_disabled_ingredients_active",
        businessId: "biz_alpha",
        menuItemId: ids.simpleDisabledIngredientsActive,
        mode: "simple",
        status: "disabled",
        version: 1,
        components: [component("inv_soup_portion", 1, "portion")],
        ingredientComponents: [component("inv_onion")],
        ingredientTrackingStatus: "active",
    },
]

const menuItems = [
    [ids.burger, "Burger", "biz_alpha"],
    [ids.indomie, "Indomie", "biz_alpha"],
    [ids.jollof, "Jollof Rice", "biz_alpha"],
    [ids.pausedBurger, "Paused Burger", "biz_alpha"],
    [ids.disabledSidecar, "Disabled Sidecar", "biz_alpha"],
    [ids.removedSidecar, "Removed Sidecar", "biz_alpha"],
    [ids.archivedRecipe, "Archived Recipe", "biz_alpha"],
    [ids.otherTenant, "Other Tenant Recipe", "biz_beta"],
    [ids.simpleDisabledIngredientsActive, "Soup", "biz_alpha"],
].map(([id, name, businessId]) => ({
    _id: id,
    businessId,
    name,
    category: "Mains",
    type: "food",
    price: 10,
    isAvailable: true,
    archivedAt: null,
}))

const inventoryItemIds = [
    "inv_beef",
    "inv_bun",
    "inv_cheese",
    "inv_indomie_portion",
    "inv_tomatoes",
    "inv_oil",
    "inv_rice",
    "inv_disabled_portion",
    "inv_removed_portion",
    "inv_soup_portion",
    "inv_onion",
]
const inventoryItems = ["biz_alpha", "biz_beta"].flatMap((businessId) => (
    inventoryItemIds.map((inventoryItemId) => ({
        businessId,
        inventoryItemId,
        name: inventoryItemId.replace("inv_", "").replaceAll("_", " "),
        trackingUnit: inventoryItemId.endsWith("portion") ? "portion" : "piece",
        onHandQuantity: 20,
        reservedQuantity: 0,
        isActive: true,
    }))
))

function pathValues(value, segments) {
    if (segments.length === 0) return [value]
    if (Array.isArray(value)) {
        const [segment, ...rest] = segments
        if (/^\d+$/.test(segment)) {
            const index = Number(segment)
            return index in value ? pathValues(value[index], rest) : []
        }
        return value.flatMap((entry) => pathValues(entry, segments))
    }
    if (!value || typeof value !== "object") return []
    const [segment, ...rest] = segments
    return Object.hasOwn(value, segment) ? pathValues(value[segment], rest) : []
}

function matchesField(values, condition) {
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
        if ("$exists" in condition && (values.length > 0) !== condition.$exists) return false
        if ("$in" in condition && !values.some((value) => condition.$in.includes(value))) return false
        if ("$ne" in condition && values.some((value) => value === condition.$ne)) return false
        if ("$gt" in condition && !values.some((value) => String(value) > String(condition.$gt))) {
            return false
        }
        return true
    }
    return values.some((value) => value === condition)
}

function matchesFilter(document, filter) {
    return Object.entries(filter).every(([key, condition]) => {
        if (key === "$or") return condition.some((branch) => matchesFilter(document, branch))
        return matchesField(pathValues(document, key.split(".")), condition)
    })
}

function query(rows) {
    let result = [...rows]
    return {
        sort(specification) {
            const [[field, direction]] = Object.entries(specification)
            result.sort((left, right) => (
                String(left[field]).localeCompare(String(right[field])) * direction
            ))
            return this
        },
        limit(value) {
            result = result.slice(0, value)
            return this
        },
        async lean() {
            return result
        },
    }
}

const dependencies = {
    MenuInventoryRecipeModel: {
        find(filter) {
            return query(mappings.filter((mapping) => matchesFilter(mapping, filter)))
        },
    },
    MenuItemModel: {
        find(filter) {
            return {
                lean: async () => menuItems.filter((menuItem) => (
                    menuItem.businessId === filter.businessId &&
                    filter._id.$in.some((id) => String(id) === String(menuItem._id)) &&
                    menuItem.archivedAt === null
                )),
            }
        },
    },
    InventoryItemModel: {
        find(filter) {
            return {
                lean: async () => inventoryItems.filter((inventoryItem) => (
                    inventoryItem.businessId === filter.businessId &&
                    filter.inventoryItemId.$in.includes(inventoryItem.inventoryItemId)
                )),
            }
        },
    },
}

async function linkedRecipes(inventoryItemId, options = {}) {
    return readIngredientRecipesPage({
        businessId: options.businessId || "biz_alpha",
        inventoryItemId,
        status: options.status,
        limit: 25,
    }, dependencies)
}

function names(result) {
    return result.recipes.map((recipe) => recipe.menuItem?.name)
}

test("current linked recipes include active recipe-only component usage", async () => {
    const result = await linkedRecipes("inv_beef")

    assert.deepEqual(names(result), ["Burger"])
    assert.deepEqual(result.recipes[0].components.map((entry) => entry.inventoryItemId), [
        "inv_beef",
        "inv_bun",
        "inv_cheese",
    ])
})

test("current linked recipes use active coexistence ingredientComponents", async () => {
    const tomatoes = await linkedRecipes("inv_tomatoes")
    const oil = await linkedRecipes("inv_oil")

    assert.deepEqual(names(tomatoes), ["Indomie", "Jollof Rice"])
    assert.deepEqual(names(oil), ["Indomie"])
    assert.equal(tomatoes.recipes[0].mode, "simple")
    assert.equal(tomatoes.recipes[0].simpleStock.inventoryItemId, "inv_indomie_portion")
})

test("a coexistence sellable Simple Stock item is not its own recipe ingredient", async () => {
    const result = await linkedRecipes("inv_indomie_portion")

    assert.deepEqual(result.recipes, [])
})

test("disabled, removed, and archived ingredient tracking is not current usage", async () => {
    const tomatoes = await linkedRecipes("inv_tomatoes")
    const beef = await linkedRecipes("inv_beef")

    assert.deepEqual(names(tomatoes), ["Indomie", "Jollof Rice"])
    assert.deepEqual(names(beef), ["Burger"])

    const disabledTomatoes = await linkedRecipes("inv_tomatoes", { status: "disabled" })
    const disabledBeef = await linkedRecipes("inv_beef", { status: "disabled" })
    assert.deepEqual(names(disabledTomatoes), ["Disabled Sidecar"])
    assert.deepEqual(names(disabledBeef), ["Paused Burger"])
})

test("ingredient tracking remains independent from disabled Simple Stock", async () => {
    const result = await linkedRecipes("inv_onion")

    assert.deepEqual(names(result), ["Soup"])
    assert.equal(result.recipes[0].status, "active")
    assert.equal(result.recipes[0].simpleStock.status, "disabled")
})

test("linked recipe reads never cross the authenticated tenant boundary", async () => {
    const alpha = await linkedRecipes("inv_tomatoes")
    const beta = await linkedRecipes("inv_tomatoes", { businessId: "biz_beta" })

    assert.deepEqual(names(alpha), ["Indomie", "Jollof Rice"])
    assert.deepEqual(names(beta), ["Other Tenant Recipe"])
})

test("unfiltered recipe workspace reads retain active and disabled configuration", async () => {
    const result = await readIngredientRecipesPage({
        businessId: "biz_alpha",
        limit: 25,
    }, dependencies)

    assert.deepEqual(names(result), [
        "Burger",
        "Indomie",
        "Jollof Rice",
        "Paused Burger",
        "Disabled Sidecar",
        "Soup",
    ])
})
