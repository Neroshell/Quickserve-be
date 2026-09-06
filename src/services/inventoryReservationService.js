import crypto from "node:crypto"
import mongoose from "mongoose"

import { INVENTORY_MOVEMENT_TYPES, MAX_INVENTORY_QUANTITY } from "../constants/inventory.js"
import {
    INVENTORY_LINE_ALLOCATION_STATUSES,
    INVENTORY_RESERVATION_PROVIDER_STATES,
    INVENTORY_RESERVATION_RELEASE_EVIDENCE,
    INVENTORY_RESERVATION_SOURCE_TYPES,
    INVENTORY_RESERVATION_STATUSES,
} from "../constants/inventoryReservation.js"
import {
    FULFILLMENT_ACTIONS,
    FULFILLMENT_BEHAVIORS,
    FULFILLMENT_STATIONS,
} from "../constants/orderFulfillment.js"
import {
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_MODES,
} from "../constants/menuInventory.js"
import {
    ORDER_INVENTORY_AUTHORITIES,
    ORDER_INVENTORY_SEMANTICS,
} from "../constants/orderInventory.js"
import InventoryItem from "../models/InventoryItem.js"
import InventoryMovement from "../models/InventoryMovement.js"
import InventoryPaymentException from "../models/InventoryPaymentException.js"
import InventoryReservation, {
    generateInventoryReservationId,
} from "../models/InventoryReservation.js"
import MenuInventoryRecipe from "../models/MenuInventoryRecipe.js"
import MenuItem from "../models/menuItem.js"
import Order from "../models/order.js"
import { withCanonicalInventoryTransaction } from "./canonicalInventoryService.js"
import { assertSimpleStockRuntimeEnabled } from "./inventoryRuntimePolicy.js"
import {
    applyCanonicalSimpleStockProjection,
    resolveManualMenuAvailability,
} from "./menuInventoryAvailabilityService.js"
import { normalizeInventoryQuantity } from "./inventoryUomService.js"
import { buildOrderInventoryDeductionLine } from "./orderInventorySemanticsService.js"

const SYSTEM_INVENTORY_ACTOR = Object.freeze({
    staffId: "system:order-inventory",
    role: "system",
    name: "Order inventory",
})

const STRIPE_RELEASE_EVIDENCE = new Set([
    INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_CREATION_FAILED,
    INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_EXPIRED_EVENT,
    INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_VERIFIED_EXPIRED,
])

export class InventoryReservationError extends Error {
    constructor(message, {
        code = "INVENTORY_RESERVATION_ERROR",
        statusCode = 409,
        failures = [],
    } = {}) {
        super(message)
        this.name = "InventoryReservationError"
        this.code = code
        this.statusCode = statusCode
        this.failures = failures
    }
}

function reservationError(message, code, statusCode = 409, failures = []) {
    return new InventoryReservationError(message, { code, statusCode, failures })
}

function requiredText(value, field, maxLength = 200) {
    const normalized = String(value ?? "").trim()
    if (!normalized || normalized.length > maxLength) {
        throw reservationError(`${field} is required`, "INVALID_INVENTORY_RESERVATION_INPUT", 400)
    }
    return normalized
}

function positiveQuantity(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_INVENTORY_QUANTITY
}

function plain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : value
}

function optionsForSession(session) {
    return session ? { session } : undefined
}

function normalizeActor(actor) {
    if (!actor) return SYSTEM_INVENTORY_ACTOR
    return {
        staffId: requiredText(actor.staffId, "actor.staffId"),
        role: requiredText(actor.role, "actor.role", 80),
        name: requiredText(actor.name, "actor.name", 160),
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue)
    if (value && typeof value === "object" && !(value instanceof Date)) {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
        )
    }
    return value instanceof Date ? value.toISOString() : value
}

export function buildInventoryRequestFingerprint(value) {
    return crypto.createHash("sha256")
        .update(JSON.stringify(stableValue(value)))
        .digest("hex")
}

function movementIdentity({ businessId, reservationId, inventoryItemId, action }) {
    const digest = buildInventoryRequestFingerprint({
        businessId,
        reservationId,
        inventoryItemId,
        action,
    })
    return {
        movementId: `imv_rsv_${digest.slice(0, 24)}`,
        idempotencyKey: `inventory-reservation:${action}:${digest}`,
    }
}

function allocationIdentity({ businessId, reservationId, orderLineId, inventoryItemId }) {
    const digest = buildInventoryRequestFingerprint({
        businessId,
        reservationId,
        orderLineId,
        inventoryItemId,
    })
    return `ial_${digest.slice(0, 24)}`
}

function menuItemRequestKey(item) {
    if (item?.menuItemId && mongoose.isValidObjectId(item.menuItemId)) {
        return `id:${String(item.menuItemId)}`
    }
    return `name:${String(item?.itemName ?? "").trim()}`
}

async function resolveRequestedMenuItems({ businessId, items, session, MenuItemModel }) {
    if (!Array.isArray(items) || items.length === 0) {
        throw reservationError(
            "Order items are required",
            "INVALID_INVENTORY_RESERVATION_INPUT",
            400,
        )
    }
    for (const item of items) {
        if (!positiveQuantity(item?.quantity)) {
            throw reservationError("Order item quantity is invalid", "INVALID_ORDER_ITEM_QUANTITY", 400)
        }
    }

    const ids = [...new Set(items
        .map((item) => item?.menuItemId)
        .filter((value) => value && mongoose.isValidObjectId(value))
        .map(String))]
    const names = [...new Set(items
        .filter((item) => !item?.menuItemId || !mongoose.isValidObjectId(item.menuItemId))
        .map((item) => String(item?.itemName ?? "").trim())
        .filter(Boolean))]
    const clauses = []
    if (ids.length > 0) clauses.push({ _id: { $in: ids } })
    if (names.length > 0) clauses.push({ name: { $in: names } })
    const documents = clauses.length > 0
        ? await MenuItemModel.find(
            { businessId, archivedAt: null, $or: clauses },
            null,
            optionsForSession(session),
        )
        : []
    const byId = new Map(documents.map((item) => [String(item._id), item]))
    const byName = new Map()
    for (const item of documents) {
        if (!byName.has(item.name)) byName.set(item.name, item)
    }

    const aggregated = new Map()
    for (const requested of items) {
        const menuItem = requested.menuItemId && mongoose.isValidObjectId(requested.menuItemId)
            ? byId.get(String(requested.menuItemId))
            : byName.get(String(requested.itemName ?? "").trim())
        const key = menuItem ? String(menuItem._id) : menuItemRequestKey(requested)
        const entry = aggregated.get(key) || {
            menuItem: menuItem || null,
            requested,
            quantity: 0,
            lines: [],
        }
        entry.quantity += requested.quantity
        if (!positiveQuantity(entry.quantity)) {
            throw reservationError("Aggregated order quantity is invalid", "INVALID_ORDER_ITEM_QUANTITY", 400)
        }
        entry.lines.push({ requested, quantity: requested.quantity })
        aggregated.set(key, entry)
    }
    return [...aggregated.values()]
}

