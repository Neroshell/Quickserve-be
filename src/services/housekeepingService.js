import mongoose from "mongoose"
import Business from "../models/Business.js"
import HousekeepingOperation, { generateHousekeepingOperationId } from "../models/HousekeepingOperation.js"
import Reservation from "../models/Reservation.js"
import ServicePoint from "../models/ServicePoint.js"
import { PERMISSIONS } from "../constants/permissions.js"
import { resolveBusinessCapabilities } from "./businessCapabilityService.js"

const MAX_TRANSACTION_ATTEMPTS = 3

export class HousekeepingDomainError extends Error {
    constructor(message, { code = "HOUSEKEEPING_ERROR", statusCode = 400 } = {}) {
        super(message)
        this.name = "HousekeepingDomainError"
        this.code = code
        this.statusCode = statusCode
    }
}

export function housekeepingError(message, code, statusCode = 400) {
    return new HousekeepingDomainError(message, { code, statusCode })
}

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

export function normalizeHousekeepingActor(actor) {
    const actorId = requiredText(
        actor?.staffId || actor?.actorId || actor?.userId,
        "actorId",
        200,
    )
    return {
        actorId,
        staffId: actor?.staffId ? String(actor.staffId) : null,
        name: actor?.name ? String(actor.name).trim().slice(0, 200) : null,
        role: actor?.role ? String(actor.role).trim().slice(0, 80) : null,
        permissions: Array.isArray(actor?.permissions) ? [...actor.permissions] : [],
    }
}

export function isManagementActor(actor) {
    return ["owner", "restaurant_owner", "admin", "co_owner", "manager"].includes(actor?.role)
}

function canPerformHousekeeping(actor) {
    if (["owner", "restaurant_owner", "admin", "co_owner"].includes(actor?.role)) return true
    return Array.isArray(actor?.permissions) && actor.permissions.includes(PERMISSIONS.HOUSEKEEPING_PERFORM)
}

function isTransientTransactionError(error) {
    return Boolean(
        error?.hasErrorLabel?.("TransientTransactionError") ||
        error?.hasErrorLabel?.("UnknownTransactionCommitResult"),
    )
}

export async function withHousekeepingTransaction(work, {
    startSession = () => mongoose.startSession(),
} = {}) {
    let lastError
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
        const session = await startSession()
        try {
            let result
            await session.withTransaction(async () => {
                result = await work(session)
            }, {
                readConcern: { level: "snapshot" },
                writeConcern: { w: "majority" },
                maxCommitTimeMS: 10_000,
            })
            return result
        } catch (error) {
            lastError = error
            if (!isTransientTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error
        } finally {
            await session.endSession()
        }
    }
    throw lastError
}

async function resolveLean(value) {
    return typeof value?.lean === "function" ? value.lean() : value
}

export function assertLodgingBusiness(business) {
    if (!business) throw housekeepingError("Business not found", "BUSINESS_NOT_FOUND", 404)
    const capabilities = resolveBusinessCapabilities(business)
    if (!capabilities.visibleModules.includes("lodging")) {
        throw housekeepingError("Housekeeping is not enabled for this business", "HOUSEKEEPING_NOT_ENABLED", 403)
    }
    return capabilities
}

function actorSnapshot(source, prefix) {
    if (!source?.[prefix]) return null
    return {
        staffId: source[prefix],
        name: source[`${prefix}Name`] || null,
        role: source[`${prefix}Role`] || null,
    }
}

function serializeInventoryException(value) {
    if (!value) return null
    const source = value.toObject ? value.toObject() : value
    return {
        status: source.status,
        attemptedItems: source.attemptedItems || [],
        failureCode: source.failureCode,
        failureMessage: source.failureMessage,
        reportedBy: source.reportedBy || null,
        firstReportedAt: source.firstReportedAt,
        lastReportedAt: source.lastReportedAt,
        attemptCount: source.attemptCount || 1,
        acknowledgedBy: source.acknowledgedBy || null,
        acknowledgedAt: source.acknowledgedAt || null,
        resolvedBy: source.resolvedBy || null,
        resolvedAt: source.resolvedAt || null,
        reconciliationMovementIds: source.reconciliationMovementIds || [],
        resolutionNote: source.resolutionNote || null,
    }
}

