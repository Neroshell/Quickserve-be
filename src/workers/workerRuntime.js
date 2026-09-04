import { Worker } from "bullmq";
import {
    closeBullMqConnection,
    createBullMqWorkerConnection,
} from "../config/bullmqConnection.js";
import {
    EMAIL_JOB_NAMES,
    getEmailJobEntityId,
    isBillingSchedulersEnabled,
    isDiagnosticQueueEnabled,
    isPostPaymentQueueEnabled,
    isReservationSchedulersEnabled,
    isInventorySchedulersEnabled,
    QUEUE_NAMES,
} from "../queues/index.js";
import { isBullMqEmailsEnabled } from "../services/email/emailDispatchService.js";
import { isAiAnalystWeeklyEnabled } from "../queues/aiAnalystQueue.js";
import { processBillingJob } from "./processors/billingProcessor.js";
import { processDiagnosticJob } from "./processors/diagnosticProcessor.js";
import { processEmailJob } from "./processors/emailProcessor.js";
import { processPostPaymentJob } from "./processors/postPaymentProcessor.js";
import { processReservationJob } from "./processors/reservationProcessor.js";
import { processAiAnalystJob } from "./processors/aiAnalystProcessor.js";
import { processInventoryJob } from "./processors/inventoryProcessor.js";

/**
 * AI Analyst jobs call Cloudflare Workers AI which can legitimately take
 * 10–60 seconds. The BullMQ default lockDuration of 30s is insufficient:
 * a valid long-running generation job would trigger a false stall, causing
 * a retry and a duplicate Cloudflare call.
 *
 * 120 seconds comfortably exceeds the 60s Cloudflare HTTP timeout configured
 * in .env (CLOUDFLARE_AI_TIMEOUT_MS). BullMQ will auto-renew the lock every
 * lockDuration/2 = 60s, so even jobs approaching the upper bound are safe.
 */
export const AI_ANALYST_LOCK_DURATION = 120_000;

const WORKER_DEFINITIONS = Object.freeze([
    Object.freeze({
        feature: "diagnostic",
        queueName: QUEUE_NAMES.DIAGNOSTIC,
        flagName: "BULLMQ_DIAGNOSTIC_ENABLED",
        concurrency: 1,
        enabled: isDiagnosticQueueEnabled,
        processor: processDiagnosticJob,
        getEntityId: () => null,
    }),
    Object.freeze({
        feature: "email",
        queueName: QUEUE_NAMES.EMAIL,
        flagName: "BULLMQ_EMAILS_ENABLED",
        concurrency: 3,
        enabled: isBullMqEmailsEnabled,
        processor: processEmailJob,
        getEntityId(job) {
            try {
                return getEmailJobEntityId(job.name, job.data);
            } catch {
                return null;
            }
        },
    }),
    Object.freeze({
        feature: "reservation",
        queueName: QUEUE_NAMES.RESERVATIONS,
        flagName: "BULLMQ_RESERVATION_SCHEDULERS_ENABLED",
        concurrency: 1,
        enabled: isReservationSchedulersEnabled,
        processor: processReservationJob,
        getEntityId: (job) => job.data?.reservationId || null,
    }),
    Object.freeze({
        feature: "inventory",
        queueName: QUEUE_NAMES.INVENTORY,
        flagName: "BULLMQ_INVENTORY_SCHEDULERS_ENABLED",
        concurrency: 1,
        enabled: isInventorySchedulersEnabled,
        processor: processInventoryJob,
        getEntityId: (job) => job.data?.reservationId || null,
    }),
    Object.freeze({
        feature: "billing",
        queueName: QUEUE_NAMES.BILLING,
        flagName: "BULLMQ_BILLING_SCHEDULERS_ENABLED",
        concurrency: 1,
        enabled: isBillingSchedulersEnabled,
        processor: processBillingJob,
        getEntityId: (job) => job.data?.businessId || null,
    }),
    Object.freeze({
        feature: "postPayment",
        queueName: QUEUE_NAMES.POST_PAYMENT,
        flagName: "BULLMQ_POST_PAYMENT_ENABLED",
        concurrency: 1,
        enabled: isPostPaymentQueueEnabled,
        processor: processPostPaymentJob,
        getEntityId: (job) => job.data?.orderId || null,
    }),
    Object.freeze({
        feature: "aiAnalyst",
        queueName: QUEUE_NAMES.AI_ANALYST,
        flagName: "AI_ANALYST_WEEKLY_ENABLED",
        concurrency: 1,
        lockDuration: AI_ANALYST_LOCK_DURATION,
        enabled: isAiAnalystWeeklyEnabled,
        processor: processAiAnalystJob,
        getEntityId: (job) => job.data?.businessId || null,
    }),
]);