function addFailure(failures, entry, reason, available = 0) {
    failures.push({
        menuItemId: entry.menuItem?._id || entry.requested?.menuItemId || null,
        itemName: entry.menuItem?.name || entry.requested?.itemName || "Unknown item",
        requested: entry.quantity,
        available: Number.isSafeInteger(available) ? Math.max(0, available) : 0,
        reason,
    })
}

function validInventoryBalance(item) {
    return Number.isSafeInteger(item?.onHandQuantity) &&
        Number.isSafeInteger(item?.reservedQuantity) &&
        item.onHandQuantity >= 0 &&
        item.reservedQuantity >= 0 &&
        item.reservedQuantity <= item.onHandQuantity
}

/**
 * The one backend-authoritative MenuItem -> inventory requirement resolver.
 * It deliberately reloads MenuItem, mapping, and InventoryItem documents in
 * the caller's transaction and aggregates shared ingredients before checking
 * any balance.
 */
export async function resolveInventoryRequirements({
    businessId,
    items,
    session = null,
    env = process.env,
}, {
    MenuItemModel = MenuItem,
    MenuInventoryRecipeModel = MenuInventoryRecipe,
    InventoryItemModel = InventoryItem,
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const requested = await resolveRequestedMenuItems({
        businessId: tenantId,
        items,
        session,
        MenuItemModel,
    })
    const menuItemIds = requested.map((entry) => entry.menuItem?._id).filter(Boolean)
    const mappings = menuItemIds.length > 0
        ? await MenuInventoryRecipeModel.find({
            businessId: tenantId,
            menuItemId: { $in: menuItemIds },
            status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
        }, null, optionsForSession(session))
        : []
    const mappingByMenuItem = new Map(mappings.map((mapping) => [
        String(mapping.menuItemId),
        mapping,
    ]))
    if (mappings.some((mapping) => mapping.mode === MENU_INVENTORY_MODES.SIMPLE)) {
        assertSimpleStockRuntimeEnabled({ env })
    }

    const inventoryItemIds = [...new Set(mappings.flatMap((mapping) =>
        (mapping.components || []).map((component) => component.inventoryItemId),
    ).filter(Boolean))].sort()
    const inventoryItems = inventoryItemIds.length > 0
        ? await InventoryItemModel.find({
            businessId: tenantId,
            inventoryItemId: { $in: inventoryItemIds },
        }, null, optionsForSession(session))
        : []
    const inventoryById = new Map(inventoryItems.map((item) => [item.inventoryItemId, item]))
    const requirementByInventoryId = new Map()
    const lineAllocationRequirements = []
    const legacyRequirements = []
    const menuRequirements = []
    const untrackedMenuItemIds = []
    const failures = []

    for (const entry of requested) {
        const menuItem = entry.menuItem
        if (!menuItem) {
            addFailure(failures, entry, "MENU_ITEM_NOT_FOUND")
            continue
        }
        if (!resolveManualMenuAvailability(menuItem)) {
            addFailure(failures, entry, "MANUALLY_UNAVAILABLE")
            continue
        }

        const mapping = mappingByMenuItem.get(String(menuItem._id)) || null
        if (!mapping) {
            if (menuItem.trackStock !== true) {
                untrackedMenuItemIds.push(String(menuItem._id))
                continue
            }
            if (!Number.isSafeInteger(menuItem.stockQuantity) || menuItem.stockQuantity < 0) {
                addFailure(failures, entry, "INVALID_LEGACY_STOCK")
                continue
            }
            if (menuItem.stockQuantity < entry.quantity) {
                addFailure(failures, entry, "INSUFFICIENT_LEGACY_STOCK", menuItem.stockQuantity)
                continue
            }
            legacyRequirements.push({ menuItem, quantity: entry.quantity })
            menuRequirements.push({
                menuItemId: menuItem._id,
                orderQuantity: entry.quantity,
                authority: "legacy_menu_item",
                mappingMode: null,
                mappingVersion: null,
            })
            continue
        }

        const components = Array.isArray(mapping.components) ? mapping.components : []
        const validMode = mapping.mode === MENU_INVENTORY_MODES.SIMPLE ||
            mapping.mode === MENU_INVENTORY_MODES.RECIPE
        const validShape = validMode && components.length > 0 &&
            (mapping.mode !== MENU_INVENTORY_MODES.SIMPLE || components.length === 1)
        if (!validShape) {
            addFailure(failures, entry, "INVALID_ACTIVE_INVENTORY_MAPPING")
            continue
        }

        let mappingValid = true
        const normalizedComponents = []
        for (const component of components) {
            const inventoryItem = inventoryById.get(component.inventoryItemId)
            if (!inventoryItem || inventoryItem.isActive === false || !validInventoryBalance(inventoryItem)) {
                addFailure(
                    failures,
                    entry,
                    !inventoryItem
                        ? "MISSING_CANONICAL_INVENTORY_ITEM"
                        : inventoryItem.isActive === false
                            ? "INACTIVE_CANONICAL_INVENTORY_ITEM"
                            : "INVALID_CANONICAL_INVENTORY_BALANCE",
                )
                mappingValid = false
                break
            }
            try {
                const normalized = normalizeInventoryQuantity({
                    quantity: component.quantity,
                    unit: component.unit,
                    trackingUnit: inventoryItem.trackingUnit,
                })
                if (normalized.canonicalQuantity !== component.canonicalQuantity) {
                    throw new Error("Stored canonical quantity does not match its unit conversion")
                }
                const total = normalized.canonicalQuantity * entry.quantity
                if (!positiveQuantity(total)) {
                    throw new Error("Aggregated requirement exceeds the safe quantity range")
                }
                normalizedComponents.push({
                    inventoryItem,
                    canonicalQuantity: total,
                    canonicalQuantityPerMenuUnit: normalized.canonicalQuantity,
                })
            } catch {
                addFailure(failures, entry, "INVALID_INVENTORY_COMPONENT")
                mappingValid = false
                break
            }
        }
        if (!mappingValid) continue

        const allocationLines = []
        for (const line of entry.lines || []) {
            const orderLineId = String(line.requested?.orderLineId || "").trim()
            const fulfillmentStation = line.requested?.fulfillmentStation
            const fulfillmentBehavior = line.requested?.fulfillmentBehavior
            const validFulfillment = [
                FULFILLMENT_STATIONS.KITCHEN,
                FULFILLMENT_STATIONS.BAR,
            ].includes(fulfillmentStation) && [
                FULFILLMENT_BEHAVIORS.PREPARED,
                FULFILLMENT_BEHAVIORS.DIRECT,
            ].includes(fulfillmentBehavior) && !(
                fulfillmentStation === FULFILLMENT_STATIONS.KITCHEN &&
                fulfillmentBehavior !== FULFILLMENT_BEHAVIORS.PREPARED
            )
            if (!orderLineId || !validFulfillment) {
                addFailure(failures, entry, "INVALID_FULFILLMENT_ALLOCATION_SNAPSHOT")
                mappingValid = false
                break
            }
            allocationLines.push({
                orderLineId,
                fulfillmentStation,
                fulfillmentBehavior,
                quantity: line.quantity,
            })
        }
        if (!mappingValid) continue

        menuRequirements.push({
            menuItemId: menuItem._id,
            orderQuantity: entry.quantity,
            authority: "canonical",
            mappingMode: mapping.mode,
            mappingVersion: mapping.version,
        })
        for (const component of normalizedComponents) {
            const id = component.inventoryItem.inventoryItemId
            const requirement = requirementByInventoryId.get(id) || {
                inventoryItem: component.inventoryItem,
                inventoryItemId: id,
                canonicalQuantity: 0,
                unit: component.inventoryItem.trackingUnit,
                contributions: [],
            }
            requirement.canonicalQuantity += component.canonicalQuantity
            if (!positiveQuantity(requirement.canonicalQuantity)) {
                addFailure(failures, entry, "INVENTORY_QUANTITY_OVERFLOW")
                mappingValid = false
                break
            }
            requirement.contributions.push({
                entry,
                canonicalQuantityPerMenuUnit: component.canonicalQuantityPerMenuUnit,
            })
            requirementByInventoryId.set(id, requirement)

            for (const line of allocationLines) {
                const canonicalQuantity =
                    component.canonicalQuantityPerMenuUnit * line.quantity
                if (!positiveQuantity(canonicalQuantity)) {
                    addFailure(failures, entry, "INVENTORY_QUANTITY_OVERFLOW")
                    mappingValid = false
                    break
                }
                lineAllocationRequirements.push({
                    orderLineId: line.orderLineId,
                    menuItemId: menuItem._id,
                    fulfillmentStation: line.fulfillmentStation,
                    fulfillmentBehavior: line.fulfillmentBehavior,
                    inventoryItemId: id,
                    canonicalQuantity,
                    unit: component.inventoryItem.trackingUnit,
                })
            }
            if (!mappingValid) break
        }
    }

    const requirements = [...requirementByInventoryId.values()]
        .sort((left, right) => left.inventoryItemId.localeCompare(right.inventoryItemId))
    const failedMenuItems = new Set(failures.map((failure) => String(failure.menuItemId)))
    for (const requirement of requirements) {
        const available = requirement.inventoryItem.onHandQuantity -
            requirement.inventoryItem.reservedQuantity
        if (available >= requirement.canonicalQuantity) continue
        for (const contribution of requirement.contributions) {
            const entry = contribution.entry
            if (failedMenuItems.has(String(entry.menuItem._id))) continue
            addFailure(
                failures,
                entry,
                "INSUFFICIENT_STOCK",
                Math.floor(available / contribution.canonicalQuantityPerMenuUnit),
            )
            failedMenuItems.add(String(entry.menuItem._id))
        }
    }

    return {
        businessId: tenantId,
        requirements,
        lineAllocationRequirements,
        legacyRequirements,
        menuRequirements,
        untrackedMenuItemIds,
        failures,
        tracked: requirements.length > 0 || legacyRequirements.length > 0,
    }
}

export async function validateInventoryRequirements(input, dependencies) {
    const result = await resolveInventoryRequirements(input, dependencies)
    return result.failures
}

async function createReservationMovement({
    businessId,
    reservationId,
    inventoryItem,
    canonicalQuantity,
    action,
    actor,
    session,
    InventoryMovementModel,
}) {
    const reserve = action === "reserve"
    const type = reserve ? INVENTORY_MOVEMENT_TYPES.RESERVE : INVENTORY_MOVEMENT_TYPES.RELEASE
    const onHandBefore = inventoryItem.onHandQuantity
    const reservedBefore = inventoryItem.reservedQuantity
    const reservedAfter = reservedBefore + (reserve ? canonicalQuantity : -canonicalQuantity)
    const { movementId, idempotencyKey } = movementIdentity({
        businessId,
        reservationId,
        inventoryItemId: inventoryItem.inventoryItemId,
        action,
    })
    const requestFingerprint = buildInventoryRequestFingerprint({
        businessId,
        reservationId,
        inventoryItemId: inventoryItem.inventoryItemId,
        type,
        canonicalQuantity,
    })

    inventoryItem.reservedQuantity = reservedAfter
    await inventoryItem.save({ session })
    const [movement] = await InventoryMovementModel.create([{
        movementId,
        businessId,
        inventoryItemId: inventoryItem.inventoryItemId,
        type,
        quantityDeltaOnHand: 0,
        quantityDeltaReserved: reserve ? canonicalQuantity : -canonicalQuantity,
        unit: inventoryItem.trackingUnit,
        canonicalQuantity,
        onHandBefore,
        onHandAfter: onHandBefore,
        reservedBefore,
        reservedAfter,
        sourceType: "inventory_reservation",
        sourceId: reservationId,
        reasonCode: reserve ? "order_commitment" : "pre_fulfilment_release",
        performedBy: actor,
        idempotencyKey,
        requestFingerprint,
    }], { session })
    return movement
}

function inventorySemanticsFor({ canonicalCount, legacyCount }) {
    if (canonicalCount > 0 && legacyCount > 0) {
        return ORDER_INVENTORY_SEMANTICS.MIXED_RESERVATION_V1
    }
    if (canonicalCount > 0) {
        return ORDER_INVENTORY_SEMANTICS.CANONICAL_RESERVATION_V1
    }
    return ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1
}

async function projectSimpleMappings({ resolved, session }) {
    const inventoryById = new Map(resolved.requirements.map((requirement) => [
        requirement.inventoryItemId,
        requirement.inventoryItem,
    ]))
    for (const menuRequirement of resolved.menuRequirements) {
        if (menuRequirement.mappingMode !== MENU_INVENTORY_MODES.SIMPLE) continue
        const mapping = await MenuInventoryRecipe.findOne({
            businessId: resolved.businessId,
            menuItemId: menuRequirement.menuItemId,
            status: MENU_INVENTORY_MAPPING_STATUSES.ACTIVE,
            mode: MENU_INVENTORY_MODES.SIMPLE,
        }, null, { session })
        const inventoryItem = inventoryById.get(mapping?.components?.[0]?.inventoryItemId)
        const menuItem = await MenuItem.findOne({
            _id: menuRequirement.menuItemId,
            businessId: resolved.businessId,
        }, null, { session })
        if (mapping && inventoryItem && menuItem) {
            applyCanonicalSimpleStockProjection({ menuItem, inventoryItem })
            await menuItem.save({ session })
        }
    }
}

/** Reserve all canonical/legacy requirements in the caller's transaction. */
export async function reserveInventoryForSource({
    businessId,
    items,
    sourceType,
    sourceId,
    order = null,
    orderId = null,
    pendingCheckoutId = null,
    status,
    expiresAt = null,
    reservationId = generateInventoryReservationId(),
    idempotencyKey,
    requestFingerprint,
    actor = null,
    session,
    env = process.env,
}, {
    InventoryReservationModel = InventoryReservation,
    InventoryMovementModel = InventoryMovement,
    ...resolverDependencies
} = {}) {
    if (!session) {
        throw reservationError(
            "A Mongo session is required for inventory reservation",
            "INVENTORY_TRANSACTION_REQUIRED",
            500,
        )
    }
    const tenantId = requiredText(businessId, "businessId")
    const key = requiredText(idempotencyKey, "idempotencyKey")
    const fingerprint = requiredText(requestFingerprint, "requestFingerprint", 64)
    const existing = await InventoryReservationModel.findOne(
        { businessId: tenantId, idempotencyKey: key },
        null,
        { session },
    )
    if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
            throw reservationError(
                "Idempotency key was already used with different inventory input",
                "INVENTORY_IDEMPOTENCY_CONFLICT",
            )
        }
        return { reservation: existing, resolved: null, replayed: true, tracked: true }
    }

    const resolved = await resolveInventoryRequirements({
        businessId: tenantId,
        items,
        session,
        env,
    }, resolverDependencies)
    if (resolved.failures.length > 0) {
        throw reservationError(
            "One or more items in your order are no longer available. Please review your cart.",
            "INSUFFICIENT_STOCK",
            409,
            resolved.failures,
        )
    }
    if (!resolved.tracked) {
        return { reservation: null, resolved, replayed: false, tracked: false }
    }

    const finalStatus = status || (
        sourceType === INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT
            ? INVENTORY_RESERVATION_STATUSES.HELD
            : INVENTORY_RESERVATION_STATUSES.COMMITTED
    )
    const performedBy = normalizeActor(actor)
    const canonicalComponents = []
    for (const requirement of resolved.requirements) {
        const available = requirement.inventoryItem.onHandQuantity -
            requirement.inventoryItem.reservedQuantity
        if (available < requirement.canonicalQuantity) {
            throw reservationError(
                "One or more items in your order are no longer available. Please review your cart.",
                "INSUFFICIENT_STOCK",
                409,
            )
        }
        const movement = await createReservationMovement({
            businessId: tenantId,
            reservationId,
            inventoryItem: requirement.inventoryItem,
            canonicalQuantity: requirement.canonicalQuantity,
            action: "reserve",
            actor: performedBy,
            session,
            InventoryMovementModel,
        })
        canonicalComponents.push({
            inventoryItemId: requirement.inventoryItemId,
            canonicalQuantity: requirement.canonicalQuantity,
            unit: requirement.inventoryItem.trackingUnit,
            reserveMovementId: movement.movementId,
            releaseMovementId: null,
        })
    }

    const legacyComponents = []
    for (const requirement of resolved.legacyRequirements) {
        if (requirement.menuItem.stockQuantity < requirement.quantity) {
            throw reservationError(
                "One or more items in your order are no longer available. Please review your cart.",
                "INSUFFICIENT_STOCK",
                409,
            )
        }
        requirement.menuItem.stockQuantity -= requirement.quantity
        if (requirement.menuItem.stockQuantity <= 0) {
            requirement.menuItem.stockQuantity = 0
            requirement.menuItem.isAvailable = false
        }
        await requirement.menuItem.save({ session })
        legacyComponents.push({
            menuItemId: requirement.menuItem._id,
            quantity: requirement.quantity,
        })
    }

    const lineAllocations = (resolved.lineAllocationRequirements || []).map((allocation) => ({
        allocationId: allocationIdentity({
            businessId: tenantId,
            reservationId,
            orderLineId: allocation.orderLineId,
            inventoryItemId: allocation.inventoryItemId,
        }),
        ...allocation,
        status: INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED,
        consumeMovementId: null,
        consumedAt: null,
        releaseMovementId: null,
        releasedAt: null,
    }))

    await projectSimpleMappings({ resolved, session })
    const now = new Date()
    const [reservation] = await InventoryReservationModel.create([{
        reservationId,
        businessId: tenantId,
        sourceType,
        sourceId: requiredText(sourceId, "sourceId"),
        orderId: orderId || order?.orderId || null,
        pendingCheckoutId,
        status: finalStatus,
        components: canonicalComponents,
        lineAllocations,
        legacyComponents,
        menuRequirements: resolved.menuRequirements,
        expiresAt,
        providerState: sourceType === INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT
            ? INVENTORY_RESERVATION_PROVIDER_STATES.PENDING
            : INVENTORY_RESERVATION_PROVIDER_STATES.NOT_APPLICABLE,
        providerCreationStartedAt: sourceType === INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT
            ? now
            : null,
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        committedAt: finalStatus === INVENTORY_RESERVATION_STATUSES.COMMITTED ? now : null,
    }], { session })

    if (order) {
        const legacyLines = resolved.legacyRequirements.map((requirement) =>
            buildOrderInventoryDeductionLine({
                menuItemId: requirement.menuItem._id,
                authority: ORDER_INVENTORY_AUTHORITIES.LEGACY_MENU_ITEM,
                orderQuantity: requirement.quantity,
            }))
        order.inventoryReservationId = reservation.reservationId
        order.inventoryReserved = true
        order.inventoryReservedAt = now
        order.inventorySemanticsVersion = inventorySemanticsFor({
            canonicalCount: canonicalComponents.length,
            legacyCount: legacyComponents.length,
        })
        order.inventoryDeductionLines = legacyLines
        order.inventoryDeducted = legacyComponents.length > 0
        order.inventoryDeductedAt = legacyComponents.length > 0 ? now : null
        await order.save({ session })
    }

    return { reservation, resolved, replayed: false, tracked: true }
}

