import { createQueue } from "./createQueue.js";
import { QUEUE_NAMES, RESERVATION_JOB_NAMES } from "./queueNames.js";

export const RESERVATION_JOB_OPTIONS = Object.freeze({
    attempts: 5,
    backoff: Object.freeze({ type: "exponential", delay: 10_000 }),
});

export function isReservationSchedulersEnabled(env = process.env) {
    return env.BULLMQ_RESERVATION_SCHEDULERS_ENABLED === "true";
}

function requiredId(value, field) {
    const normalized = String(value || "").trim();
    if (!normalized || normalized.length > 200) {
        throw new TypeError(`${field} is required`);
    }
    return normalized;
}

function safeJobIdPart(value) {
    const normalized = requiredId(value, "job ID component")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120);
    if (!normalized) throw new TypeError("A safe job ID component is required");
    return normalized;
}

export function validateReservationExpiryPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("Reservation expiry payload must be an object");
    }
    const expectedPaymentExpiry = new Date(payload.expectedPaymentExpiry);
    if (Number.isNaN(expectedPaymentExpiry.getTime())) {
        throw new TypeError("expectedPaymentExpiry must be a valid date");
    }
    return {
        businessId: requiredId(payload.businessId, "businessId"),
        reservationId: requiredId(payload.reservationId, "reservationId"),
        expectedPaymentExpiry: expectedPaymentExpiry.toISOString(),
    };
}

export function buildReservationExpiryJobId(payload) {
    const data = validateReservationExpiryPayload(payload);
    return [
        "reservation-expiry",
        safeJobIdPart(data.businessId),
        safeJobIdPart(data.reservationId),
        new Date(data.expectedPaymentExpiry).getTime(),
    ].join("-");
}

export async function enqueueReservationPaymentExpiry(
    payload,
    { env = process.env, queue, now = new Date() } = {},
) {
    if (!isReservationSchedulersEnabled(env)) {
        return { queued: false, reason: "reservation_schedulers_disabled" };
    }
    const data = validateReservationExpiryPayload(payload);
    const reservationQueue = queue || createQueue(QUEUE_NAMES.RESERVATIONS, { env });
    const jobId = buildReservationExpiryJobId(data);
    const delay = Math.max(
        0,
        new Date(data.expectedPaymentExpiry).getTime() - now.getTime(),
    );
    const job = await reservationQueue.add(
        RESERVATION_JOB_NAMES.EXPIRE_PAYMENT_WINDOW,
        data,
        {
            jobId,
            delay,
            ...RESERVATION_JOB_OPTIONS,
        },
    );
    return { queued: true, jobId: job.id, delay };
}
