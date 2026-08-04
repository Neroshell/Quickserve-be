import "dotenv/config";
import mongoose from "mongoose";
import { QueueEvents, Worker } from "bullmq";
import { connectDB } from "../config/db.js";
import {
    assertBullMqAvailable,
    closeBullMqConnection,
    createBullMqEventsConnection,
    createBullMqWorkerConnection,
} from "../config/bullmqConnection.js";
import {
    EMAIL_JOB_NAMES,
    getEmailJobEntityId,
    isBillingSchedulersEnabled,
    isPostPaymentQueueEnabled,
    isReservationSchedulersEnabled,
    QUEUE_NAMES,
} from "../queues/index.js";
import { closeQueues } from "../queues/createQueue.js";
import { isBullMqEmailsEnabled } from "../services/email/emailDispatchService.js";
import { processBillingJob } from "./processors/billingProcessor.js";
import { processDiagnosticJob } from "./processors/diagnosticProcessor.js";
import { processEmailJob } from "./processors/emailProcessor.js";
import { processReservationJob } from "./processors/reservationProcessor.js";
import { processPostPaymentJob } from "./processors/postPaymentProcessor.js";
import { registerWorkerSchedulers } from "./registerSchedulers.js";

const DIAGNOSTIC_WORKER_CONCURRENCY = 1;
const EMAIL_WORKER_CONCURRENCY = 3;
const RESERVATION_WORKER_CONCURRENCY = 1;
const BILLING_WORKER_CONCURRENCY = 1;
const POST_PAYMENT_WORKER_CONCURRENCY = 1;

let diagnosticWorker = null;
let diagnosticQueueEvents = null;
let emailWorker = null;
let emailQueueEvents = null;
let reservationWorker = null;
let reservationQueueEvents = null;
let billingWorker = null;
let billingQueueEvents = null;
let postPaymentWorker = null;
let postPaymentQueueEvents = null;
let diagnosticWorkerConnection = null;
let diagnosticEventsConnection = null;
let emailWorkerConnection = null;
let emailEventsConnection = null;
let reservationWorkerConnection = null;
let reservationEventsConnection = null;
let billingWorkerConnection = null;
let billingEventsConnection = null;
let postPaymentWorkerConnection = null;
let postPaymentEventsConnection = null;
let shuttingDown = false;

function safeErrorReason(error) {
    return error?.code || error?.name || "worker_error";
}

function registerWorkerLogging(worker, queueName, getEntityId = () => null) {
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
            result: result?.skipped ? "skipped" : "sent",
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
            reason: safeErrorReason(error),
        });
    });
    worker.on("stalled", (jobId) => {
        console.warn("[Worker] Job stalled", { queue: queueName, jobId });
    });
    worker.on("error", (error) => {
        console.error("[Worker] Worker error", {
            queue: queueName,
            reason: safeErrorReason(error),
        });
    });
}

function registerQueueEventsLogging(queueEvents, queueName) {
    queueEvents.on("completed", ({ jobId }) => {
        console.log("[QueueEvents] Job completed", { queue: queueName, jobId });
    });
    queueEvents.on("failed", ({ jobId }) => {
        console.error("[QueueEvents] Job failed", { queue: queueName, jobId });
    });
    queueEvents.on("stalled", ({ jobId }) => {
        console.warn("[QueueEvents] Job stalled", { queue: queueName, jobId });
    });
    queueEvents.on("error", (error) => {
        console.error("[QueueEvents] Error", {
            queue: queueName,
            reason: safeErrorReason(error),
        });
    });
}

function emailEntityId(job) {
    try {
        return getEmailJobEntityId(job.name, job.data);
    } catch {
        return null;
    }
}