async function createConsumptionMovement({
    businessId,
    reservation,
    order,
    inventoryItem,
    allocations,
    station,
    action,
    actor,
    session,
    InventoryMovementModel,
}) {
    const canonicalQuantity = allocations.reduce(
        (total, allocation) => total + allocation.canonicalQuantity,
        0,
    )
    const allocationIds = allocations.map((allocation) => allocation.allocationId).sort()
    const orderLineIds = [...new Set(
        allocations.map((allocation) => allocation.orderLineId),
    )].sort()
    const batchKey = buildInventoryRequestFingerprint({
        station,
        action,
        allocationIds,
    }).slice(0, 24)
    const { movementId, idempotencyKey } = movementIdentity({
        businessId,
        reservationId: reservation.reservationId,
        inventoryItemId: inventoryItem.inventoryItemId,
        action: `consume:${batchKey}`,
    })
    const onHandBefore = inventoryItem.onHandQuantity
    const reservedBefore = inventoryItem.reservedQuantity
    const onHandAfter = onHandBefore - canonicalQuantity
    const reservedAfter = reservedBefore - canonicalQuantity
    const requestFingerprint = buildInventoryRequestFingerprint({
        businessId,
        reservationId: reservation.reservationId,
        orderId: order.orderId,
        inventoryItemId: inventoryItem.inventoryItemId,
        type: INVENTORY_MOVEMENT_TYPES.CONSUME,
        canonicalQuantity,
        allocationIds,
        orderLineIds,
        station,
        action,
    })

    inventoryItem.onHandQuantity = onHandAfter
    inventoryItem.reservedQuantity = reservedAfter
    await inventoryItem.save({ session })
    const [movement] = await InventoryMovementModel.create([{
        movementId,
        businessId,
        inventoryItemId: inventoryItem.inventoryItemId,
        type: INVENTORY_MOVEMENT_TYPES.CONSUME,
        quantityDeltaOnHand: -canonicalQuantity,
        quantityDeltaReserved: -canonicalQuantity,
        unit: inventoryItem.trackingUnit,
        canonicalQuantity,
        onHandBefore,
        onHandAfter,
        reservedBefore,
        reservedAfter,
        sourceType: "inventory_reservation",
        sourceId: reservation.reservationId,
        reasonCode: `fulfillment_${station}_${action}`,
        performedBy: actor,
        idempotencyKey,
        requestFingerprint,
        inventoryReservationId: reservation.reservationId,
        orderId: order.orderId,
        orderLineIds,
        allocationIds,
        fulfillmentStation: station,
        fulfillmentAction: action,
    }], { session })
    return movement
}

