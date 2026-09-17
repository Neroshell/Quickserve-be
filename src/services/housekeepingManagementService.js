import crypto from "node:crypto"
import mongoose from "mongoose"

import { INVENTORY_MOVEMENT_TYPES } from "../constants/inventory.js"
import { PERMISSIONS } from "../constants/permissions.js"
import Business from "../models/Business.js"
import HousekeepingOperation from "../models/HousekeepingOperation.js"
import InventoryMovement from "../models/InventoryMovement.js"
import Staff from "../models/Staff.js"
import ServicePoint from "../models/ServicePoint.js"
import {
    assertLodgingBusiness,
    housekeepingError,
    isManagementActor,
    normalizeHousekeepingActor,
    operationDTO,
    withHousekeepingTransaction,
} from "./housekeepingService.js"

const PRIORITIES = new Set(["normal", "priority", "urgent"])
const MAX_HISTORY_PAGE = 50
const DEFAULT_HISTORY_PAGE = 20
const MAX_ASSIGNMENT_HISTORY = 50
const RECONCILIATION_TYPES = new Set([
    INVENTORY_MOVEMENT_TYPES.RECEIVE,
    INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_INCREASE,
    INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_DECREASE,
    INVENTORY_MOVEMENT_TYPES.COUNT_RECONCILIATION_INCREASE,
    INVENTORY_MOVEMENT_TYPES.COUNT_RECONCILIATION_DECREASE,
])

function requiredText(value, field, maxLength = 200) {
    if (typeof value !== "string" || !value.trim()) {
        throw housekeepingError(`${field} is required`, "INVALID_HOUSEKEEPING_INPUT")
    }
    const normalized = value.trim()
    if (normalized.length > maxLength) {
        throw housekeepingError(`${field} cannot exceed ${maxLength} characters`, "INVALID_HOUSEKEEPING_INPUT")
    }
    return normalized
}

function optionalText(value, field, maxLength = 200) {
    if (value === undefined || value === null || value === "") return null
    return requiredText(value, field, maxLength)
}

function normalizeCommandKey(value) {
    return optionalText(value, "Idempotency-Key", 200)
}

function fingerprint(value) {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function actorSnapshot(actor) {
    return {
        staffId: actor.actorId,
        name: actor.name || null,
        role: actor.role || null,
    }
}

function staffSnapshot(staff) {
    return {
        staffId: staff.staffId,
        name: staff.name || null,
        role: staff.role || null,
    }
}

async function lean(value) {
    return typeof value?.lean === "function" ? value.lean() : value
}

async function readLodgingBusiness(businessId, session, BusinessModel = Business) {
    const business = await lean(BusinessModel.findOne({ businessId }, null, session ? { session } : undefined))
    assertLodgingBusiness(business)
    return business
}

async function readOperation({ businessId, operationId, session, HousekeepingOperationModel = HousekeepingOperation }) {
    const operation = await HousekeepingOperationModel.findOne({
        businessId,
        housekeepingOperationId: operationId,
    }, null, session ? { session } : undefined)
    if (!operation) {
        throw housekeepingError("Housekeeping operation not found", "HOUSEKEEPING_OPERATION_NOT_FOUND", 404)
    }
    return operation
}

function assertCommandReplay(receipt, key, requestFingerprint) {
    if (!key || !receipt?.key || receipt.key !== key) return false
    if (receipt.fingerprint !== requestFingerprint) {
        throw housekeepingError(
            "Idempotency-Key was already used with different Housekeeping input",
            "HOUSEKEEPING_IDEMPOTENCY_CONFLICT",
            409,
        )
    }
    return true
}

function receiptFields(path, key, requestFingerprint, timestamp) {
    if (!key) return {}
    return {
        [`commandReceipts.${path}`]: {
            key,
            fingerprint: requestFingerprint,
            recordedAt: timestamp,
        },
    }
}

function expectedAssigneeFilter(expectedAssignedTo) {
    return expectedAssignedTo
        ? { assignedTo: expectedAssignedTo }
        : { $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }] }
}

