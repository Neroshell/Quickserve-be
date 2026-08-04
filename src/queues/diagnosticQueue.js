import { randomUUID } from "node:crypto";
import { getBullMqAvailability } from "../config/bullmqConnection.js";
import { createQueue } from "./createQueue.js";
import { DIAGNOSTIC_JOB_NAME, QUEUE_NAMES } from "./queueNames.js";

const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 200;
const HEALTH_TIMEOUT_MS = 3000;

function withTimeout(promise, timeoutMs) {
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("queue_health_timeout")), timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

export function validateDiagnosticPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("Diagnostic payload must be an object");
    }

    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!message || message.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH) {
        throw new TypeError("Diagnostic message must contain 1 to 200 characters");
    }

    if (typeof payload.requestedAt !== "string") {
        throw new TypeError("Diagnostic requestedAt must be an ISO timestamp");
    }

    const requestedAt = new Date(payload.requestedAt);
    if (Number.isNaN(requestedAt.getTime())) {
        throw new TypeError("Diagnostic requestedAt must be an ISO timestamp");
    }

    return {
        message,
        requestedAt: requestedAt.toISOString(),
    };
}

export function createDiagnosticJobId({ requestedAt, nonce = randomUUID() }) {
    const timestamp = new Date(requestedAt).getTime();
    if (!Number.isFinite(timestamp)) {
        throw new TypeError("A valid requestedAt timestamp is required");
    }

    const safeNonce = String(nonce).replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeNonce) {
        throw new TypeError("A safe diagnostic job nonce is required");
    }

    // BullMQ custom job IDs must not contain colons because colons delimit Redis keys.
    return `diagnostic-${timestamp}-${safeNonce}`;
}

export async function enqueueDiagnosticJob(payload, { env = process.env } = {}) {
    const data = validateDiagnosticPayload(payload);
    const queue = createQueue(QUEUE_NAMES.DIAGNOSTIC, { env });
    const job = await queue.add(DIAGNOSTIC_JOB_NAME, data, {
        jobId: createDiagnosticJobId({ requestedAt: data.requestedAt }),
    });

    return { jobId: job.id };
}

export async function getDiagnosticQueueHealth({ env = process.env } = {}) {
    const availability = getBullMqAvailability(env);
    if (!availability.canInitialize) {
        return {
            ...availability,
            producerRedisStatus: availability.enabled ? "not_configured" : "disabled",
            canAttemptDiagnosticEnqueue: false,
        };
    }

    try {
        const queue = createQueue(QUEUE_NAMES.DIAGNOSTIC, { env });
        const client = await withTimeout(queue.client, HEALTH_TIMEOUT_MS);
        await withTimeout(client.ping(), HEALTH_TIMEOUT_MS);

        return {
            ...availability,
            producerRedisStatus: client.status,
            canAttemptDiagnosticEnqueue: client.status === "ready",
        };
    } catch {
        return {
            ...availability,
            producerRedisStatus: "unavailable",
            canAttemptDiagnosticEnqueue: false,
        };
    }
}
