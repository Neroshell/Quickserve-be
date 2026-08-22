import { createQueue } from "./createQueue.js"
import { AI_ANALYST_JOB_NAMES, QUEUE_NAMES } from "./queueNames.js"

export const AI_ANALYST_JOB_OPTIONS = Object.freeze({
    [AI_ANALYST_JOB_NAMES.WEEKLY_SCAN]: {
        attempts: 3,
        backoff: Object.freeze({ type: "exponential", delay: 60_000 }),
    },
    [AI_ANALYST_JOB_NAMES.GENERATE_REPORT]: {
        attempts: 3,
        backoff: Object.freeze({ type: "exponential", delay: 30_000 }),
    },
})

export function isAiAnalystWeeklyEnabled(env = process.env) {
    return env.AI_ANALYST_WEEKLY_ENABLED === "true"
}

function safeJobIdPart(value) {
    const normalized = String(value || "")
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 150)
    if (!normalized) throw new TypeError("A safe job ID component is required")
    return normalized
}

/**
 * Deterministic job ID: ai-analyst:<businessId>:<periodKey>
 */
export function buildAiAnalystJobId(businessId, periodKey) {
    return [
        "ai-analyst",
        safeJobIdPart(businessId),
        safeJobIdPart(periodKey),
    ].join("-")
}

export function validateAiAnalystScanPayload(payload = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("AI analyst scan payload must be an object")
    }
    return {}
}

export function validateAiAnalystGeneratePayload(payload = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("AI analyst generate payload must be an object")
    }
    const businessId = String(payload.businessId || "").trim()
    const periodKey = String(payload.periodKey || "").trim()
    if (!businessId || businessId.length > 200) {
        throw new TypeError("businessId is required")
    }
    if (!periodKey || !/^\d{4}-W\d{2}$/.test(periodKey)) {
        throw new TypeError("periodKey is required (YYYY-Www)")
    }
    return { businessId, periodKey }
}

export async function enqueueAiAnalystScan(
    payload = {},
    { env = process.env, queue } = {},
) {
    if (!isAiAnalystWeeklyEnabled(env)) {
        return { queued: false, reason: "ai_analyst_weekly_disabled" }
    }
    const data = validateAiAnalystScanPayload(payload)
    const aiQueue = queue || createQueue(QUEUE_NAMES.AI_ANALYST, { env })
    const job = await aiQueue.add(AI_ANALYST_JOB_NAMES.WEEKLY_SCAN, data, {
        jobId: "ai-analyst-weekly-scan",
        ...AI_ANALYST_JOB_OPTIONS[AI_ANALYST_JOB_NAMES.WEEKLY_SCAN],
    })
    return { queued: true, jobId: job.id }
}

export async function enqueueAiAnalystGenerate(
    payload,
    { env = process.env, queue } = {},
) {
    if (!isAiAnalystWeeklyEnabled(env)) {
        return { queued: false, reason: "ai_analyst_weekly_disabled" }
    }
    const data = validateAiAnalystGeneratePayload(payload)
    const jobId = buildAiAnalystJobId(data.businessId, data.periodKey)
    const aiQueue = queue || createQueue(QUEUE_NAMES.AI_ANALYST, { env })
    const job = await aiQueue.add(
        AI_ANALYST_JOB_NAMES.GENERATE_REPORT,
        data,
        {
            jobId,
            ...AI_ANALYST_JOB_OPTIONS[
            AI_ANALYST_JOB_NAMES.GENERATE_REPORT
            ],
        },
    )
    return { queued: true, jobId: job.id }
}