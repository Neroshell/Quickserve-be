import InventoryItem from "../models/InventoryItem.js"
import InventoryMovement from "../models/InventoryMovement.js"
import InventoryReservation from "../models/InventoryReservation.js"
import MenuInventoryRecipe from "../models/MenuInventoryRecipe.js"
import MenuItem from "../models/menuItem.js"
import Order from "../models/order.js"
import { MENU_INVENTORY_MAPPING_STATUSES, MENU_INVENTORY_MODES } from "../constants/menuInventory.js"
import {
    toInventoryItemDTO,
    withCanonicalInventoryTransaction,
} from "./canonicalInventoryService.js"

export class InventoryItemLifecycleError extends Error {
    constructor(message, code, statusCode = 400, details = null) {
        super(message)
        this.name = "InventoryItemLifecycleError"
        this.code = code
        this.statusCode = statusCode
        this.details = details
    }
}

function requiredIdentity(value, field, maxLength = 200) {
    const normalized = String(value ?? "").trim()
    if (!normalized || normalized.length > maxLength) {
        throw new InventoryItemLifecycleError(
            `${field} is required`,
            "INVALID_INVENTORY_LIFECYCLE_INPUT",
        )
    }
    return normalized
}

function normalizeActor(actor) {
    return {
        staffId: requiredIdentity(actor?.staffId, "actor.staffId"),
        role: requiredIdentity(actor?.role, "actor.role", 80),
        name: requiredIdentity(actor?.name, "actor.name", 160),
    }
}

async function modelExists(Model, filter, session) {
    return Boolean(await Model.exists(filter, session ? { session } : undefined))
}

export async function readInventoryItemDependencies({
    businessId,
    inventoryItemId,
    session = null,
}, {
    InventoryItemModel = InventoryItem,
    InventoryMovementModel = InventoryMovement,
    MenuInventoryRecipeModel = MenuInventoryRecipe,
    InventoryReservationModel = InventoryReservation,
    OrderModel = Order,
} = {}) {
    const tenantId = requiredIdentity(businessId, "businessId")
    const itemId = requiredIdentity(inventoryItemId, "inventoryItemId", 100)
    const item = await InventoryItemModel.findOne(
        { businessId: tenantId, inventoryItemId: itemId },
        null,
        session ? { session } : undefined,
    )
    if (!item) {
        throw new InventoryItemLifecycleError(
            "Inventory item not found",
            "INVENTORY_ITEM_NOT_FOUND",
            404,
        )
    }

    // Keep transaction-session operations sequential; parallel operations on a
    // single Mongoose transaction are not supported.
    const movementHistory = await modelExists(InventoryMovementModel, {
        businessId: tenantId,
        inventoryItemId: itemId,
    }, session)
    const mappingHistory = await modelExists(MenuInventoryRecipeModel, {
        businessId: tenantId,
        $or: [
            { "components.inventoryItemId": itemId },
            { "ingredientComponents.inventoryItemId": itemId },
        ],
    }, session)
    const reservationHistory = await modelExists(InventoryReservationModel, {
        businessId: tenantId,
        $or: [
            { "components.inventoryItemId": itemId },
            { "lineAllocations.inventoryItemId": itemId },
            { "sidecarAllocations.inventoryItemId": itemId },
        ],
    }, session)
    const orderHistory = await modelExists(OrderModel, {
        businessId: tenantId,
        "inventoryDeductionLines.inventoryItemId": itemId,
    }, session)
    const hasBalance = item.onHandQuantity !== 0 || item.reservedQuantity !== 0

    return {
        item,
        hasMeaningfulHistory: hasBalance || movementHistory || mappingHistory ||
            reservationHistory || orderHistory,
        dependencies: {
            hasBalance,
            movementHistory,
            mappingHistory,
            reservationHistory,
            orderHistory,
        },
    }
}

async function removeWithinSession({
    businessId,
    inventoryItemId,
    actor,
    session,
    now,
}, dependencies) {
    const {
        InventoryItemModel = InventoryItem,
        MenuInventoryRecipeModel = MenuInventoryRecipe,
        MenuItemModel = MenuItem,
    } = dependencies
    const state = await readInventoryItemDependencies({
        businessId,
        inventoryItemId,
        session,
    }, dependencies)
    if (state.item.deletedAt) {
        return {
            removed: true,
            alreadyRemoved: true,
            inventoryItemId,
            preservation: "historical",
            item: toInventoryItemDTO(state.item),
        }
    }

    if (!state.hasMeaningfulHistory) {
        const result = await InventoryItemModel.deleteOne(
            { businessId, inventoryItemId, deletedAt: null },
            { session },
        )
        if (result.deletedCount !== 1) {
            throw new InventoryItemLifecycleError(
                "Inventory item changed before it could be removed",
                "INVENTORY_ITEM_DELETE_CONFLICT",
                409,
            )
        }
        return {
            removed: true,
            alreadyRemoved: false,
            inventoryItemId,
            preservation: "hard",
            item: null,
        }
    }

    const deletedAt = now()
    state.item.isActive = false
    state.item.deletedAt = deletedAt
    state.item.deletedBy = actor
    await state.item.save({ session })

    const activeSimpleMappings = await MenuInventoryRecipeModel.find({
        businessId,
        mode: MENU_INVENTORY_MODES.SIMPLE,
        status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
        "components.inventoryItemId": inventoryItemId,
    }, null, { session })
    const linkedMenuItemIds = activeSimpleMappings.map((mapping) => mapping.menuItemId)
    if (linkedMenuItemIds.length > 0) {
        await MenuItemModel.updateMany(
            { businessId, _id: { $in: linkedMenuItemIds }, archivedAt: null },
            { $set: { isAvailable: false } },
            { session },
        )
    }

    return {
        removed: true,
        alreadyRemoved: false,
        inventoryItemId,
        preservation: "historical",
        item: toInventoryItemDTO(state.item),
    }
}

export async function removeInventoryItemFromWorkspace({
    businessId,
    inventoryItemId,
    actor,
    session = null,
}, {
    startSession,
    now = () => new Date(),
    ...dependencies
} = {}) {
    const tenantId = requiredIdentity(businessId, "businessId")
    const itemId = requiredIdentity(inventoryItemId, "inventoryItemId", 100)
    const performedBy = normalizeActor(actor)
    const work = (transactionSession) => removeWithinSession({
        businessId: tenantId,
        inventoryItemId: itemId,
        actor: performedBy,
        session: transactionSession,
        now,
    }, dependencies)

    if (session) return work(session)
    return withCanonicalInventoryTransaction(work, startSession ? { startSession } : undefined)
}