/**
 * Consumes the reservation-time allocation snapshot inside the caller's
 * fulfilment transaction. Recipes and MenuItem mappings are never reloaded.
 */
export async function consumeReservedInventoryForFulfillment({
    businessId,
    order,
    orderLineIds,
    station,
    action,
    actor,
    session,
    now = new Date(),
}, {
    InventoryReservationModel = InventoryReservation,
    InventoryItemModel = InventoryItem,
    InventoryMovementModel = InventoryMovement,
    projectSimple = projectSimpleMappings,
    logger = console,
} = {}) {
    if (!session) {
        throw reservationError(
            "A Mongo session is required for inventory consumption",
            "INVENTORY_TRANSACTION_REQUIRED",
            500,
        )
    }
    const tenantId = requiredText(businessId, "businessId")
    if (!order?.inventoryReservationId) {
        return { changed: false, skipped: "order_without_inventory_reservation" }
    }

    const reservation = await InventoryReservationModel.findOne({
        businessId: tenantId,
        reservationId: order.inventoryReservationId,
        orderId: order.orderId,
    }, null, { session })
    if (!reservation) {
        logger?.warn?.("[inventory-consumption] linked reservation not found; preserving legacy fulfilment", {
            businessId: tenantId,
            orderId: order.orderId,
            reservationId: order.inventoryReservationId,
        })
        return { changed: false, skipped: "inventory_reservation_not_found" }
    }

    const lineAllocations = Array.isArray(reservation.lineAllocations)
        ? reservation.lineAllocations
        : []
    if (lineAllocations.length === 0) {
        if ((reservation.components || []).length > 0) {
            logger?.warn?.("[inventory-consumption] reservation has no line allocation snapshot; consumption skipped", {
                businessId: tenantId,
                orderId: order.orderId,
                reservationId: reservation.reservationId,
            })
        }
        return { changed: false, skipped: "reservation_without_line_allocations" }
    }
    if (reservation.status !== INVENTORY_RESERVATION_STATUSES.COMMITTED) {
        throw reservationError(
            "Inventory reservation is not committed for fulfilment",
            "INVENTORY_RESERVATION_NOT_COMMITTED",
            409,
        )
    }

    const selectedLineIds = [...new Set((orderLineIds || []).map(String))]
    if (selectedLineIds.length === 0) {
        return { changed: false, skipped: "no_eligible_order_lines" }
    }
    const selectedIdSet = new Set(selectedLineIds)
    const orderLines = (order.items || []).filter((line) =>
        selectedIdSet.has(String(line.orderLineId)))
    if (orderLines.length !== selectedLineIds.length) {
        throw reservationError(
            "Inventory consumption references an unknown order line",
            "INVENTORY_ORDER_LINE_NOT_FOUND",
            409,
        )
    }
    const canonicalMenuItemIds = new Set(
        (reservation.menuRequirements || [])
            .filter((requirement) => requirement.authority === "canonical")
            .map((requirement) => String(requirement.menuItemId)),
    )

    for (const line of orderLines) {
        const owned = lineAllocations.filter(
            (allocation) => String(allocation.orderLineId) === String(line.orderLineId),
        )
        if (
            canonicalMenuItemIds.has(String(line.menuItemId)) &&
            owned.length === 0
        ) {
            throw reservationError(
                "Canonical inventory allocation is missing for an order line",
                "INVENTORY_LINE_ALLOCATION_MISSING",
                409,
            )
        }
        if (owned.some((allocation) => (
            String(allocation.menuItemId) !== String(line.menuItemId) ||
            allocation.fulfillmentStation !== line.fulfillmentStation ||
            allocation.fulfillmentBehavior !== line.fulfillmentBehavior ||
            allocation.fulfillmentStation !== station
        ))) {
            throw reservationError(
                "Inventory allocation does not match the frozen fulfilment line",
                "INVENTORY_FULFILLMENT_ALLOCATION_MISMATCH",
                409,
            )
        }
        const validTrigger = (
            line.fulfillmentBehavior === FULFILLMENT_BEHAVIORS.PREPARED &&
            action === FULFILLMENT_ACTIONS.START
        ) || (
            line.fulfillmentBehavior === FULFILLMENT_BEHAVIORS.DIRECT &&
            station === FULFILLMENT_STATIONS.BAR &&
            action === FULFILLMENT_ACTIONS.READY
        )
        if (owned.length > 0 && !validTrigger) {
            throw reservationError(
                "Inventory consumption was requested for an invalid fulfilment transition",
                "INVALID_INVENTORY_CONSUMPTION_TRIGGER",
                409,
            )
        }
        if (owned.some(
            (allocation) => allocation.status === INVENTORY_LINE_ALLOCATION_STATUSES.RELEASED,
        )) {
            throw reservationError(
                "Released inventory cannot be consumed",
                "INVENTORY_ALLOCATION_ALREADY_RELEASED",
                409,
            )
        }
    }

    const allocationsToConsume = lineAllocations.filter((allocation) =>
        selectedIdSet.has(String(allocation.orderLineId)) &&
        allocation.status === INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED)
    if (allocationsToConsume.length === 0) {
        return { reservation, changed: false, replayed: true, movements: [] }
    }

    const allocationsByInventoryId = new Map()
    for (const allocation of allocationsToConsume) {
        const existing = allocationsByInventoryId.get(allocation.inventoryItemId) || []
        existing.push(allocation)
        allocationsByInventoryId.set(allocation.inventoryItemId, existing)
    }
    const inventoryItemIds = [...allocationsByInventoryId.keys()].sort()
    const inventoryItems = await InventoryItemModel.find({
        businessId: tenantId,
        inventoryItemId: { $in: inventoryItemIds },
    }, null, { session })
    const inventoryById = new Map(
        inventoryItems.map((inventoryItem) => [inventoryItem.inventoryItemId, inventoryItem]),
    )

    for (const inventoryItemId of inventoryItemIds) {
        const inventoryItem = inventoryById.get(inventoryItemId)
        const allocations = allocationsByInventoryId.get(inventoryItemId)
        const canonicalQuantity = allocations.reduce(
            (total, allocation) => total + allocation.canonicalQuantity,
            0,
        )
        if (
            !inventoryItem ||
            !validInventoryBalance(inventoryItem) ||
            !positiveQuantity(canonicalQuantity) ||
            inventoryItem.onHandQuantity < canonicalQuantity ||
            inventoryItem.reservedQuantity < canonicalQuantity ||
            allocations.some((allocation) => allocation.unit !== inventoryItem.trackingUnit)
        ) {
            throw reservationError(
                "Reserved inventory cannot be consumed safely",
                "INVENTORY_CONSUMPTION_BALANCE_CONFLICT",
                409,
            )
        }
    }

    const performedBy = normalizeActor(actor)
    const movements = []
    for (const inventoryItemId of inventoryItemIds) {
        const allocations = allocationsByInventoryId.get(inventoryItemId)
        const movement = await createConsumptionMovement({
            businessId: tenantId,
            reservation,
            order,
            inventoryItem: inventoryById.get(inventoryItemId),
            allocations,
            station,
            action,
            actor: performedBy,
            session,
            InventoryMovementModel,
        })
        movements.push(movement)
        for (const allocation of allocations) {
            allocation.status = INVENTORY_LINE_ALLOCATION_STATUSES.CONSUMED
            allocation.consumeMovementId = movement.movementId
            allocation.consumedAt = now
        }
    }
    await reservation.save({ session })

    await projectSimple({
        resolved: {
            businessId: tenantId,
            requirements: inventoryItemIds.map((inventoryItemId) => ({
                inventoryItemId,
                inventoryItem: inventoryById.get(inventoryItemId),
            })),
            menuRequirements: reservation.menuRequirements || [],
        },
        session,
    })

    return {
        reservation,
        changed: true,
        replayed: false,
        movements,
        consumedAllocationIds: allocationsToConsume.map(
            (allocation) => allocation.allocationId,
        ),
    }
}

