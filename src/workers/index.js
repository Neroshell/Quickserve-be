import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { assertEnvironment } from "../config/envValidation.js";
import { assertBullMqAvailable } from "../config/bullmqConnection.js";
import { closeQueues } from "../queues/createQueue.js";
import { registerWorkerSchedulers } from "./registerSchedulers.js";
import {
    closeWorkerRuntime,
    createWorkerRuntime,
    runWorkerRuntime,
    safeErrorReason,
    waitForWorkerRuntime,
} from "./workerRuntime.js";

let runtime = null;
let shuttingDown = false;

async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Worker] Shutting down (${reason})`);

    await closeWorkerRuntime(runtime);
    await closeQueues();

    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }

    process.exitCode = exitCode;
    console.log("[Worker] Shutdown complete");
}

async function startWorker() {
    assertBullMqAvailable();
    assertEnvironment("worker");
    await connectDB();

    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));

    const maxRetries = 10;
    const delayMs = 5000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            runtime = await createWorkerRuntime();
            await registerWorkerSchedulers({ runtime: "worker" });
            await waitForWorkerRuntime(runtime);
            break;
        } catch (error) {
            if (runtime) {
                await closeWorkerRuntime(runtime).catch(() => {});
                runtime = null;
            }
            if (attempt === maxRetries) {
                console.error(`[Worker] Startup failed after ${maxRetries} attempts`);
                throw error;
            }
            console.warn(`[Worker] Startup transient failure, retrying (${attempt}/${maxRetries}):`, safeErrorReason(error));
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    if (runtime.resources.length === 0) {
        console.log("[Worker] No queue workers enabled");
    }
    for (const resource of runtime.resources) {
        console.log(
            `[Worker] ${resource.queueName} worker ready ` +
            `(concurrency=${resource.concurrency})`,
        );
    }

    const handleRunLoopError = async (queueName, error) => {
        console.error("[Worker] Run loop stopped", {
            queue: queueName,
            errorClass: error?.name || "Error",
            reason: safeErrorReason(error),
        });
        await shutdown(`${queueName}_run_loop_error`, 1);
    };
    runWorkerRuntime(runtime, handleRunLoopError);
}

startWorker().catch(async (error) => {
    console.error("[Worker] Startup failed", {
        errorClass: error?.name || "Error",
        reason: safeErrorReason(error),
    });
    await shutdown("startup_error", 1);
});