export async function listEligibleHousekeepers({ businessId }, {
    BusinessModel = Business,
    StaffModel = Staff,
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    await readLodgingBusiness(tenantId, null, BusinessModel)
    let query = StaffModel.find({
        businessId: tenantId,
        role: "housekeeping",
        accountStatus: "active",
        permissions: { $all: [PERMISSIONS.HOUSEKEEPING_VIEW, PERMISSIONS.HOUSEKEEPING_PERFORM] },
    })
    if (typeof query?.select === "function") query = query.select("staffId name role accountStatus")
    if (typeof query?.sort === "function") query = query.sort({ name: 1, staffId: 1 })
    const rows = await lean(query) || []
    return {
        staff: rows.map((row) => ({
            staffId: row.staffId,
            name: row.name,
            role: row.role,
            accountStatus: row.accountStatus,
        })),
    }
}

export async function assignHousekeepingOperation({
    businessId,
    operationId,
    assigneeStaffId,
    expectedAssignedTo = null,
    actor,
    idempotencyKey = null,
}, {
    BusinessModel = Business,
    HousekeepingOperationModel = HousekeepingOperation,
    StaffModel = Staff,
    startSession = () => mongoose.startSession(),
    now = () => new Date(),
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const requestedOperationId = requiredText(operationId, "operationId")
    const targetStaffId = requiredText(assigneeStaffId, "assigneeStaffId")
    const expected = optionalText(expectedAssignedTo, "expectedAssignedTo")
    const performedBy = normalizeHousekeepingActor(actor)
    const commandKey = normalizeCommandKey(idempotencyKey)
    const requestFingerprint = fingerprint({ requestedOperationId, targetStaffId, expected })

    return withHousekeepingTransaction(async (session) => {
        await readLodgingBusiness(tenantId, session, BusinessModel)
        const operation = await readOperation({
            businessId: tenantId,
            operationId: requestedOperationId,
            session,
            HousekeepingOperationModel,
        })
        if (assertCommandReplay(operation.commandReceipts?.assignment, commandKey, requestFingerprint)) {
            return { operation: operationDTO(operation), replayed: true }
        }
        const currentAssignedTo = operation.assignedTo || null
        if (currentAssignedTo === targetStaffId) {
            return { operation: operationDTO(operation), replayed: true }
        }
        if (operation.status !== "needs_cleaning" || operation.active !== true) {
            throw housekeepingError(
                "Only unstarted Housekeeping work can be assigned",
                "HOUSEKEEPING_ASSIGNMENT_STATE_CONFLICT",
                409,
            )
        }
        if (currentAssignedTo !== expected) {
            throw housekeepingError(
                "Assignment changed. Refresh and try again.",
                "HOUSEKEEPING_ASSIGNMENT_CONFLICT",
                409,
            )
        }

        const assignee = await lean(StaffModel.findOne({
            businessId: tenantId,
            staffId: targetStaffId,
            role: "housekeeping",
            accountStatus: "active",
            permissions: { $all: [PERMISSIONS.HOUSEKEEPING_VIEW, PERMISSIONS.HOUSEKEEPING_PERFORM] },
        }, null, { session }))
        if (!assignee) {
            throw housekeepingError(
                "Eligible active Housekeeping staff member not found",
                "HOUSEKEEPING_ASSIGNEE_NOT_ELIGIBLE",
                409,
            )
        }

        const changedAt = now()
        const historyEntry = {
            action: currentAssignedTo ? "reassigned" : "assigned",
            previousAssignee: currentAssignedTo ? {
                staffId: currentAssignedTo,
                name: operation.assignedToName || null,
                role: operation.assignedToRole || null,
            } : null,
            assignee: staffSnapshot(assignee),
            performedBy: actorSnapshot(performedBy),
            occurredAt: changedAt,
        }
        const updated = await HousekeepingOperationModel.findOneAndUpdate({
            _id: operation._id,
            businessId: tenantId,
            status: "needs_cleaning",
            active: true,
            ...expectedAssigneeFilter(expected),
        }, {
            $set: {
                assignedTo: assignee.staffId,
                assignedToName: assignee.name,
                assignedToRole: assignee.role,
                assignedAt: changedAt,
                assignedBy: performedBy.actorId,
                assignedByName: performedBy.name,
                assignedByRole: performedBy.role,
                ...receiptFields("assignment", commandKey, requestFingerprint, changedAt),
            },
            $push: {
                assignmentHistory: {
                    $each: [historyEntry],
                    $slice: -MAX_ASSIGNMENT_HISTORY,
                },
            },
        }, { new: true, runValidators: true, session })
        if (!updated) {
            throw housekeepingError(
                "Assignment changed. Refresh and try again.",
                "HOUSEKEEPING_ASSIGNMENT_CONFLICT",
                409,
            )
        }
        return { operation: operationDTO(updated), replayed: false }
    }, { startSession })
}

export async function setHousekeepingPriority({
    businessId,
    operationId,
    priority,
    expectedPriority = "normal",
    actor,
    idempotencyKey = null,
}, {
    BusinessModel = Business,
    HousekeepingOperationModel = HousekeepingOperation,
    startSession = () => mongoose.startSession(),
    now = () => new Date(),
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const requestedOperationId = requiredText(operationId, "operationId")
    const requestedPriority = requiredText(priority, "priority", 20)
    const expected = requiredText(expectedPriority || "normal", "expectedPriority", 20)
    if (!PRIORITIES.has(requestedPriority) || !PRIORITIES.has(expected)) {
        throw housekeepingError("Invalid Housekeeping priority", "INVALID_HOUSEKEEPING_PRIORITY")
    }
    const performedBy = normalizeHousekeepingActor(actor)
    const commandKey = normalizeCommandKey(idempotencyKey)
    const requestFingerprint = fingerprint({ requestedOperationId, requestedPriority, expected })

    return withHousekeepingTransaction(async (session) => {
        await readLodgingBusiness(tenantId, session, BusinessModel)
        const operation = await readOperation({
            businessId: tenantId,
            operationId: requestedOperationId,
            session,
            HousekeepingOperationModel,
        })
        if (assertCommandReplay(operation.commandReceipts?.priority, commandKey, requestFingerprint)) {
            return { operation: operationDTO(operation), replayed: true }
        }
        const currentPriority = operation.priority || "normal"
        if (currentPriority === requestedPriority) {
            return { operation: operationDTO(operation), replayed: true }
        }
        if (operation.active !== true || !["needs_cleaning", "cleaning"].includes(operation.status)) {
            throw housekeepingError("Only active work can change priority", "HOUSEKEEPING_PRIORITY_STATE_CONFLICT", 409)
        }
        if (currentPriority !== expected) {
            throw housekeepingError("Priority changed. Refresh and try again.", "HOUSEKEEPING_PRIORITY_CONFLICT", 409)
        }
        const changedAt = now()
        const priorityFilter = expected === "normal"
            ? { $or: [{ priority: "normal" }, { priority: { $exists: false } }] }
            : { priority: expected }
        const updated = await HousekeepingOperationModel.findOneAndUpdate({
            _id: operation._id,
            businessId: tenantId,
            active: true,
            ...priorityFilter,
        }, {
            $set: {
                priority: requestedPriority,
                ...receiptFields("priority", commandKey, requestFingerprint, changedAt),
            },
        }, { new: true, runValidators: true, session })
        if (!updated) {
            throw housekeepingError("Priority changed. Refresh and try again.", "HOUSEKEEPING_PRIORITY_CONFLICT", 409)
        }
        return { operation: operationDTO(updated), replayed: false }
    }, { startSession })
}

function normalizeSlaMinutes(value, field) {
    if (value === null || value === undefined || value === "") return null
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1 || number > 10080) {
        throw housekeepingError(`${field} must be a whole number from 1 to 10080`, "INVALID_HOUSEKEEPING_SETTINGS")
    }
    return number
}

export async function updateHousekeepingSettings({ businessId, targetStartMinutes, targetCleaningMinutes }, {
    BusinessModel = Business,
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const business = await readLodgingBusiness(tenantId, null, BusinessModel)
    const settings = {
        targetStartMinutes: normalizeSlaMinutes(targetStartMinutes, "targetStartMinutes"),
        targetCleaningMinutes: normalizeSlaMinutes(targetCleaningMinutes, "targetCleaningMinutes"),
    }
    const updated = await BusinessModel.findOneAndUpdate({
        _id: business._id,
        businessId: tenantId,
    }, {
        $set: { housekeepingSettings: settings },
    }, { new: true, runValidators: true })
    if (!updated) throw housekeepingError("Business changed. Refresh and try again.", "HOUSEKEEPING_SETTINGS_CONFLICT", 409)
    return { settings }
}

function normalizeExceptionItems(items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
        throw housekeepingError("Inventory exception requires attempted items", "INVALID_HOUSEKEEPING_EXCEPTION")
    }
    return items.map((item) => ({
        inventoryItemId: requiredText(item?.inventoryItemId, "inventoryItemId", 100),
        quantity: Number(item?.quantity),
        unit: requiredText(item?.unit, "unit", 40),
    })).sort((left, right) => left.inventoryItemId.localeCompare(right.inventoryItemId))
}

export async function recordHousekeepingInventoryException({
    businessId,
    operationId,
    servicePointId,
    attemptedItems,
    failureCode,
    failureMessage,
    actor,
}, {
    HousekeepingOperationModel = HousekeepingOperation,
    now = () => new Date(),
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const requestedOperationId = requiredText(operationId, "operationId")
    const roomId = requiredText(servicePointId, "servicePointId", 100)
    const items = normalizeExceptionItems(attemptedItems)
    if (items.some((item) => !Number.isFinite(item.quantity) || item.quantity <= 0)) {
        throw housekeepingError("Inventory exception quantities must be positive", "INVALID_HOUSEKEEPING_EXCEPTION")
    }
    const performedBy = normalizeHousekeepingActor(actor)
    const attemptFingerprint = fingerprint({ roomId, items })
    const timestamp = now()
    const operation = await HousekeepingOperationModel.findOne({
        businessId: tenantId,
        housekeepingOperationId: requestedOperationId,
        servicePointId: roomId,
        status: "cleaning",
        active: true,
    })
    if (!operation) throw housekeepingError("Active Housekeeping operation not found", "HOUSEKEEPING_OPERATION_NOT_FOUND", 404)
    if (!isManagementActor(performedBy) && operation.claimedBy !== performedBy.actorId) {
        throw housekeepingError("Only the current cleaner may report this discrepancy", "HOUSEKEEPING_CLAIM_REQUIRED", 403)
    }

    const sameAttempt = operation.inventoryException?.status === "unresolved" &&
        operation.inventoryException?.attemptFingerprint === attemptFingerprint
    const update = sameAttempt
        ? {
            $set: {
                "inventoryException.lastReportedAt": timestamp,
                "inventoryException.failureCode": requiredText(failureCode, "failureCode", 100),
                "inventoryException.failureMessage": requiredText(failureMessage, "failureMessage", 500),
            },
            $inc: { "inventoryException.attemptCount": 1 },
        }
        : {
            $set: {
                inventoryException: {
                    status: "unresolved",
                    attemptFingerprint,
                    attemptedItems: items,
                    failureCode: requiredText(failureCode, "failureCode", 100),
                    failureMessage: requiredText(failureMessage, "failureMessage", 500),
                    reportedBy: actorSnapshot(performedBy),
                    firstReportedAt: timestamp,
                    lastReportedAt: timestamp,
                    attemptCount: 1,
                    acknowledgedBy: null,
                    acknowledgedAt: null,
                    resolvedBy: null,
                    resolvedAt: null,
                    reconciliationMovementIds: [],
                    resolutionNote: null,
                },
            },
        }
    const updated = await HousekeepingOperationModel.findOneAndUpdate({
        _id: operation._id,
        businessId: tenantId,
        status: "cleaning",
        active: true,
        supplyOutcome: "pending",
    }, update, { new: true, runValidators: true })
    if (!updated) throw housekeepingError("Housekeeping state changed. Refresh and try again.", "HOUSEKEEPING_EXCEPTION_CONFLICT", 409)
    return { operation: operationDTO(updated), replayed: sameAttempt }
}

export async function acknowledgeHousekeepingInventoryException({
    businessId,
    operationId,
    actor,
    idempotencyKey = null,
}, {
    BusinessModel = Business,
    HousekeepingOperationModel = HousekeepingOperation,
    startSession = () => mongoose.startSession(),
    now = () => new Date(),
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const requestedOperationId = requiredText(operationId, "operationId")
    const performedBy = normalizeHousekeepingActor(actor)
    const commandKey = normalizeCommandKey(idempotencyKey)
    const requestFingerprint = fingerprint({ requestedOperationId, action: "acknowledge" })
    return withHousekeepingTransaction(async (session) => {
        await readLodgingBusiness(tenantId, session, BusinessModel)
        const operation = await readOperation({ businessId: tenantId, operationId: requestedOperationId, session, HousekeepingOperationModel })
        if (assertCommandReplay(operation.commandReceipts?.exceptionAcknowledgment, commandKey, requestFingerprint) ||
            operation.supplyOutcome === "inventory_exception_acknowledged") {
            return { operation: operationDTO(operation), replayed: true }
        }
        if (operation.status !== "cleaning" || operation.active !== true ||
            operation.supplyOutcome !== "pending" || operation.inventoryException?.status !== "unresolved") {
            throw housekeepingError("Inventory exception cannot be acknowledged", "HOUSEKEEPING_EXCEPTION_STATE_CONFLICT", 409)
        }
        const timestamp = now()
        const updated = await HousekeepingOperationModel.findOneAndUpdate({
            _id: operation._id,
            businessId: tenantId,
            status: "cleaning",
            active: true,
            supplyOutcome: "pending",
            "inventoryException.status": "unresolved",
            "inventoryException.acknowledgedAt": null,
        }, {
            $set: {
                supplyOutcome: "inventory_exception_acknowledged",
                "inventoryException.acknowledgedBy": actorSnapshot(performedBy),
                "inventoryException.acknowledgedAt": timestamp,
                ...receiptFields("exceptionAcknowledgment", commandKey, requestFingerprint, timestamp),
            },
        }, { new: true, runValidators: true, session })
        if (!updated) throw housekeepingError("Exception changed. Refresh and try again.", "HOUSEKEEPING_EXCEPTION_CONFLICT", 409)
        return { operation: operationDTO(updated), replayed: false }
    }, { startSession })
}

export async function resolveHousekeepingInventoryException({
    businessId,
    operationId,
    movementIds,
    resolutionNote = null,
    actor,
    idempotencyKey = null,
}, {
    BusinessModel = Business,
    HousekeepingOperationModel = HousekeepingOperation,
    InventoryMovementModel = InventoryMovement,
    startSession = () => mongoose.startSession(),
    now = () => new Date(),
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const requestedOperationId = requiredText(operationId, "operationId")
    const references = [...new Set((Array.isArray(movementIds) ? movementIds : []).map((value) => requiredText(value, "movementId", 100)))]
    if (references.length === 0 || references.length > 100) {
        throw housekeepingError("At least one canonical reconciliation movement is required", "INVALID_HOUSEKEEPING_EXCEPTION_RESOLUTION")
    }
    const note = optionalText(resolutionNote, "resolutionNote", 1000)
    const performedBy = normalizeHousekeepingActor(actor)
    const commandKey = normalizeCommandKey(idempotencyKey)
    const requestFingerprint = fingerprint({ requestedOperationId, references, note })
    return withHousekeepingTransaction(async (session) => {
        await readLodgingBusiness(tenantId, session, BusinessModel)
        const operation = await readOperation({ businessId: tenantId, operationId: requestedOperationId, session, HousekeepingOperationModel })
        if (assertCommandReplay(operation.commandReceipts?.exceptionResolution, commandKey, requestFingerprint) ||
            operation.inventoryException?.status === "resolved") {
            return { operation: operationDTO(operation), replayed: true }
        }
        if (operation.inventoryException?.status !== "unresolved") {
            throw housekeepingError("Unresolved Inventory exception not found", "HOUSEKEEPING_EXCEPTION_STATE_CONFLICT", 409)
        }
        const movements = await lean(InventoryMovementModel.find({
            businessId: tenantId,
            movementId: { $in: references },
            type: { $in: [...RECONCILIATION_TYPES] },
        }, null, { session })) || []
        if (movements.length !== references.length) {
            throw housekeepingError(
                "One or more canonical reconciliation movements were not found",
                "HOUSEKEEPING_RECONCILIATION_REFERENCE_INVALID",
                409,
            )
        }
        const timestamp = now()
        const updated = await HousekeepingOperationModel.findOneAndUpdate({
            _id: operation._id,
            businessId: tenantId,
            "inventoryException.status": "unresolved",
        }, {
            $set: {
                "inventoryException.status": "resolved",
                "inventoryException.resolvedBy": actorSnapshot(performedBy),
                "inventoryException.resolvedAt": timestamp,
                "inventoryException.reconciliationMovementIds": references,
                "inventoryException.resolutionNote": note,
                ...receiptFields("exceptionResolution", commandKey, requestFingerprint, timestamp),
            },
        }, { new: true, runValidators: true, session })
        if (!updated) throw housekeepingError("Exception changed. Refresh and try again.", "HOUSEKEEPING_EXCEPTION_CONFLICT", 409)
        return { operation: operationDTO(updated), replayed: false }
    }, { startSession })
}

function normalizeHistoryLimit(value) {
    if (value === undefined || value === null || value === "") return DEFAULT_HISTORY_PAGE
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1 || number > MAX_HISTORY_PAGE) {
        throw housekeepingError(`limit must be from 1 to ${MAX_HISTORY_PAGE}`, "INVALID_HOUSEKEEPING_HISTORY_QUERY")
    }
    return number
}

function decodeHistoryCursor(value, contextFingerprint) {
    if (!value) return null
    try {
        const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
        if (!parsed?.completedAt || !mongoose.isValidObjectId(parsed.id) || parsed.context !== contextFingerprint) throw new Error()
        const completedAt = new Date(parsed.completedAt)
        if (Number.isNaN(completedAt.getTime())) throw new Error()
        return { completedAt, id: new mongoose.Types.ObjectId(parsed.id) }
    } catch {
        throw housekeepingError("Invalid Housekeeping history cursor", "INVALID_HOUSEKEEPING_HISTORY_CURSOR")
    }
}

function encodeHistoryCursor(operation, contextFingerprint) {
    return Buffer.from(JSON.stringify({
        completedAt: new Date(operation.completedAt).toISOString(),
        id: String(operation._id),
        context: contextFingerprint,
    })).toString("base64url")
}

function optionalDate(value, field) {
    if (!value) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) throw housekeepingError(`${field} is invalid`, "INVALID_HOUSEKEEPING_HISTORY_QUERY")
    return date
}

export async function readHousekeepingHistory({
    businessId,
    servicePointId = null,
    staffId = null,
    from = null,
    to = null,
    cursor = null,
    limit = null,
}, {
    BusinessModel = Business,
    HousekeepingOperationModel = HousekeepingOperation,
    ServicePointModel = ServicePoint,
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    await readLodgingBusiness(tenantId, null, BusinessModel)
    const room = optionalText(servicePointId, "servicePointId", 100)
    const staff = optionalText(staffId, "staffId", 200)
    const fromDate = optionalDate(from, "from")
    const toDate = optionalDate(to, "to")
    if (fromDate && toDate && fromDate >= toDate) throw housekeepingError("from must precede to", "INVALID_HOUSEKEEPING_HISTORY_QUERY")
    const pageLimit = normalizeHistoryLimit(limit)
    const contextFingerprint = fingerprint({ tenantId, room, staff, from: fromDate?.toISOString() || null, to: toDate?.toISOString() || null })
    const decodedCursor = decodeHistoryCursor(cursor, contextFingerprint)
    const filter = { businessId: tenantId, status: "completed" }
    if (room) filter.servicePointId = room
    if (staff) filter.$or = [{ assignedTo: staff }, { claimedBy: staff }, { completedBy: staff }]
    if (fromDate || toDate) filter.completedAt = {
        ...(fromDate ? { $gte: fromDate } : {}),
        ...(toDate ? { $lt: toDate } : {}),
    }
    if (decodedCursor) {
        const cursorFilter = {
            $or: [
                { completedAt: { $lt: decodedCursor.completedAt } },
                { completedAt: decodedCursor.completedAt, _id: { $lt: decodedCursor.id } },
            ],
        }
        filter.$and = [cursorFilter]
    }
    let query = HousekeepingOperationModel.find(filter)
    if (typeof query?.sort === "function") query = query.sort({ completedAt: -1, _id: -1 })
    if (typeof query?.limit === "function") query = query.limit(pageLimit + 1)
    const rows = await lean(query) || []
    const hasNextPage = rows.length > pageLimit
    const visible = hasNextPage ? rows.slice(0, pageLimit) : rows
    const roomIds = [...new Set(visible.map((operation) => operation.servicePointId).filter(Boolean))]
    const roomRows = roomIds.length
        ? await lean(ServicePointModel.find({
            businessId: tenantId,
            servicePointId: { $in: roomIds },
            servicePointType: "room",
        })) || []
        : []
    const roomLabels = new Map(roomRows.map((room) => [room.servicePointId, room.label]))
    return {
        operations: visible.map((operation) => ({
            ...operationDTO(operation),
            servicePointLabel: roomLabels.get(operation.servicePointId) || operation.servicePointId,
        })),
        pagination: {
            limit: pageLimit,
            hasNextPage,
            nextCursor: hasNextPage && visible.length > 0
                ? encodeHistoryCursor(visible.at(-1), contextFingerprint)
                : null,
        },
    }
}
