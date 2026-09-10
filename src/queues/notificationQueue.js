import { createQueue } from "./createQueue.js"
import { NOTIFICATION_JOB_NAMES, QUEUE_NAMES } from "./queueNames.js"

export const NOTIFICATION_JOB_OPTIONS = Object.freeze({
    attempts: 8,
    backoff: Object.freeze({ type: "exponential", delay: 15_000 }),
})

export function isNotificationQueueEnabled(env = process.env) {
    return env.BULLMQ_NOTIFICATIONS_ENABLED === "true"
}

function requiredId(value, field) {
    const normalized = String(value || "").trim()
    if (!normalized || normalized.length > 200) {
        throw new TypeError(`${field} is required`)
    }
    return normalized
}

function safeJobIdPart(value) {
    const safe = requiredId(value, "job ID component")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120)
    if (!safe) throw new TypeError("A safe job ID component is required")
    return safe
}

export function validateNotificationIntentPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("Notification intent payload must be an object")
    }
    return {
        businessId: requiredId(payload.businessId, "businessId"),
        intentId: requiredId(payload.intentId, "intentId"),
    }
}

export function buildNotificationIntentJobId(payload) {
    const data = validateNotificationIntentPayload(payload)
    return `notification-intent-${safeJobIdPart(data.businessId)}-${safeJobIdPart(data.intentId)}`
}

export async function enqueueNotificationIntent(payload, {
    env = process.env,
    queue,
    repair = false,
} = {}) {
    if (!isNotificationQueueEnabled(env)) {
        return { queued: false, reason: "notification_queue_disabled" }
    }
    const data = validateNotificationIntentPayload(payload)
    const notificationQueue = queue || createQueue(QUEUE_NAMES.NOTIFICATIONS, { env })
    const jobId = buildNotificationIntentJobId(data)

    if (repair && typeof notificationQueue.getJob === "function") {
        const existing = await notificationQueue.getJob(jobId)
        if (existing) {
            const state = typeof existing.getState === "function"
                ? await existing.getState()
                : null
            if (state === "failed" && typeof existing.retry === "function") {
                await existing.retry()
                return { queued: true, jobId, repaired: true }
            }
            if (state === "completed" && typeof existing.remove === "function") {
                await existing.remove()
            } else {
                return { queued: true, jobId, existing: true }
            }
        }
    }

    const job = await notificationQueue.add(
        NOTIFICATION_JOB_NAMES.PROCESS_INTENT,
        data,
        { jobId, ...NOTIFICATION_JOB_OPTIONS },
    )
    return { queued: true, jobId: job.id }
}

