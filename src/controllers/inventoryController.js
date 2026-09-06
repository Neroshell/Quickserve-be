import {
    adjustInventory,
    createInventoryItem,
    InventoryDomainError,
    receiveInventory,
    recordInventoryWaste,
    updateInventoryItem,
} from "../services/canonicalInventoryService.js"
import {
    OwnerInventoryReadError,
    readInventoryItem,
    readInventoryItemsPage,
    readInventoryMovementsPage,
    readInventoryOverview,
} from "../services/ownerInventoryReadService.js"
import { migrateLegacyMenuItemToSimpleStock } from "../services/simpleStockMigrationService.js"
import {
    readIngredientRecipe,
    readIngredientRecipesPage,
    upsertIngredientRecipe,
} from "../services/menuInventoryRecipeService.js"
import {
    adjustSimpleStockMenuItem,
    createSimpleStockMenuItem,
    executeInventoryMovementWithSimpleStockProjection,
    executeInventoryMetadataUpdateWithSimpleStockProjection,
    readSimpleStockDrift,
    reconcileSimpleStockProjection,
    rollbackSimpleStockToLegacy,
    setSimpleStockEnabled,
    updateSimpleStockThreshold,
} from "../services/simpleStockMenuService.js"

function getOwnerBusinessId(req) {
    return req.session?.user?.businessId || null
}

function getInventoryActor(req) {
    const sessionUser = req.session?.user || {}
    const currentStaff = req.resolvedManagerStaff || req.resolvedCoOwnerStaff || null
    return {
        staffId: String(
            currentStaff?.staffId ||
            sessionUser.staffId ||
            sessionUser.id ||
            sessionUser._id ||
            sessionUser.email ||
            `${sessionUser.role || "management"}:${sessionUser.businessId || "unknown"}`,
        ),
        role: String(currentStaff?.role || sessionUser.role || "management"),
        name: String(
            currentStaff?.name ||
            sessionUser.name ||
            sessionUser.email ||
            sessionUser.role ||
            "Management user",
        ),
    }
}

function getIdempotencyKey(req) {
    return req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"] || null
}

function handleInventoryError(res, error, operation) {
    if (
        error instanceof InventoryDomainError ||
        error instanceof OwnerInventoryReadError ||
        Number.isInteger(error?.statusCode)
    ) {
        return res.status(error.statusCode || 400).json({
            error: error.message,
            code: error.code || "INVENTORY_ERROR",
        })
    }
    if (error?.name === "ValidationError") {
        return res.status(400).json({
            error: "Inventory validation failed",
            code: "INVENTORY_VALIDATION_FAILED",
        })
    }
    if (error?.name === "VersionError") {
        return res.status(409).json({
            error: "Inventory item changed concurrently; retry the request",
            code: "INVENTORY_CONCURRENT_UPDATE",
        })
    }
    if (error?.code === 11000) {
        return res.status(409).json({
            error: "Inventory record already exists",
            code: "INVENTORY_DUPLICATE_RECORD",
        })
    }

    console.error(`[inventoryController:${operation}]`, error)
    return res.status(500).json({
        error: "Inventory operation failed",
        code: "INVENTORY_INTERNAL_ERROR",
    })
}

function requireTenant(req, res) {
    const businessId = getOwnerBusinessId(req)
    if (!businessId) {
        res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" })
        return null
    }
    return businessId
}

export async function getInventoryOverview(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        return res.json(await readInventoryOverview({ businessId }))
    } catch (error) {
        return handleInventoryError(res, error, "overview")
    }
}

export async function listInventoryItems(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        return res.json(await readInventoryItemsPage({
            businessId,
            active: req.query.active,
            category: req.query.category,
            search: req.query.search,
            stockStatus: req.query.stockStatus,
            cursor: req.query.cursor,
            limit: req.query.limit,
        }))
    } catch (error) {
        return handleInventoryError(res, error, "list-items")
    }
}

export async function getInventoryItem(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        return res.json(await readInventoryItem({
            businessId,
            inventoryItemId: req.params.inventoryItemId,
        }))
    } catch (error) {
        return handleInventoryError(res, error, "get-item")
    }
}

export async function createOwnerInventoryItem(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        const item = await createInventoryItem({ businessId, input: req.body })
        return res.status(201).json({ item })
    } catch (error) {
        return handleInventoryError(res, error, "create-item")
    }
}

export async function updateOwnerInventoryItem(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        const item = await executeInventoryMetadataUpdateWithSimpleStockProjection({
            businessId,
            inventoryItemId: req.params.inventoryItemId,
            input: req.body,
            command: updateInventoryItem,
        })
        return res.json({ item })
    } catch (error) {
        return handleInventoryError(res, error, "update-item")
    }
}

async function runMovementCommand(req, res, command, operation) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        const result = await executeInventoryMovementWithSimpleStockProjection({
            businessId,
            inventoryItemId: req.params.inventoryItemId,
            input: req.body,
            actor: getInventoryActor(req),
            idempotencyKey: getIdempotencyKey(req),
            command,
        })
        return res.status(result.replayed ? 200 : 201).json(result)
    } catch (error) {
        return handleInventoryError(res, error, operation)
    }
}

