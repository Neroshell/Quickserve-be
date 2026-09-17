import {
    completeHousekeepingOperation,
    HousekeepingDomainError,
    markNoSuppliesUsed,
    readHousekeepingRooms,
    startHousekeepingOperation,
} from "../services/housekeepingService.js"
import { publishHousekeepingChanged } from "../utils/sseManager.js"
import {
    acknowledgeHousekeepingInventoryException,
    assignHousekeepingOperation,
    listEligibleHousekeepers,
    readHousekeepingHistory,
    resolveHousekeepingInventoryException,
    setHousekeepingPriority,
    updateHousekeepingSettings,
} from "../services/housekeepingManagementService.js"

export function getHousekeepingActor(req) {
    const currentStaff = req.resolvedOperationalStaff || req.resolvedManagerStaff || req.resolvedCoOwnerStaff || null
    const sessionUser = req.session?.user || {}
    return {
        actorId: String(
            currentStaff?.staffId ||
            sessionUser.staffId ||
            sessionUser.userId ||
            sessionUser.id ||
            sessionUser.email ||
            "unknown",
        ),
        staffId: currentStaff?.staffId || sessionUser.staffId || null,
        name: currentStaff?.name || sessionUser.name || sessionUser.email || sessionUser.role || "Staff",
        role: currentStaff?.role || sessionUser.role || "staff",
        permissions: currentStaff?.permissions || sessionUser.permissions || [],
    }
}

function tenantId(req) {
    return req.session?.user?.businessId || null
}

function handleError(res, error) {
    if (error instanceof HousekeepingDomainError || Number.isInteger(error?.statusCode)) {
        return res.status(error.statusCode || 400).json({
            error: error.message,
            code: error.code || "HOUSEKEEPING_ERROR",
        })
    }
    console.error("[Housekeeping] Command failed", error)
    return res.status(500).json({ error: "Housekeeping action could not be completed" })
}

async function publishAfterCommit(req, businessId) {
    const publish = req.app?.locals?.publishHousekeepingChanged || publishHousekeepingChanged
    await publish({ businessId })
}

function idempotencyKey(req) {
    return req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"] || null
}

export async function listHousekeepingRooms(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        return res.json(await readHousekeepingRooms({
            businessId,
            actor: getHousekeepingActor(req),
        }))
    } catch (error) {
        return handleError(res, error)
    }
}

export async function startCleaning(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        const result = await startHousekeepingOperation({
            businessId,
            operationId: req.params.operationId,
            actor: getHousekeepingActor(req),
        })
        if (!result.replayed) await publishAfterCommit(req, businessId)
        return res.status(200).json(result)
    } catch (error) {
        return handleError(res, error)
    }
}

export async function setNoSuppliesUsed(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        const result = await markNoSuppliesUsed({
            businessId,
            operationId: req.params.operationId,
            actor: getHousekeepingActor(req),
        })
        if (!result.replayed) await publishAfterCommit(req, businessId)
        return res.status(200).json(result)
    } catch (error) {
        return handleError(res, error)
    }
}

export async function completeCleaning(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        const result = await completeHousekeepingOperation({
            businessId,
            operationId: req.params.operationId,
            actor: getHousekeepingActor(req),
        })
        if (!result.replayed) await publishAfterCommit(req, businessId)
        return res.status(200).json(result)
    } catch (error) {
        return handleError(res, error)
    }
}

export async function getEligibleHousekeepers(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        return res.json(await listEligibleHousekeepers({ businessId }))
    } catch (error) {
        return handleError(res, error)
    }
}

export async function assignCleaning(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        const result = await assignHousekeepingOperation({
            businessId,
            operationId: req.params.operationId,
            assigneeStaffId: req.body?.assigneeStaffId,
            expectedAssignedTo: req.body?.expectedAssignedTo ?? null,
            actor: getHousekeepingActor(req),
            idempotencyKey: idempotencyKey(req),
        })
        if (!result.replayed) await publishAfterCommit(req, businessId)
        return res.status(200).json(result)
    } catch (error) {
        return handleError(res, error)
    }
}

export async function changeCleaningPriority(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        const result = await setHousekeepingPriority({
            businessId,
            operationId: req.params.operationId,
            priority: req.body?.priority,
            expectedPriority: req.body?.expectedPriority || "normal",
            actor: getHousekeepingActor(req),
            idempotencyKey: idempotencyKey(req),
        })
        if (!result.replayed) await publishAfterCommit(req, businessId)
        return res.status(200).json(result)
    } catch (error) {
        return handleError(res, error)
    }
}

export async function listHousekeepingHistory(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        return res.json(await readHousekeepingHistory({
            businessId,
            servicePointId: req.query?.servicePointId,
            staffId: req.query?.staffId,
            from: req.query?.from,
            to: req.query?.to,
            cursor: req.query?.cursor,
            limit: req.query?.limit,
        }))
    } catch (error) {
        return handleError(res, error)
    }
}

export async function saveHousekeepingSettings(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        const result = await updateHousekeepingSettings({
            businessId,
            targetStartMinutes: req.body?.targetStartMinutes,
            targetCleaningMinutes: req.body?.targetCleaningMinutes,
        })
        await publishAfterCommit(req, businessId)
        return res.json(result)
    } catch (error) {
        return handleError(res, error)
    }
}

export async function acknowledgeInventoryException(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        const result = await acknowledgeHousekeepingInventoryException({
            businessId,
            operationId: req.params.operationId,
            actor: getHousekeepingActor(req),
            idempotencyKey: idempotencyKey(req),
        })
        if (!result.replayed) await publishAfterCommit(req, businessId)
        return res.json(result)
    } catch (error) {
        return handleError(res, error)
    }
}

export async function resolveInventoryException(req, res) {
    const businessId = tenantId(req)
    if (!businessId) return res.status(401).json({ error: "Unauthorized" })
    try {
        const result = await resolveHousekeepingInventoryException({
            businessId,
            operationId: req.params.operationId,
            movementIds: req.body?.movementIds,
            resolutionNote: req.body?.resolutionNote,
            actor: getHousekeepingActor(req),
            idempotencyKey: idempotencyKey(req),
        })
        if (!result.replayed) await publishAfterCommit(req, businessId)
        return res.json(result)
    } catch (error) {
        return handleError(res, error)
    }
}
