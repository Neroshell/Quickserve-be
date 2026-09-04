import { createQueue } from "./createQueue.js"
import { INVENTORY_JOB_NAMES, QUEUE_NAMES } from "./queueNames.js"

export const INVENTORY_JOB_OPTIONS = Object.freeze({
    attempts: 5,
    backoff: Object.freeze({ type: "exponential", delay: 10_000 }),
})

export function isInventorySchedulersEnabled(env = process.env) {
    return env.BULLMQ_INVENTORY_SCHEDULERS_ENABLED === "true"
}

function requiredId(value, field) {
    const normalized = String(value || "").trim()
    if (!normalized || normalized.length > 200) throw new TypeError(`${field} is required`)
    return normalized
}

function safeJobIdPart(value) {
    const normalized = requiredId(value, "job ID component")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120)
    if (!normalized) throw new TypeError("A safe job ID component is required")
    return normalized
}

export function validateInventoryReconciliationPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("Inventory reconciliation payload must be an object")
    }
    const runAt = new Date(payload.runAt)
    if (Number.isNaN(runAt.getTime())) throw new TypeError("runAt must be a valid date")
    return {
        businessId: requiredId(payload.businessId, "businessId"),
        reservationId: requiredId(payload.reservationId, "reservationId"),
        runAt: runAt.toISOString(),
    }
}

export function buildInventoryReconciliationJobId(payload) {
    const data = validateInventoryReconciliationPayload(payload)
    return [
        "inventory-reconcile",
        safeJobIdPart(data.businessId),
        safeJobIdPart(data.reservationId),
        new Date(data.runAt).getTime(),
    ].join("-")
}

export async function enqueueInventoryReservationReconciliation(
    payload,
    { env = process.env, queue, now = new Date() } = {},
) {
    if (!isInventorySchedulersEnabled(env)) {
        return { queued: false, reason: "inventory_schedulers_disabled" }
    }
    const data = validateInventoryReconciliationPayload(payload)
    const inventoryQueue = queue || createQueue(QUEUE_NAMES.INVENTORY, { env })
    const jobId = buildInventoryReconciliationJobId(data)
    const delay = Math.max(0, new Date(data.runAt).getTime() - now.getTime())
    const job = await inventoryQueue.add(
        INVENTORY_JOB_NAMES.RECONCILE_RESERVATION,
        data,
        { jobId, delay, ...INVENTORY_JOB_OPTIONS },
    )
    return { queued: true, jobId: job.id, delay }
}