function validateReleaseAuthority(reservation, releaseEvidence) {
    if (reservation.sourceType !== INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT) return
    if (!STRIPE_RELEASE_EVIDENCE.has(releaseEvidence)) {
        throw reservationError(
            "Stripe inventory cannot be released without provider-authoritative evidence",
            "STRIPE_RELEASE_EVIDENCE_REQUIRED",
            409,
        )
    }
}

export async function releaseInventoryReservationWithinTransaction({
    businessId,
    reservationId,
    releaseEvidence,
    expectedStripeSessionId = null,
    actor = null,
    session,
}, {
    InventoryReservationModel = InventoryReservation,
    InventoryItemModel = InventoryItem,
    InventoryMovementModel = InventoryMovement,
    MenuItemModel = MenuItem,
    OrderModel = Order,
} = {}) {
    if (!session) {
        throw reservationError("A Mongo session is required for release", "INVENTORY_TRANSACTION_REQUIRED", 500)
    }
    const tenantId = requiredText(businessId, "businessId")
    const reservation = await InventoryReservationModel.findOne({
        businessId: tenantId,
        reservationId: requiredText(reservationId, "reservationId", 100),
    }, null, { session })
    if (!reservation) {
        throw reservationError("Inventory reservation not found", "INVENTORY_RESERVATION_NOT_FOUND", 404)
    }
    if ([
        INVENTORY_RESERVATION_STATUSES.RELEASED,
        INVENTORY_RESERVATION_STATUSES.EXPIRED,
    ].includes(reservation.status)) {
        return { reservation, changed: false, replayed: true }
    }
    validateReleaseAuthority(reservation, releaseEvidence)
    if (
        expectedStripeSessionId &&
        reservation.stripeSessionId &&
        reservation.stripeSessionId !== expectedStripeSessionId
    ) {
        throw reservationError("Stripe session does not match inventory reservation", "STRIPE_SESSION_MISMATCH")
    }
    if (
        reservation.status === INVENTORY_RESERVATION_STATUSES.COMMITTED &&
        releaseEvidence !== INVENTORY_RESERVATION_RELEASE_EVIDENCE.ORDER_CANCELLED_BEFORE_FULFILMENT
    ) {
        throw reservationError(
            "Committed inventory may only be released by a pre-fulfilment order cancellation",
            "COMMITTED_INVENTORY_RELEASE_FORBIDDEN",
        )
    }

    const lineAllocations = Array.isArray(reservation.lineAllocations)
        ? reservation.lineAllocations
        : []
    const hasLineAllocationSnapshot = lineAllocations.length > 0
    const releaseAllocations = hasLineAllocationSnapshot
        ? lineAllocations.filter(
            (allocation) => allocation.status === INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED,
        )
        : []
    const releaseQuantityByInventoryId = new Map()
    for (const allocation of releaseAllocations) {
        releaseQuantityByInventoryId.set(
            allocation.inventoryItemId,
            (releaseQuantityByInventoryId.get(allocation.inventoryItemId) || 0) +
                allocation.canonicalQuantity,
        )
    }
    const canonicalIds = (reservation.components || []).map((component) => component.inventoryItemId)
    const inventoryItems = canonicalIds.length > 0
        ? await InventoryItemModel.find({
            businessId: tenantId,
            inventoryItemId: { $in: canonicalIds },
        }, null, { session })
        : []
    const inventoryById = new Map(inventoryItems.map((item) => [item.inventoryItemId, item]))
    for (const component of reservation.components || []) {
        const inventoryItem = inventoryById.get(component.inventoryItemId)
        const releaseQuantity = hasLineAllocationSnapshot
            ? releaseQuantityByInventoryId.get(component.inventoryItemId) || 0
            : component.canonicalQuantity
        if (
            !positiveQuantity(component.canonicalQuantity) ||
            !Number.isSafeInteger(releaseQuantity) ||
            releaseQuantity < 0 ||
            (
                releaseQuantity > 0 &&
                (!inventoryItem || inventoryItem.reservedQuantity < releaseQuantity)
            )
        ) {
            throw reservationError(
                "Reserved inventory cannot be released safely",
                "INVENTORY_RELEASE_BALANCE_CONFLICT",
                409,
            )
        }
    }

    const legacyIds = (reservation.legacyComponents || []).map((component) => component.menuItemId)
    const legacyMenuItems = legacyIds.length > 0
        ? await MenuItemModel.find({
            businessId: tenantId,
            _id: { $in: legacyIds },
        }, null, { session })
        : []
    const legacyById = new Map(legacyMenuItems.map((item) => [String(item._id), item]))
    for (const component of reservation.legacyComponents || []) {
        const menuItem = legacyById.get(String(component.menuItemId))
        const after = menuItem ? menuItem.stockQuantity + component.quantity : NaN
        if (!menuItem || !Number.isSafeInteger(after) || after > MAX_INVENTORY_QUANTITY) {
            throw reservationError(
                "Legacy inventory cannot be released safely",
                "LEGACY_INVENTORY_RELEASE_CONFLICT",
                409,
            )
        }
    }

    const performedBy = normalizeActor(actor)
    const now = new Date()
    for (const component of reservation.components || []) {
        const inventoryItem = inventoryById.get(component.inventoryItemId)
        const releaseQuantity = hasLineAllocationSnapshot
            ? releaseQuantityByInventoryId.get(component.inventoryItemId) || 0
            : component.canonicalQuantity
        if (releaseQuantity === 0) continue
        const movement = await createReservationMovement({
            businessId: tenantId,
            reservationId: reservation.reservationId,
            inventoryItem,
            canonicalQuantity: releaseQuantity,
            action: "release",
            actor: performedBy,
            session,
            InventoryMovementModel,
        })
        component.releaseMovementId = movement.movementId
        for (const allocation of releaseAllocations) {
            if (allocation.inventoryItemId !== component.inventoryItemId) continue
            allocation.status = INVENTORY_LINE_ALLOCATION_STATUSES.RELEASED
            allocation.releaseMovementId = movement.movementId
            allocation.releasedAt = now
        }
    }
    for (const component of reservation.legacyComponents || []) {
        const menuItem = legacyById.get(String(component.menuItemId))
        menuItem.stockQuantity += component.quantity
        if (menuItem.stockQuantity > 0 && menuItem.isAvailable === false) {
            menuItem.isAvailable = true
        }
        await menuItem.save({ session })
    }

    const resolvedForProjection = {
        businessId: tenantId,
        requirements: (reservation.components || []).map((component) => ({
            inventoryItemId: component.inventoryItemId,
            inventoryItem: inventoryById.get(component.inventoryItemId),
        })),
        menuRequirements: reservation.menuRequirements || [],
    }
    await projectSimpleMappings({ resolved: resolvedForProjection, session })

    const expired = [
        INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_EXPIRED_EVENT,
        INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_VERIFIED_EXPIRED,
    ].includes(releaseEvidence)
    reservation.status = expired
        ? INVENTORY_RESERVATION_STATUSES.EXPIRED
        : INVENTORY_RESERVATION_STATUSES.RELEASED
    reservation.releaseEvidence = releaseEvidence
    reservation.releasedAt = now
    reservation.expiredAt = expired ? now : null
    if (expired) {
        reservation.providerState = INVENTORY_RESERVATION_PROVIDER_STATES.EXPIRED
    } else if (
        releaseEvidence === INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_CREATION_FAILED
    ) {
        reservation.providerState = INVENTORY_RESERVATION_PROVIDER_STATES.CREATION_FAILED
    }
    await reservation.save({ session })

    if (reservation.orderId) {
        const order = await OrderModel.findOne({
            businessId: tenantId,
            orderId: reservation.orderId,
        }, null, { session })
        if (order) {
            order.inventoryReleased = true
            order.inventoryReleasedAt = now
            order.inventoryRestored = (reservation.legacyComponents || []).length > 0
            order.inventoryRestoredAt = order.inventoryRestored ? now : null
            await order.save({ session })
        }
    }
    return { reservation, changed: true, replayed: false }
}