async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Worker] Shutting down (${reason})`);

    await Promise.allSettled([
        diagnosticWorker?.close(),
        diagnosticQueueEvents?.close(),
        emailWorker?.close(),
        emailQueueEvents?.close(),
        reservationWorker?.close(),
        reservationQueueEvents?.close(),
        billingWorker?.close(),
        billingQueueEvents?.close(),
        postPaymentWorker?.close(),
        postPaymentQueueEvents?.close(),
    ]);
    await Promise.allSettled([
        closeBullMqConnection(diagnosticWorkerConnection),
        closeBullMqConnection(diagnosticEventsConnection),
        closeBullMqConnection(emailWorkerConnection),
        closeBullMqConnection(emailEventsConnection),
        closeBullMqConnection(reservationWorkerConnection),
        closeBullMqConnection(reservationEventsConnection),
        closeBullMqConnection(billingWorkerConnection),
        closeBullMqConnection(billingEventsConnection),
        closeBullMqConnection(postPaymentWorkerConnection),
        closeBullMqConnection(postPaymentEventsConnection),
        closeQueues(),
    ]);

    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }

    process.exitCode = exitCode;
    console.log("[Worker] Shutdown complete");
}

async function startWorker() {
    assertBullMqAvailable();
    await connectDB();

    diagnosticWorkerConnection = createBullMqWorkerConnection();
    diagnosticEventsConnection = createBullMqEventsConnection();

    diagnosticWorker = new Worker(
        QUEUE_NAMES.DIAGNOSTIC,
        processDiagnosticJob,
        {
            connection: diagnosticWorkerConnection,
            concurrency: DIAGNOSTIC_WORKER_CONCURRENCY,
            autorun: false,
        },
    );
    diagnosticQueueEvents = new QueueEvents(QUEUE_NAMES.DIAGNOSTIC, {
        connection: diagnosticEventsConnection,
    });

    registerWorkerLogging(diagnosticWorker, QUEUE_NAMES.DIAGNOSTIC);
    registerQueueEventsLogging(diagnosticQueueEvents, QUEUE_NAMES.DIAGNOSTIC);

    if (isBullMqEmailsEnabled()) {
        emailWorkerConnection = createBullMqWorkerConnection();
        emailEventsConnection = createBullMqEventsConnection();
        emailWorker = new Worker(QUEUE_NAMES.EMAIL, processEmailJob, {
            connection: emailWorkerConnection,
            concurrency: EMAIL_WORKER_CONCURRENCY,
            autorun: false,
        });
        emailQueueEvents = new QueueEvents(QUEUE_NAMES.EMAIL, {
            connection: emailEventsConnection,
        });
        registerWorkerLogging(emailWorker, QUEUE_NAMES.EMAIL, emailEntityId);
        registerQueueEventsLogging(emailQueueEvents, QUEUE_NAMES.EMAIL);
    } else {
        console.log("[Worker] Email worker disabled by BULLMQ_EMAILS_ENABLED");
    }

    if (isReservationSchedulersEnabled()) {
        reservationWorkerConnection = createBullMqWorkerConnection();
        reservationEventsConnection = createBullMqEventsConnection();
        reservationWorker = new Worker(
            QUEUE_NAMES.RESERVATIONS,
            processReservationJob,
            {
                connection: reservationWorkerConnection,
                concurrency: RESERVATION_WORKER_CONCURRENCY,
                autorun: false,
            },
        );
        reservationQueueEvents = new QueueEvents(QUEUE_NAMES.RESERVATIONS, {
            connection: reservationEventsConnection,
        });
        registerWorkerLogging(
            reservationWorker,
            QUEUE_NAMES.RESERVATIONS,
            (job) => job.data?.reservationId || null,
        );
        registerQueueEventsLogging(
            reservationQueueEvents,
            QUEUE_NAMES.RESERVATIONS,
        );
    } else {
        console.log(
            "[Worker] Reservation schedulers disabled by " +
            "BULLMQ_RESERVATION_SCHEDULERS_ENABLED",
        );
    }

    if (isBillingSchedulersEnabled()) {
        billingWorkerConnection = createBullMqWorkerConnection();
        billingEventsConnection = createBullMqEventsConnection();
        billingWorker = new Worker(QUEUE_NAMES.BILLING, processBillingJob, {
            connection: billingWorkerConnection,
            concurrency: BILLING_WORKER_CONCURRENCY,
            autorun: false,
        });
        billingQueueEvents = new QueueEvents(QUEUE_NAMES.BILLING, {
            connection: billingEventsConnection,
        });
        registerWorkerLogging(
            billingWorker,
            QUEUE_NAMES.BILLING,
            (job) => job.data?.businessId || null,
        );
        registerQueueEventsLogging(billingQueueEvents, QUEUE_NAMES.BILLING);
    } else {
        console.log(
            "[Worker] Billing schedulers disabled by " +
            "BULLMQ_BILLING_SCHEDULERS_ENABLED",
        );
    }

    if (isPostPaymentQueueEnabled()) {
        postPaymentWorkerConnection = createBullMqWorkerConnection();
        postPaymentEventsConnection = createBullMqEventsConnection();
        postPaymentWorker = new Worker(
            QUEUE_NAMES.POST_PAYMENT,
            processPostPaymentJob,
            {
                connection: postPaymentWorkerConnection,
                concurrency: POST_PAYMENT_WORKER_CONCURRENCY,
                autorun: false,
            },
        );
        postPaymentQueueEvents = new QueueEvents(QUEUE_NAMES.POST_PAYMENT, {
            connection: postPaymentEventsConnection,
        });
        registerWorkerLogging(
            postPaymentWorker,
            QUEUE_NAMES.POST_PAYMENT,
            (job) => job.data?.orderId || null,
        );
        registerQueueEventsLogging(
            postPaymentQueueEvents,
            QUEUE_NAMES.POST_PAYMENT,
        );
    } else {
        console.log(
            "[Worker] Post-payment worker disabled by " +
            "BULLMQ_POST_PAYMENT_ENABLED",
        );
    }

    await registerWorkerSchedulers({ runtime: "worker" });

    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));

    await Promise.all([
        diagnosticWorker.waitUntilReady(),
        diagnosticQueueEvents.waitUntilReady(),
        emailWorker?.waitUntilReady(),
        emailQueueEvents?.waitUntilReady(),
        reservationWorker?.waitUntilReady(),
        reservationQueueEvents?.waitUntilReady(),
        billingWorker?.waitUntilReady(),
        billingQueueEvents?.waitUntilReady(),
        postPaymentWorker?.waitUntilReady(),
        postPaymentQueueEvents?.waitUntilReady(),
    ]);
    console.log("[Worker] Diagnostic worker ready (concurrency=1)");
    if (emailWorker) {
        console.log("[Worker] Email worker ready (concurrency=3)");
    }
    if (reservationWorker) {
        console.log("[Worker] Reservation worker ready (concurrency=1)");
    }
    if (billingWorker) {
        console.log("[Worker] Billing worker ready (concurrency=1)");
    }
    if (postPaymentWorker) {
        console.log("[Worker] Post-payment worker ready (concurrency=1)");
    }

    const handleRunLoopError = async (queueName, error) => {
        console.error(`[Worker] Run loop stopped (${safeErrorReason(error)})`);
        await shutdown(`${queueName}_run_loop_error`, 1);
    };
    void diagnosticWorker.run().catch((error) =>
        handleRunLoopError(QUEUE_NAMES.DIAGNOSTIC, error));
    if (emailWorker) {
        void emailWorker.run().catch((error) =>
            handleRunLoopError(QUEUE_NAMES.EMAIL, error));
    }
    if (reservationWorker) {
        void reservationWorker.run().catch((error) =>
            handleRunLoopError(QUEUE_NAMES.RESERVATIONS, error));
    }
    if (billingWorker) {
        void billingWorker.run().catch((error) =>
            handleRunLoopError(QUEUE_NAMES.BILLING, error));
    }
    if (postPaymentWorker) {
        void postPaymentWorker.run().catch((error) =>
            handleRunLoopError(QUEUE_NAMES.POST_PAYMENT, error));
    }
}

startWorker().catch(async (error) => {
    console.error(`[Worker] Startup failed (${safeErrorReason(error)})`);
    await shutdown("startup_error", 1);
});
