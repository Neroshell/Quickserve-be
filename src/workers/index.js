import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
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
    await connectDB();

    runtime = await createWorkerRuntime();
    await registerWorkerSchedulers({ runtime: "worker" });

    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));

    await waitForWorkerRuntime(runtime);
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