export async function releaseInventoryReservation(command, dependencies = {}) {
    const result = await withCanonicalInventoryTransaction((session) =>
        releaseInventoryReservationWithinTransaction({ ...command, session }, dependencies))
    return result
}

export async function commitHeldInventoryReservation({
    businessId,
    reservationId,
    pendingCheckoutId,
    stripeSessionId,
    orderId,
    session,
}, { InventoryReservationModel = InventoryReservation } = {}) {
    if (!session) {
        throw reservationError("A Mongo session is required for commit", "INVENTORY_TRANSACTION_REQUIRED", 500)
    }
    const reservation = await InventoryReservationModel.findOne({
        businessId: requiredText(businessId, "businessId"),
        reservationId: requiredText(reservationId, "reservationId", 100),
    }, null, { session })
    if (!reservation) {
        throw reservationError("Inventory reservation not found", "INVENTORY_RESERVATION_NOT_FOUND", 404)
    }
    if (
        String(reservation.pendingCheckoutId) !== String(pendingCheckoutId) ||
        (reservation.stripeSessionId && reservation.stripeSessionId !== stripeSessionId)
    ) {
        throw reservationError("Checkout does not match inventory reservation", "INVENTORY_RESERVATION_LINK_MISMATCH")
    }
    if ([
        INVENTORY_RESERVATION_STATUSES.RELEASED,
        INVENTORY_RESERVATION_STATUSES.EXPIRED,
    ].includes(reservation.status)) {
        throw reservationError(
            "Paid Checkout references inventory that was already released",
            "PAID_CHECKOUT_INVENTORY_RELEASED",
            500,
        )
    }
    if (reservation.status === INVENTORY_RESERVATION_STATUSES.COMMITTED) {
        if (reservation.orderId !== orderId) {
            throw reservationError("Inventory reservation is committed to another order", "INVENTORY_COMMIT_CONFLICT")
        }
        return { reservation, changed: false, replayed: true }
    }

    reservation.status = INVENTORY_RESERVATION_STATUSES.COMMITTED
    reservation.orderId = orderId
    reservation.stripeSessionId = stripeSessionId
    reservation.providerState = INVENTORY_RESERVATION_PROVIDER_STATES.COMPLETE
    reservation.providerLastVerifiedAt = new Date()
    reservation.committedAt = new Date()
    await reservation.save({ session })
    return { reservation, changed: true, replayed: false }
}

