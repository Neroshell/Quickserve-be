import { createQueue } from "./createQueue.js";
import { BILLING_JOB_NAMES, QUEUE_NAMES } from "./queueNames.js";

const PER_BUSINESS_JOB_NAMES = new Set([
    BILLING_JOB_NAMES.UPCOMING_INVOICE,
    BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3,
    BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_5,
    BILLING_JOB_NAMES.RESTRICT_SERVICE,
    BILLING_JOB_NAMES.RESTORE_SERVICE,
]);

export const BILLING_JOB_OPTIONS = Object.freeze({
    attempts: 8,
    backoff: Object.freeze({ type: "exponential", delay: 60_000 }),
});

export function isBillingSchedulersEnabled(env = process.env) {
    return env.BULLMQ_BILLING_SCHEDULERS_ENABLED === "true";
}

function requiredValue(value, field) {
    const normalized = String(value || "").trim();
    if (!normalized || normalized.length > 240) {
        throw new TypeError(`${field} is required`);
    }
    return normalized;
}

function safeJobIdPart(value) {
    const normalized = requiredValue(value, "job ID component")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 150);
    if (!normalized) throw new TypeError("A safe job ID component is required");
    return normalized;
}

export function validateBillingJobPayload(jobName, payload = {}) {
    if (jobName === BILLING_JOB_NAMES.LIFECYCLE_SCAN) {
        return {};
    }
    if (!PER_BUSINESS_JOB_NAMES.has(jobName)) {
        throw new TypeError("Unsupported billing job name");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("Billing job payload must be an object");
    }
    return {
        businessId: requiredValue(payload.businessId, "businessId"),
        periodKey: requiredValue(payload.periodKey, "periodKey"),
    };
}

export function buildBillingJobId(jobName, payload) {
    const data = validateBillingJobPayload(jobName, payload);
    if (jobName === BILLING_JOB_NAMES.LIFECYCLE_SCAN) {
        return "billing-lifecycle-scan";
    }
    return [
        "billing",
        safeJobIdPart(jobName),
        safeJobIdPart(data.businessId),
        safeJobIdPart(data.periodKey),
    ].join("-");
}

export async function enqueueBillingJob(
    jobName,
    payload,
    { env = process.env, queue } = {},
) {
    if (!isBillingSchedulersEnabled(env)) {
        return { queued: false, reason: "billing_schedulers_disabled" };
    }
    const data = validateBillingJobPayload(jobName, payload);
    const billingQueue = queue || createQueue(QUEUE_NAMES.BILLING, { env });
    const jobId = buildBillingJobId(jobName, data);
    const job = await billingQueue.add(jobName, data, {
        jobId,
        ...BILLING_JOB_OPTIONS,
    });
    return { queued: true, jobId: job.id };
}

export { PER_BUSINESS_JOB_NAMES };
