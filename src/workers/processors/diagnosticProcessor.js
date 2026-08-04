import {
    DIAGNOSTIC_JOB_NAME,
    validateDiagnosticPayload,
} from "../../queues/index.js";

export async function processDiagnosticJob(job) {
    if (!job || job.name !== DIAGNOSTIC_JOB_NAME) {
        throw new TypeError("Unsupported diagnostic job");
    }

    validateDiagnosticPayload(job.data);
    console.log(`[Worker:diagnostic] Processing job ${job.id || "unknown"}`);

    return {
        success: true,
        processedAt: new Date().toISOString(),
    };
}
