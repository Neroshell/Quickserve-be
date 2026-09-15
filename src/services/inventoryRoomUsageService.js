import crypto from "node:crypto"
import mongoose from "mongoose"
import Business from "../models/Business.js"
import InventoryItem from "../models/InventoryItem.js"
import InventoryMovement, { generateInventoryMovementId } from "../models/InventoryMovement.js"
import ServicePoint from "../models/ServicePoint.js"
import { INVENTORY_ITEM_DOMAINS, INVENTORY_MOVEMENT_TYPES } from "../constants/inventory.js"
import {
    buildInventoryRequestFingerprint,
    InventoryDomainError,
    normalizeInventoryActor,
    normalizeInventoryIdempotencyKey,
    toInventoryItemDTO,
    toInventoryMovementDTO,
    withCanonicalInventoryTransaction,
} from "./canonicalInventoryService.js"
import { resolveBusinessCapabilities } from "./businessCapabilityService.js"
import { isHotelOperationalInventoryDomain } from "./inventoryDomainService.js"
import { safelyNotifyInventoryStockTransitions } from "./inventoryNotificationIntegrationService.js"
import { normalizeInventoryQuantity } from "./inventoryUomService.js"

const MAX_ROOM_USAGE_LINES = 100

function roomUsageError(message, code, statusCode = 400) {
    return new InventoryDomainError(message, { code, statusCode })
}

function requiredText(value, field, maxLength) {
    if (typeof value !== "string" || !value.trim()) {
        throw roomUsageError(`${field} is required`, "INVALID_ROOM_USAGE_INPUT")
    }
    const normalized = value.trim()
    if (normalized.length > maxLength) {
        throw roomUsageError(`${field} cannot exceed ${maxLength} characters`, "INVALID_ROOM_USAGE_INPUT")
    }
    return normalized
}

function optionalText(value, field, maxLength) {
    if (value === undefined || value === null || value === "") return null
    if (typeof value !== "string") {
        throw roomUsageError(`${field} must be a string`, "INVALID_ROOM_USAGE_INPUT")
    }
    const normalized = value.trim()
    if (normalized.length > maxLength) {
        throw roomUsageError(`${field} cannot exceed ${maxLength} characters`, "INVALID_ROOM_USAGE_INPUT")
    }
    return normalized || null
}

function normalizeRoomUsageLines(items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ROOM_USAGE_LINES) {
        throw roomUsageError(
            `items must contain between 1 and ${MAX_ROOM_USAGE_LINES} lines`,
            "INVALID_ROOM_USAGE_ITEMS",
        )
    }
    const seen = new Set()
    const lines = items.map((line) => {
        if (!line || typeof line !== "object" || Array.isArray(line)) {
            throw roomUsageError("Each Room Usage line must be an object", "INVALID_ROOM_USAGE_ITEMS")
        }
        for (const field of Object.keys(line)) {
            if (!["inventoryItemId", "quantity", "unit"].includes(field)) {
                throw roomUsageError(`Unsupported Room Usage line field: ${field}`, "INVALID_ROOM_USAGE_ITEMS")
            }
        }
        const inventoryItemId = requiredText(line.inventoryItemId, "inventoryItemId", 100)
        if (seen.has(inventoryItemId)) {
            throw roomUsageError(
                "The same inventory item cannot appear twice in one Room Usage operation",
                "DUPLICATE_ROOM_USAGE_ITEM",
            )
        }
        seen.add(inventoryItemId)
        return { inventoryItemId, quantity: line.quantity, unit: line.unit }
    })
    return lines.sort((left, right) => left.inventoryItemId.localeCompare(right.inventoryItemId))
}

async function lean(value) {
    return typeof value?.lean === "function" ? value.lean() : value
}

function operationIdentity(businessId, idempotencyKey) {
    return `iru_${crypto.createHash("sha256")
        .update(`${businessId}:${idempotencyKey}`)
        .digest("hex")
        .slice(0, 40)}`
}

function lineIdempotencyKey(operationId, inventoryItemId) {
    return `${operationId}:${crypto.createHash("sha256")
        .update(inventoryItemId)
        .digest("hex")
        .slice(0, 24)}`
}

function buildResult({ room, items, movements, operationId, replayed }) {
    return {
        operationId,
        replayed,
        room: {
            servicePointId: room.servicePointId,
            label: room.label,
            roomType: room.roomType ?? null,
        },
        items: items.map(toInventoryItemDTO),
        movements: movements.map(toInventoryMovementDTO),
    }
}

function isDuplicateKeyError(error) {
    return error?.code === 11000
}

