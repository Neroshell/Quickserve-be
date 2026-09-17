import crypto from "node:crypto"
import mongoose from "mongoose"
import Business from "../models/Business.js"
import InventoryItem from "../models/InventoryItem.js"
import InventoryMovement, { generateInventoryMovementId } from "../models/InventoryMovement.js"
import ServicePoint from "../models/ServicePoint.js"
import HousekeepingOperation from "../models/HousekeepingOperation.js"
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

function buildResult({ room, items, movements, operationId, replayed, housekeepingOperationId = null }) {
    return {
        operationId,
        replayed,
        housekeepingOperationId,
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
    housekeepingOperationId = null,
}, {
    BusinessModel = Business,
    InventoryItemModel = InventoryItem,
    InventoryMovementModel = InventoryMovement,
    ServicePointModel = ServicePoint,
    HousekeepingOperationModel = HousekeepingOperation,
    generateMovementId = generateInventoryMovementId,
    startSession = () => mongoose.startSession(),
    notifyInventoryTransitions = null,
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const roomId = requiredText(servicePointId, "servicePointId", 100)
    const linkedHousekeepingOperationId = housekeepingOperationId === null || housekeepingOperationId === undefined || housekeepingOperationId === ""
        ? null
        : requiredText(housekeepingOperationId, "housekeepingOperationId", 100)
    const key = normalizeInventoryIdempotencyKey(
        linkedHousekeepingOperationId
            ? `housekeeping:${linkedHousekeepingOperationId}:supplies:v1`
            : idempotencyKey,
    )
    const performedBy = normalizeInventoryActor(actor)
    const requestedLines = normalizeRoomUsageLines(items)
    const usageNote = optionalText(note, "note", 1000)
    const operationId = operationIdentity(tenantId, key)

    const execute = async (session) => {
        // MongoDB transactions do not support parallel operations on one session.
        // Keep these reads sequential so Room Usage cannot fail with transaction-state errors.
        const business = await lean(BusinessModel.findOne({ businessId: tenantId }, null, { session }))
        const room = await lean(ServicePointModel.findOne({
            businessId: tenantId,
            servicePointId: roomId,
            servicePointType: "room",
            isActive: true,
        }, null, { session }))
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

        let housekeepingOperation = null
        if (linkedHousekeepingOperationId) {
            housekeepingOperation = await HousekeepingOperationModel.findOne({
                businessId: tenantId,
                housekeepingOperationId: linkedHousekeepingOperationId,
            }, null, { session })
            if (!housekeepingOperation) {
                throw roomUsageError("Housekeeping operation not found", "HOUSEKEEPING_OPERATION_NOT_FOUND", 404)
            }
            if (
                housekeepingOperation.servicePointId !== roomId ||
                housekeepingOperation.status !== "cleaning" ||
                housekeepingOperation.active !== true
            ) {
                throw roomUsageError(
                    "Housekeeping operation does not match this active room cleaning",
                    "HOUSEKEEPING_ROOM_USAGE_CONFLICT",
                    409,
                )
            }
            const managementActor = ["owner", "restaurant_owner", "admin", "co_owner", "manager"].includes(performedBy.role)
            if (!managementActor && housekeepingOperation.claimedBy !== performedBy.staffId) {
                throw roomUsageError(
                    "Only the current cleaner or authorized management may record supplies",
                    "HOUSEKEEPING_CLAIM_REQUIRED",
                    403,
                )
            }
            if (!["pending", "recorded"].includes(housekeepingOperation.supplyOutcome)) {
                throw roomUsageError(
                    "This cleaning already has a no-supplies outcome",
                    "HOUSEKEEPING_SUPPLY_OUTCOME_CONFLICT",
                    409,
                )
            }
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
            housekeepingOperationId: linkedHousekeepingOperationId,
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
                housekeepingOperationId: linkedHousekeepingOperationId,
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
        const movements = await InventoryMovementModel.create(movementInputs, {
            session,
            ordered: true,
        })
        if (housekeepingOperation) {
            const linked = await HousekeepingOperationModel.findOneAndUpdate({
                _id: housekeepingOperation._id,
                businessId: tenantId,
                servicePointId: roomId,
                status: "cleaning",
                active: true,
                supplyOutcome: "pending",
            }, {
                $set: {
                    supplyOutcome: "recorded",
                    roomUsageOperationId: operationId,
                    ...(housekeepingOperation.inventoryException?.status === "unresolved" ? {
                        "inventoryException.status": "resolved",
                        "inventoryException.resolvedBy": {
                            staffId: performedBy.staffId,
                            name: performedBy.name,
                            role: performedBy.role,
                        },
                        "inventoryException.resolvedAt": new Date(),
                        "inventoryException.reconciliationMovementIds": movements.map((movement) => movement.movementId),
                        "inventoryException.resolutionNote": "Resolved by successful canonical Room Usage retry",
                    } : {}),
                },
            }, { new: true, runValidators: true, session })
            if (!linked) {
                throw roomUsageError(
                    "Housekeeping supply outcome changed. Refresh and try again.",
                    "HOUSEKEEPING_SUPPLY_OUTCOME_CONFLICT",
                    409,
                )
            }
        }
        return buildResult({
            room,
            items: normalizedLines.map((line) => line.item),
            movements,
            operationId,
            replayed: false,
            housekeepingOperationId: linkedHousekeepingOperationId,
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
