import {
    enqueueDiagnosticJob,
    getDiagnosticQueueHealth,
    isDiagnosticQueueEnabled,
} from "../queues/index.js";

export async function enqueueQueueDiagnostic(req, res) {
    if (!isDiagnosticQueueEnabled()) {
        return res.status(503).json({
            queued: false,
            code: "BULLMQ_DIAGNOSTIC_DISABLED",
            error: "Diagnostic queue disabled",
        });
    }
    try {
        const requestedAt = new Date().toISOString();
        const { jobId } = await enqueueDiagnosticJob({
            message: "QuickServe BullMQ diagnostic ping",
            requestedAt,
        });

        return res.status(202).json({
            queued: true,
            jobId,
        });
    } catch (error) {
        const safeReason = error?.code || error?.name || "queue_unavailable";
        console.error(`[QueueDiagnostic] Enqueue unavailable (${safeReason})`);
        return res.status(503).json({
            queued: false,
            error: error?.code === "BULLMQ_DISABLED"
                ? "Queue disabled"
                : "Queue unavailable",
        });
    }
}

export async function getQueueHealth(req, res) {
    const health = await getDiagnosticQueueHealth();
    const status = health.canAttemptDiagnosticEnqueue ? 200 : 503;

    return res.status(status).json({
        bullmqEnabled: health.enabled,
        producerRedis: {
            configured: health.redisConfigured,
            status: health.producerRedisStatus,
        },
        diagnostic: {
            enabled: health.diagnosticEnabled,
            canAttemptEnqueue: health.canAttemptDiagnosticEnqueue,
        },
    });
}