export function operationDTO(operation, {
    now = new Date(),
    targetStartMinutes = null,
    targetCleaningMinutes = null,
} = {}) {
    if (!operation) return null
    const source = operation.toObject ? operation.toObject() : operation
    return {
        housekeepingOperationId: source.housekeepingOperationId,
        servicePointId: source.servicePointId,
        operationType: source.operationType,
        triggerType: source.triggerType,
        status: source.status,
        active: source.active,
        priority: source.priority || "normal",
        assignedTo: source.assignedTo || null,
        assignedToName: source.assignedToName || null,
        assignedToRole: source.assignedToRole || null,
        assignedAt: source.assignedAt || null,
        assignedBy: source.assignedBy || null,
        assignedByName: source.assignedByName || null,
        assignedByRole: source.assignedByRole || null,
        assignmentHistory: source.assignmentHistory || [],
        claimedBy: source.claimedBy || null,
        claimedByName: source.claimedByName || null,
        claimedByRole: source.claimedByRole || null,
        startedAt: source.startedAt || null,
        completedBy: source.completedBy || null,
        completedByName: source.completedByName || null,
        completedByRole: source.completedByRole || null,
        completedAt: source.completedAt || null,
        supplyOutcome: source.supplyOutcome,
        roomUsageOperationId: source.roomUsageOperationId || null,
        inventoryException: serializeInventoryException(source.inventoryException),
        note: source.note || null,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
        timing: (() => {
            const current = new Date(now).getTime()
            const created = source.createdAt ? new Date(source.createdAt).getTime() : null
            const started = source.startedAt ? new Date(source.startedAt).getTime() : null
            const completed = source.completedAt ? new Date(source.completedAt).getTime() : null
            const waitingSeconds = created === null
                ? null
                : Math.max(0, Math.floor(((started ?? current) - created) / 1000))
            const cleaningSeconds = started === null
                ? null
                : Math.max(0, Math.floor(((completed ?? current) - started) / 1000))
            const waitingOverdue = source.status === "needs_cleaning" && Number.isInteger(targetStartMinutes)
                ? waitingSeconds > targetStartMinutes * 60
                : false
            const cleaningOverdue = source.status === "cleaning" && Number.isInteger(targetCleaningMinutes)
                ? cleaningSeconds > targetCleaningMinutes * 60
                : false
            return { waitingSeconds, cleaningSeconds, waitingOverdue, cleaningOverdue }
        })(),
    }
}

function actorFields(prefix, actor) {
    return {
        [prefix]: actor.actorId,
        [`${prefix}Name`]: actor.name,
        [`${prefix}Role`]: actor.role,
    }
}

function isDuplicateKeyError(error) {
    return error?.code === 11000
}