export async function attachStripeSessionToInventoryReservation({
    businessId,
    reservationId,
    pendingCheckoutId,
    stripeSession,
    session,
}, { InventoryReservationModel = InventoryReservation } = {}) {
    if (!session) {
        throw reservationError("A Mongo session is required for Stripe linkage", "INVENTORY_TRANSACTION_REQUIRED", 500)
    }
    const reservation = await InventoryReservationModel.findOne({
        businessId: requiredText(businessId, "businessId"),
        reservationId: requiredText(reservationId, "reservationId", 100),
    }, null, { session })
    if (!reservation) {
        throw reservationError("Inventory reservation not found", "INVENTORY_RESERVATION_NOT_FOUND", 404)
    }
    if (String(reservation.pendingCheckoutId) !== String(pendingCheckoutId)) {
        throw reservationError("PendingCheckout does not match inventory reservation", "INVENTORY_RESERVATION_LINK_MISMATCH")
    }
    if (reservation.stripeSessionId && reservation.stripeSessionId !== stripeSession.id) {
        throw reservationError("Inventory reservation has another Stripe session", "STRIPE_SESSION_MISMATCH")
    }
    const stripeExpiresAt = Number.isFinite(Number(stripeSession.expires_at))
        ? new Date(Number(stripeSession.expires_at) * 1000)
        : reservation.expiresAt
    reservation.stripeSessionId = stripeSession.id
    reservation.stripeExpiresAt = stripeExpiresAt
    reservation.expiresAt = stripeExpiresAt
    reservation.providerState = stripeSession.status === "complete"
        ? INVENTORY_RESERVATION_PROVIDER_STATES.COMPLETE
        : stripeSession.status === "expired"
            ? INVENTORY_RESERVATION_PROVIDER_STATES.EXPIRED
            : INVENTORY_RESERVATION_PROVIDER_STATES.OPEN
    reservation.providerLastVerifiedAt = new Date()
    await reservation.save({ session })
    return reservation
}

export async function recordInventoryPaymentException({
    businessId,
    orderId,
    pendingCheckoutId,
    inventoryReservationId,
    stripeSessionId,
    stripeEventId,
    reasonCode,
    details = null,
}, { InventoryPaymentExceptionModel = InventoryPaymentException } = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const providerSessionId = requiredText(stripeSessionId, "stripeSessionId", 255)
    return InventoryPaymentExceptionModel.findOneAndUpdate(
        { businessId: tenantId, stripeSessionId: providerSessionId },
        {
            $setOnInsert: {
                businessId: tenantId,
                orderId: requiredText(orderId, "orderId"),
                pendingCheckoutId,
                inventoryReservationId: requiredText(
                    inventoryReservationId,
                    "inventoryReservationId",
                    100,
                ),
                stripeSessionId: providerSessionId,
                stripeEventId: requiredText(stripeEventId, "stripeEventId", 255),
                reasonCode: requiredText(reasonCode, "reasonCode", 100),
                status: "open",
                details,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    )
}
