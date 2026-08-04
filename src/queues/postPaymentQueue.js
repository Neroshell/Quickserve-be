import { createQueue } from "./createQueue.js";
import { POST_PAYMENT_JOB_NAMES, QUEUE_NAMES } from "./queueNames.js";

export const POST_PAYMENT_JOB_OPTIONS = Object.freeze({
    attempts: 8,
    backoff: Object.freeze({ type: "exponential", delay: 15_000 }),
});

export function isPostPaymentQueueEnabled(env = process.env) {
    return env.BULLMQ_POST_PAYMENT_ENABLED === "true";
}

function requiredId(value, field) {
    const normalized = String(value || "").trim();
    if (!normalized || normalized.length > 200) {
        throw new TypeError(`${field} is required`);
    }
    return normalized;
}

function safeJobIdPart(value) {
    const safe = requiredId(value, "job ID component")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120);
    if (!safe) throw new TypeError("A safe job ID component is required");
    return safe;
}

export function validateCrmOrderPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("CRM order payload must be an object");
    }
    return {
        businessId: requiredId(payload.businessId, "businessId"),
        orderId: requiredId(payload.orderId, "orderId"),
    };
}

export function buildCrmOrderJobId(payload) {
    const data = validateCrmOrderPayload(payload);
    return `postpayment-crm-order-${safeJobIdPart(data.businessId)}-${safeJobIdPart(data.orderId)}`;
}

export async function enqueueCrmOrder(
    payload,
    { env = process.env, queue, repair = false } = {},
) {
    if (!isPostPaymentQueueEnabled(env)) {
        return { queued: false, reason: "post_payment_queue_disabled" };
    }
    const data = validateCrmOrderPayload(payload);
    const postPaymentQueue = queue || createQueue(QUEUE_NAMES.POST_PAYMENT, { env });
    const jobId = buildCrmOrderJobId(data);
    if (repair && typeof postPaymentQueue.getJob === "function") {
        const existing = await postPaymentQueue.getJob(jobId);
        if (existing) {
            const state = typeof existing.getState === "function"
                ? await existing.getState()
                : null;
            if (state === "failed" && typeof existing.retry === "function") {
                await existing.retry();
                return { queued: true, jobId, repaired: true };
            }
            if (state === "completed" && typeof existing.remove === "function") {
                await existing.remove();
            } else {
                return { queued: true, jobId, existing: true };
            }
        }
    }
    const job = await postPaymentQueue.add(
        POST_PAYMENT_JOB_NAMES.CRM_ORDER,
        data,
        { jobId, ...POST_PAYMENT_JOB_OPTIONS },
    );
    return { queued: true, jobId: job.id };
}