function safeErrorReason(error) {
    return error?.code || error?.name || "worker_error";
}

function safeErrorClass(error) {
    return error?.name || "Error";
}

export function registerWorkerLogging(
    worker,
    queueName,
    getEntityId = () => null,
) {
    worker.on("active", (job) => {
        console.log("[Worker] Job active", {
            queue: queueName,
            jobName: job.name,
            jobId: job.id,
            entityId: getEntityId(job),
            attempt: job.attemptsMade + 1,
        });
    });
    worker.on("completed", (job, result) => {
        console.log("[Worker] Job completed", {
            queue: queueName,
            jobName: job.name,
            jobId: job.id,
            entityId: getEntityId(job),
            attempt: job.attemptsMade,
            result: result?.skipped ? "skipped" : "completed",
            providerMessageId: result?.messageId || null,
        });
    });
    worker.on("failed", (job, error) => {
        const attempts = Number(job?.opts?.attempts || 1);
        const exhausted = !job || job.attemptsMade >= attempts;
        const refundExhausted = exhausted &&
            job?.name === EMAIL_JOB_NAMES.REFUND_CONFIRMATION;
        const logger = refundExhausted ? console.error : console.warn;
        logger("[Worker] Job failed", {
            queue: queueName,
            jobName: job?.name || "unknown",
            jobId: job?.id || "unknown",
            entityId: job ? getEntityId(job) : null,
            attempt: job?.attemptsMade || 0,
            exhausted,
            alert: refundExhausted ? "refund_email_exhausted" : null,
            errorClass: safeErrorClass(error),
            reason: safeErrorReason(error),
        });
    });
    worker.on("stalled", (jobId) => {
        console.warn("[Worker] Job stalled", {
            queue: queueName,
            jobId,
        });
    });
    worker.on("error", (error) => {
        console.error("[Worker] Worker error", {
            queue: queueName,
            errorClass: safeErrorClass(error),
            reason: safeErrorReason(error),
        });
    });
}

export function getWorkerDefinitions(env = process.env) {
    return WORKER_DEFINITIONS.map((definition) => ({
        ...definition,
        enabledForEnvironment: definition.enabled(env),
    }));
}

export async function createWorkerRuntime({
    env = process.env,
    WorkerClass = Worker,
    createConnection = createBullMqWorkerConnection,
    closeConnection = closeBullMqConnection,
} = {}) {
    const runtime = { resources: [] };
    let unownedConnection = null;
    try {
        for (const definition of getWorkerDefinitions(env)) {
            if (!definition.enabledForEnvironment) {
                console.log(
                    `[Worker] ${definition.queueName} worker disabled by ` +
                    definition.flagName,
                );
                continue;
            }

            const connection = createConnection({ env });
            unownedConnection = connection;
            const workerOpts = {
                connection,
                concurrency: definition.concurrency,
                autorun: false,
            };
            if (definition.lockDuration !== undefined) {
                workerOpts.lockDuration = definition.lockDuration;
            }
            const worker = new WorkerClass(
                definition.queueName,
                definition.processor,
                workerOpts,
            );
            registerWorkerLogging(
                worker,
                definition.queueName,
                definition.getEntityId,
            );
            runtime.resources.push({
                ...definition,
                worker,
                connection,
            });
            unownedConnection = null;
        }
        return runtime;
    } catch (error) {
        if (unownedConnection) {
            await Promise.resolve(closeConnection(unownedConnection)).catch(
                () => {},
            );
        }
        await closeWorkerRuntime(runtime, { closeConnection });
        throw error;
    }
}

export async function waitForWorkerRuntime(runtime) {
    await Promise.all(
        (runtime?.resources || []).map(({ worker }) => worker.waitUntilReady()),
    );
}

export function runWorkerRuntime(runtime, onRunLoopError) {
    for (const resource of runtime?.resources || []) {
        void resource.worker.run().catch((error) =>
            onRunLoopError(resource.queueName, error));
    }
}

export async function closeWorkerRuntime(
    runtime,
    { closeConnection = closeBullMqConnection } = {},
) {
    const resources = runtime?.resources || [];
    await Promise.allSettled(
        resources.map(({ worker }) => worker.close()),
    );
    await Promise.allSettled(
        resources.map(({ connection }) => closeConnection(connection)),
    );
}

export { safeErrorClass, safeErrorReason };