export function receiveOwnerInventory(req, res) {
    return runMovementCommand(req, res, receiveInventory, "receive")
}

export function wasteOwnerInventory(req, res) {
    return runMovementCommand(req, res, recordInventoryWaste, "waste")
}

export function adjustOwnerInventory(req, res) {
    return runMovementCommand(req, res, adjustInventory, "adjust")
}

export async function listInventoryMovements(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        return res.json(await readInventoryMovementsPage({
            businessId,
            inventoryItemId: req.query.inventoryItemId,
            type: req.query.type,
            from: req.query.from,
            to: req.query.to,
            cursor: req.query.cursor,
            limit: req.query.limit,
        }))
    } catch (error) {
        return handleInventoryError(res, error, "list-movements")
    }
}

export async function listOwnerInventoryRecipes(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        return res.json(await readIngredientRecipesPage({
            businessId,
            status: req.query.status,
            inventoryItemId: req.query.inventoryItemId,
            cursor: req.query.cursor,
            limit: req.query.limit,
        }))
    } catch (error) {
        return handleInventoryError(res, error, "list-recipes")
    }
}

export async function getOwnerInventoryRecipe(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        return res.json({
            recipe: await readIngredientRecipe({
                businessId,
                menuItemId: req.params.menuItemId,
            }),
        })
    } catch (error) {
        return handleInventoryError(res, error, "get-recipe")
    }
}

export async function putOwnerInventoryRecipe(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        const result = await upsertIngredientRecipe({
            businessId,
            menuItemId: req.params.menuItemId,
            components: req.body?.components,
            enabled: req.body?.enabled,
            replaceSimpleStock: req.body?.replaceSimpleStock,
            replaceLegacyStock: req.body?.replaceLegacyStock,
        })
        return res.status(result.replayed ? 200 : 201).json(result)
    } catch (error) {
        return handleInventoryError(res, error, "put-recipe")
    }
}

export async function createOwnerSimpleStockMenuItem(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        const result = await createSimpleStockMenuItem({
            businessId,
            input: req.body,
            actor: getInventoryActor(req),
            idempotencyKey: getIdempotencyKey(req),
        })
        return res.status(result.replayed ? 200 : 201).json(result)
    } catch (error) {
        return handleInventoryError(res, error, "create-simple-stock-menu-item")
    }
}

export async function adjustOwnerSimpleStockMenuItem(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        const result = await adjustSimpleStockMenuItem({
            businessId,
            menuItemId: req.params.menuItemId,
            input: req.body,
            actor: getInventoryActor(req),
            idempotencyKey: getIdempotencyKey(req),
        })
        return res.status(result.replayed ? 200 : 201).json(result)
    } catch (error) {
        return handleInventoryError(res, error, "adjust-simple-stock-menu-item")
    }
}

export async function updateOwnerSimpleStockSettings(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        const hasEnabled = req.body?.enabled !== undefined
        const hasThreshold = req.body?.lowStockThreshold !== undefined
        if (hasEnabled === hasThreshold) {
            const error = new Error("Provide exactly one of enabled or lowStockThreshold")
            error.statusCode = 400
            error.code = "INVALID_SIMPLE_STOCK_SETTINGS"
            throw error
        }
        const item = hasEnabled
            ? await setSimpleStockEnabled({
                businessId,
                menuItemId: req.params.menuItemId,
                enabled: req.body.enabled,
                actor: getInventoryActor(req),
            })
            : await updateSimpleStockThreshold({
                businessId,
                menuItemId: req.params.menuItemId,
                lowStockThreshold: req.body.lowStockThreshold,
            })
        return res.json({ item })
    } catch (error) {
        return handleInventoryError(res, error, "update-simple-stock-settings")
    }
}

export async function migrateOwnerMenuItemToSimpleStock(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        const result = await migrateLegacyMenuItemToSimpleStock({
            businessId,
            menuItemId: req.params.menuItemId,
            actor: getInventoryActor(req),
        })
        return res.status(result.replayed ? 200 : 201).json(result)
    } catch (error) {
        return handleInventoryError(res, error, "migrate-simple-stock")
    }
}

export async function getOwnerSimpleStockDrift(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        return res.json(await readSimpleStockDrift({ businessId }))
    } catch (error) {
        return handleInventoryError(res, error, "read-simple-stock-drift")
    }
}

export async function reconcileOwnerSimpleStock(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        return res.json(await reconcileSimpleStockProjection({
            businessId,
            menuItemId: req.body?.menuItemId || null,
        }))
    } catch (error) {
        return handleInventoryError(res, error, "reconcile-simple-stock")
    }
}

export async function rollbackOwnerSimpleStock(req, res) {
    const businessId = requireTenant(req, res)
    if (!businessId) return
    try {
        const item = await rollbackSimpleStockToLegacy({
            businessId,
            menuItemId: req.params.menuItemId,
        })
        return res.json({ item })
    } catch (error) {
        return handleInventoryError(res, error, "rollback-simple-stock")
    }
}