export async function checkoutReservationIntoHousekeeping({
    businessId,
    reservationId,
    actor,
    reservationActor,
}, {
    BusinessModel = Business,
    HousekeepingOperationModel = HousekeepingOperation,
    ReservationModel = Reservation,
    ServicePointModel = ServicePoint,
    startSession = () => mongoose.startSession(),
    now = () => new Date(),
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const bookingId = requiredText(String(reservationId || ""), "reservationId")
    const performedBy = normalizeHousekeepingActor(actor)

    const execute = async (session) => {
        const reservation = await ReservationModel.findOne({
            _id: bookingId,
            businessId: tenantId,
        }, null, { session })
        if (!reservation) throw housekeepingError("Reservation not found", "RESERVATION_NOT_FOUND", 404)

        const triggerId = String(reservation._id)
        if (reservation.status === "checked_out") {
            const existingOperation = await HousekeepingOperationModel.findOne({
                businessId: tenantId,
                triggerType: "reservation_checkout",
                triggerId,
            }, null, { session })
            if (!existingOperation) {
                throw housekeepingError(
                    "This historical checkout has no canonical housekeeping operation",
                    "HISTORICAL_CHECKOUT_WITHOUT_HOUSEKEEPING",
                    409,
                )
            }
            return { reservation, operation: existingOperation, replayed: true }
        }
        if (reservation.status !== "checked_in") {
            throw housekeepingError(
                `Invalid reservation transition: ${reservation.status} -> checked_out`,
                "INVALID_CHECKOUT_TRANSITION",
                409,
            )
        }

        const [business, room] = await Promise.all([
            resolveLean(BusinessModel.findOne({ businessId: tenantId }, null, { session })),
            resolveLean(ServicePointModel.findOne({
                businessId: tenantId,
                servicePointId: reservation.servicePointId,
                servicePointType: "room",
            }, null, { session })),
        ])
        assertLodgingBusiness(business)
        if (!room) throw housekeepingError("Reservation room not found", "ROOM_SERVICE_POINT_NOT_FOUND", 409)

        const changedAt = now()
        const housekeepingOperationId = generateHousekeepingOperationId({
            businessId: tenantId,
            triggerType: "reservation_checkout",
            triggerId,
        })
        const created = await HousekeepingOperationModel.create([{
            housekeepingOperationId,
            businessId: tenantId,
            servicePointId: room.servicePointId,
            operationType: "checkout_turnover",
            triggerType: "reservation_checkout",
            triggerId,
            status: "needs_cleaning",
            active: true,
            supplyOutcome: "pending",
        }], { session })
        const operation = created[0]

        const updatedRoom = await ServicePointModel.findOneAndUpdate({
            businessId: tenantId,
            servicePointId: room.servicePointId,
            servicePointType: "room",
            $or: [
                { "roomReadiness.state": "ready" },
                { roomReadiness: { $exists: false } },
                { roomReadiness: null },
            ],
        }, {
            $set: {
                roomReadiness: {
                    state: "needs_cleaning",
                    operationId: housekeepingOperationId,
                    changedAt,
                    changedBy: performedBy.actorId,
                },
            },
        }, { new: true, runValidators: true, session })
        if (!updatedRoom) {
            throw housekeepingError(
                "Room already has unresolved housekeeping work",
                "ROOM_HOUSEKEEPING_CONFLICT",
                409,
            )
        }

        const updatedReservation = await ReservationModel.findOneAndUpdate({
            _id: reservation._id,
            businessId: tenantId,
            status: "checked_in",
            activeRefundId: null,
        }, {
            $set: {
                status: "checked_out",
                checkedOutAt: changedAt,
                ...(reservationActor ? { checkedOutBy: reservationActor } : {}),
            },
        }, { new: true, runValidators: true, session })
        if (!updatedReservation) {
            throw housekeepingError(
                "The reservation was updated elsewhere. Refresh and try again.",
                "CHECKOUT_CONFLICT",
                409,
            )
        }

        return { reservation: updatedReservation, operation, replayed: false }
    }

    try {
        return await withHousekeepingTransaction(execute, { startSession })
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error
        const [reservation, operation] = await Promise.all([
            ReservationModel.findOne({ _id: bookingId, businessId: tenantId }),
            HousekeepingOperationModel.findOne({
                businessId: tenantId,
                triggerType: "reservation_checkout",
                triggerId: bookingId,
            }),
        ])
        if (reservation?.status === "checked_out" && operation) {
            return { reservation, operation, replayed: true }
        }
        const activeRoomOperation = reservation?.servicePointId
            ? await HousekeepingOperationModel.findOne({
                businessId: tenantId,
                servicePointId: reservation.servicePointId,
                active: true,
            })
            : null
        if (activeRoomOperation) {
            throw housekeepingError(
                "Room already has unresolved housekeeping work",
                "ROOM_HOUSEKEEPING_CONFLICT",
                409,
            )
        }
        throw error
    }
}

async function readBusinessAndOperation({ tenantId, operationId, session, BusinessModel, HousekeepingOperationModel }) {
    // MongoDB transactions do not support parallel operations on one session.
    // Keep these reads sequential so command endpoints cannot fail
    // nondeterministically with transaction-state errors.
    const business = await resolveLean(BusinessModel.findOne({ businessId: tenantId }, null, { session }))
    const operation = await HousekeepingOperationModel.findOne({
        businessId: tenantId,
        housekeepingOperationId: operationId,
    }, null, { session })
    assertLodgingBusiness(business)
    if (!operation) throw housekeepingError("Housekeeping operation not found", "HOUSEKEEPING_OPERATION_NOT_FOUND", 404)
    return operation
}

export async function startHousekeepingOperation({ businessId, operationId, actor }, {
    BusinessModel = Business,
    HousekeepingOperationModel = HousekeepingOperation,
    ServicePointModel = ServicePoint,
    startSession = () => mongoose.startSession(),
    now = () => new Date(),
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const requestedOperationId = requiredText(operationId, "operationId")
    const performedBy = normalizeHousekeepingActor(actor)

    return withHousekeepingTransaction(async (session) => {
        const operation = await readBusinessAndOperation({
            tenantId,
            operationId: requestedOperationId,
            session,
            BusinessModel,
            HousekeepingOperationModel,
        })
        if (operation.status === "cleaning") {
            if (operation.claimedBy === performedBy.actorId) {
                return { operation: operationDTO(operation), replayed: true }
            }
            throw housekeepingError("This room is already being cleaned", "HOUSEKEEPING_ALREADY_CLAIMED", 409)
        }
        if (operation.status !== "needs_cleaning" || operation.active !== true) {
            throw housekeepingError("Housekeeping operation cannot be started", "HOUSEKEEPING_STATE_CONFLICT", 409)
        }
        if (operation.assignedTo && operation.assignedTo !== performedBy.actorId) {
            throw housekeepingError(
                "This room is assigned to another housekeeper",
                "HOUSEKEEPING_ASSIGNED_TO_ANOTHER_STAFF_MEMBER",
                409,
            )
        }

        const changedAt = now()
        const updatedOperation = await HousekeepingOperationModel.findOneAndUpdate({
            _id: operation._id,
            businessId: tenantId,
            status: "needs_cleaning",
            active: true,
            claimedBy: null,
            $or: [
                { assignedTo: null },
                { assignedTo: { $exists: false } },
                { assignedTo: performedBy.actorId },
            ],
        }, {
            $set: {
                status: "cleaning",
                ...actorFields("claimedBy", performedBy),
                startedAt: changedAt,
            },
        }, { new: true, runValidators: true, session })
        if (!updatedOperation) {
            throw housekeepingError("This room was claimed by someone else", "HOUSEKEEPING_ALREADY_CLAIMED", 409)
        }

        const updatedRoom = await ServicePointModel.findOneAndUpdate({
            businessId: tenantId,
            servicePointId: operation.servicePointId,
            servicePointType: "room",
            isActive: true,
            "roomReadiness.state": "needs_cleaning",
            "roomReadiness.operationId": requestedOperationId,
        }, {
            $set: {
                roomReadiness: {
                    state: "cleaning",
                    operationId: requestedOperationId,
                    changedAt,
                    changedBy: performedBy.actorId,
                },
            },
        }, { new: true, runValidators: true, session })
        if (!updatedRoom) {
            throw housekeepingError("Room readiness changed. Refresh and try again.", "ROOM_READINESS_CONFLICT", 409)
        }
        return { operation: operationDTO(updatedOperation), replayed: false }
    }, { startSession })
}

function assertOperationActor(operation, actor) {
    if (operation.claimedBy === actor.actorId || isManagementActor(actor)) return
    throw housekeepingError("Only the current cleaner or authorized management may perform this action", "HOUSEKEEPING_CLAIM_REQUIRED", 403)
}

export async function markNoSuppliesUsed({ businessId, operationId, actor }, {
    BusinessModel = Business,
    HousekeepingOperationModel = HousekeepingOperation,
    startSession = () => mongoose.startSession(),
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const requestedOperationId = requiredText(operationId, "operationId")
    const performedBy = normalizeHousekeepingActor(actor)
    return withHousekeepingTransaction(async (session) => {
        const operation = await readBusinessAndOperation({
            tenantId,
            operationId: requestedOperationId,
            session,
            BusinessModel,
            HousekeepingOperationModel,
        })
        if (operation.status !== "cleaning" || operation.active !== true) {
            throw housekeepingError("Only active cleaning work can record a supply outcome", "HOUSEKEEPING_STATE_CONFLICT", 409)
        }
        assertOperationActor(operation, performedBy)
        if (operation.supplyOutcome === "no_supplies_used") {
            return { operation: operationDTO(operation), replayed: true }
        }
        if (operation.supplyOutcome !== "pending") {
            throw housekeepingError("Supplies have already been recorded", "HOUSEKEEPING_SUPPLY_OUTCOME_CONFLICT", 409)
        }
        const updated = await HousekeepingOperationModel.findOneAndUpdate({
            _id: operation._id,
            businessId: tenantId,
            status: "cleaning",
            active: true,
            supplyOutcome: "pending",
        }, { $set: { supplyOutcome: "no_supplies_used", roomUsageOperationId: null } }, {
            new: true,
            runValidators: true,
            session,
        })
        if (!updated) throw housekeepingError("Supply outcome changed. Refresh and try again.", "HOUSEKEEPING_SUPPLY_OUTCOME_CONFLICT", 409)
        return { operation: operationDTO(updated), replayed: false }
    }, { startSession })
}

export async function completeHousekeepingOperation({ businessId, operationId, actor }, {
    BusinessModel = Business,
    HousekeepingOperationModel = HousekeepingOperation,
    ServicePointModel = ServicePoint,
    startSession = () => mongoose.startSession(),
    now = () => new Date(),
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const requestedOperationId = requiredText(operationId, "operationId")
    const performedBy = normalizeHousekeepingActor(actor)
    return withHousekeepingTransaction(async (session) => {
        const operation = await readBusinessAndOperation({
            tenantId,
            operationId: requestedOperationId,
            session,
            BusinessModel,
            HousekeepingOperationModel,
        })
        if (operation.status === "completed" && operation.active === false) {
            return { operation: operationDTO(operation), replayed: true }
        }
        if (operation.status !== "cleaning" || operation.active !== true) {
            throw housekeepingError("Housekeeping operation cannot be completed", "HOUSEKEEPING_STATE_CONFLICT", 409)
        }
        assertOperationActor(operation, performedBy)
        const acknowledgedInventoryException = operation.supplyOutcome === "inventory_exception_acknowledged" &&
            operation.inventoryException?.status === "unresolved" &&
            operation.inventoryException?.acknowledgedAt
        if (!["recorded", "no_supplies_used"].includes(operation.supplyOutcome) && !acknowledgedInventoryException) {
            throw housekeepingError(
                "Confirm supplies used or explicitly choose no supplies used before completing",
                "HOUSEKEEPING_SUPPLY_OUTCOME_REQUIRED",
                409,
            )
        }

        const changedAt = now()
        const updatedOperation = await HousekeepingOperationModel.findOneAndUpdate({
            _id: operation._id,
            businessId: tenantId,
            status: "cleaning",
            active: true,
        }, {
            $set: {
                status: "completed",
                active: false,
                ...actorFields("completedBy", performedBy),
                completedAt: changedAt,
            },
        }, { new: true, runValidators: true, session })
        if (!updatedOperation) throw housekeepingError("Cleaning was completed elsewhere", "HOUSEKEEPING_STATE_CONFLICT", 409)

        const updatedRoom = await ServicePointModel.findOneAndUpdate({
            businessId: tenantId,
            servicePointId: operation.servicePointId,
            servicePointType: "room",
            "roomReadiness.state": "cleaning",
            "roomReadiness.operationId": requestedOperationId,
        }, {
            $set: {
                roomReadiness: {
                    state: "ready",
                    operationId: null,
                    changedAt,
                    changedBy: performedBy.actorId,
                },
            },
        }, { new: true, runValidators: true, session })
        if (!updatedRoom) throw housekeepingError("Room readiness changed. Refresh and try again.", "ROOM_READINESS_CONFLICT", 409)
        return { operation: operationDTO(updatedOperation), replayed: false }
    }, { startSession })
}

function allowedActions({ room, operation, actor }) {
    const management = isManagementActor(actor)
    const ownsClaim = operation?.claimedBy === actor.actorId
    const hasPerformPermission = canPerformHousekeeping(actor)
    const canActOnCleaning = Boolean(hasPerformPermission && operation && (ownsClaim || management))
    return {
        start: Boolean(
            hasPerformPermission &&
            room.isActive &&
            operation?.active &&
            operation.status === "needs_cleaning" &&
            (!operation.assignedTo || operation.assignedTo === actor.actorId)
        ),
        serviceRoom: Boolean(canActOnCleaning && operation.status === "cleaning"),
        noSuppliesUsed: Boolean(canActOnCleaning && operation.status === "cleaning" && operation.supplyOutcome === "pending"),
        complete: Boolean(
            canActOnCleaning &&
            operation.status === "cleaning" &&
            (
                ["recorded", "no_supplies_used"].includes(operation.supplyOutcome) ||
                (
                    operation.supplyOutcome === "inventory_exception_acknowledged" &&
                    operation.inventoryException?.status === "unresolved" &&
                    operation.inventoryException?.acknowledgedAt
                )
            )
        ),
    }
}

export async function readHousekeepingRooms({ businessId, actor }, {
    BusinessModel = Business,
    HousekeepingOperationModel = HousekeepingOperation,
    ServicePointModel = ServicePoint,
} = {}) {
    const tenantId = requiredText(businessId, "businessId")
    const performedBy = normalizeHousekeepingActor(actor)
    const business = await resolveLean(BusinessModel.findOne({ businessId: tenantId }))
    assertLodgingBusiness(business)
    const settings = {
        targetStartMinutes: Number.isInteger(business?.housekeepingSettings?.targetStartMinutes)
            ? business.housekeepingSettings.targetStartMinutes
            : null,
        targetCleaningMinutes: Number.isInteger(business?.housekeepingSettings?.targetCleaningMinutes)
            ? business.housekeepingSettings.targetCleaningMinutes
            : null,
    }
    const currentTime = new Date()

    let roomQuery = ServicePointModel.find({ businessId: tenantId, servicePointType: "room" })
    if (typeof roomQuery?.sort === "function") roomQuery = roomQuery.sort({ label: 1, servicePointId: 1 })
    const rooms = await resolveLean(roomQuery) || []
    const roomIds = rooms.map((room) => room.servicePointId)
    const activeOperations = roomIds.length
        ? await resolveLean(HousekeepingOperationModel.find({
            businessId: tenantId,
            servicePointId: { $in: roomIds },
            active: true,
        })) || []
        : []
    const activeByRoom = new Map(activeOperations.map((operation) => [operation.servicePointId, operation]))

    const metricsSince = new Date(currentTime.getTime() - (30 * 24 * 60 * 60 * 1000))
    let completedMetricsQuery = HousekeepingOperationModel.find({
        businessId: tenantId,
        status: "completed",
        completedAt: { $gte: metricsSince },
    })
    if (typeof completedMetricsQuery?.sort === "function") completedMetricsQuery = completedMetricsQuery.sort({ completedAt: -1, _id: -1 })
    if (typeof completedMetricsQuery?.limit === "function") completedMetricsQuery = completedMetricsQuery.limit(501)
    const completedForMetrics = await resolveLean(completedMetricsQuery) || []
    const unresolvedInventoryExceptions = typeof HousekeepingOperationModel.countDocuments === "function"
        ? await HousekeepingOperationModel.countDocuments({
            businessId: tenantId,
            "inventoryException.status": "unresolved",
        })
        : null

    let latestCompleted = []
    if (roomIds.length && typeof HousekeepingOperationModel.aggregate === "function") {
        latestCompleted = await HousekeepingOperationModel.aggregate([
            { $match: { businessId: tenantId, servicePointId: { $in: roomIds }, status: "completed" } },
            { $sort: { completedAt: -1, createdAt: -1 } },
            { $group: { _id: "$servicePointId", operation: { $first: "$$ROOT" } } },
        ])
    }
    const latestCompletedByRoom = new Map(latestCompleted.map((entry) => [entry._id, entry.operation]))

    const rows = rooms.map((room) => {
        const readiness = room.roomReadiness?.state || "ready"
        const currentOperation = activeByRoom.get(room.servicePointId) || null
        const displayOperation = currentOperation || latestCompletedByRoom.get(room.servicePointId) || null
        return {
            servicePointId: room.servicePointId,
            label: room.label,
            roomType: room.roomType || null,
            isActive: room.isActive !== false,
            readiness,
            operation: operationDTO(displayOperation, { now: currentTime, ...settings }),
            allowedActions: allowedActions({ room, operation: currentOperation, actor: performedBy }),
        }
    })
    const priorityRank = { urgent: 0, priority: 1, normal: 2 }
    rows.sort((left, right) => {
        const leftOperation = left.operation
        const rightOperation = right.operation
        if (performedBy.role === "housekeeping") {
            const workGroup = (operation) => operation?.active
                ? operation.assignedTo === performedBy.actorId ? 0 : operation.assignedTo ? 2 : 1
                : 3
            const groupDifference = workGroup(leftOperation) - workGroup(rightOperation)
            if (groupDifference) return groupDifference
        }
        const priorityDifference = (priorityRank[leftOperation?.priority || "normal"] ?? 2) -
            (priorityRank[rightOperation?.priority || "normal"] ?? 2)
        if (priorityDifference) return priorityDifference
        const leftCreated = leftOperation?.createdAt ? new Date(leftOperation.createdAt).getTime() : Number.MAX_SAFE_INTEGER
        const rightCreated = rightOperation?.createdAt ? new Date(rightOperation.createdAt).getTime() : Number.MAX_SAFE_INTEGER
        if (leftCreated !== rightCreated) return leftCreated - rightCreated
        return String(left.servicePointId).localeCompare(String(right.servicePointId))
    })

    const counts = { needs_cleaning: 0, cleaning: 0, ready: 0 }
    for (const room of rows) counts[room.readiness] += 1
    const overview = {
        ...counts,
        unassigned: rows.filter((room) => room.operation?.active && room.operation.status === "needs_cleaning" && !room.operation.assignedTo).length,
        assignedNotStarted: rows.filter((room) => room.operation?.active && room.operation.status === "needs_cleaning" && room.operation.assignedTo).length,
        overdueWaiting: rows.filter((room) => room.operation?.timing?.waitingOverdue).length,
        overdueCleaning: rows.filter((room) => room.operation?.timing?.cleaningOverdue).length,
        inventoryExceptions: Number.isInteger(unresolvedInventoryExceptions)
            ? unresolvedInventoryExceptions
            : rows.filter((room) => room.operation?.inventoryException?.status === "unresolved").length,
        completedTurnovers: Math.min(completedForMetrics.length, 500),
        averageTimeToStartSeconds: (() => {
            const values = completedForMetrics.slice(0, 500)
                .filter((operation) => operation.createdAt && operation.startedAt)
                .map((operation) => Math.max(0, (new Date(operation.startedAt) - new Date(operation.createdAt)) / 1000))
            return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
        })(),
        averageCleaningDurationSeconds: (() => {
            const values = completedForMetrics.slice(0, 500)
                .filter((operation) => operation.startedAt && operation.completedAt)
                .map((operation) => Math.max(0, (new Date(operation.completedAt) - new Date(operation.startedAt)) / 1000))
            return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
        })(),
        metricsWindowDays: 30,
        metricsTruncated: completedForMetrics.length > 500,
    }
    return { counts, overview, settings, rooms: rows }
}