export async function recordRoomUsage({
    businessId,
    servicePointId,
    items,
    note,
    actor,
    idempotencyKey,
}, {
    BusinessModel = Business,
    InventoryItemModel = InventoryItem,
    InventoryMovementModel = InventoryMovement,
    ServicePointModel = ServicePoint,
    generateMovementId = generateInventoryMovementId,
    startSession = () => mongoose.startSession(),
    notifyInventoryTransitions = null,
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const roomId = requiredText(servicePointId, "servicePointId", 100)
    const key = normalizeInventoryIdempotencyKey(idempotencyKey)
    const performedBy = normalizeInventoryActor(actor)
    const requestedLines = normalizeRoomUsageLines(items)
    const usageNote = optionalText(note, "note", 1000)
    const operationId = operationIdentity(tenantId, key)

    const execute = async (session) => {
        const [business, room] = await Promise.all([
            lean(BusinessModel.findOne({ businessId: tenantId }, null, { session })),
            lean(ServicePointModel.findOne({
                businessId: tenantId,
                servicePointId: roomId,
                servicePointType: "room",
                isActive: true,
            }, null, { session })),
        ])
        if (!business || !resolveBusinessCapabilities(business).visibleModules.includes("lodging")) {
            throw roomUsageError(
                "Room Usage is not enabled for this business",
                "ROOM_USAGE_NOT_ENABLED",
                403,
            )
        }
        if (!room) {
            throw roomUsageError("Active hotel room not found", "ROOM_SERVICE_POINT_NOT_FOUND", 404)
        }

        const itemIds = requestedLines.map((line) => line.inventoryItemId)
        const foundItems = await InventoryItemModel.find({
            businessId: tenantId,
            inventoryItemId: { $in: itemIds },
            deletedAt: null,
        }, null, { session })
        const itemById = new Map((foundItems || []).map((item) => [item.inventoryItemId, item]))
        if (itemById.size !== itemIds.length) {
            throw roomUsageError(
                "One or more inventory items were not found",
                "ROOM_USAGE_INVENTORY_ITEM_NOT_FOUND",
                404,
            )
        }

        const normalizedLines = requestedLines.map((line) => {
            const item = itemById.get(line.inventoryItemId)
            if (item.deletedAt) {
                throw roomUsageError("Deleted inventory items cannot be consumed", "INVENTORY_ITEM_DELETED", 409)
            }
            if (item.isActive === false) {
                throw roomUsageError("Inactive inventory items cannot be consumed", "INVENTORY_ITEM_INACTIVE", 409)
            }
            const domain = item.domain || INVENTORY_ITEM_DOMAINS.FOOD_SERVICE
            if (!isHotelOperationalInventoryDomain(domain)) {
                throw roomUsageError(
                    "Only hotel operational inventory items can be recorded as Room Usage",
                    "INVENTORY_ITEM_NOT_ROOM_USAGE_ELIGIBLE",
                    409,
                )
            }
            return {
                item,
                ...normalizeInventoryQuantity({
                    quantity: line.quantity,
                    unit: line.unit,
                    trackingUnit: item.trackingUnit,
                }),
            }
        })

        const requestFingerprint = buildInventoryRequestFingerprint({
            businessId: tenantId,
            servicePointId: roomId,
            items: normalizedLines.map((line) => ({
                inventoryItemId: line.item.inventoryItemId,
                canonicalQuantity: line.canonicalQuantity,
                submittedUnit: line.submittedUnit,
            })),
            note: usageNote,
            actorStaffId: performedBy.staffId,
        })
        const existingMovements = await lean(InventoryMovementModel.find({
            businessId: tenantId,
            sourceType: "room_usage",
            operationId,
        }, null, { session }))
        if ((existingMovements || []).length > 0) {
            const exactReplay = existingMovements.length === normalizedLines.length &&
                existingMovements.every((movement) => movement.requestFingerprint === requestFingerprint)
            if (!exactReplay) {
                throw roomUsageError(
                    "Idempotency-Key was already used with different Room Usage input",
                    "INVENTORY_IDEMPOTENCY_CONFLICT",
                    409,
                )
            }
            return buildResult({
                room,
                items: normalizedLines.map((line) => line.item),
                movements: existingMovements,
                operationId,
                replayed: true,
            })
        }

        const movementInputs = []
        for (const line of normalizedLines) {
            const { item, canonicalQuantity, submittedUnit } = line
            const onHandBefore = item.onHandQuantity
            const reservedBefore = item.reservedQuantity
            const availableBefore = onHandBefore - reservedBefore
            if (availableBefore < canonicalQuantity) {
                throw roomUsageError(
                    `Insufficient available stock for ${item.name}`,
                    "INSUFFICIENT_AVAILABLE_INVENTORY",
                    409,
                )
            }
            const onHandAfter = onHandBefore - canonicalQuantity
            item.onHandQuantity = onHandAfter
            await item.save({ session })
            movementInputs.push({
                movementId: generateMovementId(),
                businessId: tenantId,
                inventoryItemId: item.inventoryItemId,
                type: INVENTORY_MOVEMENT_TYPES.CONSUME,
                quantityDeltaOnHand: -canonicalQuantity,
                quantityDeltaReserved: 0,
                unit: submittedUnit,
                canonicalQuantity,
                onHandBefore,
                onHandAfter,
                reservedBefore,
                reservedAfter: reservedBefore,
                sourceType: "room_usage",
                sourceId: operationId,
                servicePointId: roomId,
                operationId,
                reasonCode: "room_usage",
                note: usageNote,
                performedBy,
                idempotencyKey: lineIdempotencyKey(operationId, item.inventoryItemId),
                requestFingerprint,
                unitCostMinor: item.unitCostMinor ?? null,
                costCurrency: item.costCurrency ?? null,
            })
        }
        const movements = await InventoryMovementModel.create(movementInputs, { session })
        return buildResult({
            room,
            items: normalizedLines.map((line) => line.item),
            movements,
            operationId,
            replayed: false,
        })
    }

    let result
    try {
        result = await withCanonicalInventoryTransaction(execute, { startSession })
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error
        // An exact concurrent retry may lose the unique movement-key race after
        // the winning transaction commits. Re-read through the same command so
        // the persisted operation is verified before returning a replay.
        result = await withCanonicalInventoryTransaction(execute, { startSession })
    }

    if (!result.replayed) {
        await safelyNotifyInventoryStockTransitions({
            businessId: tenantId,
            movements: result.movements,
            inventoryItems: result.items,
        }, { notify: notifyInventoryTransitions })
    }
    return result
}
