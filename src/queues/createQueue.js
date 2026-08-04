import { Queue } from "bullmq";
import {
    closeBullMqConnection,
    createBullMqProducerConnection,
} from "../config/bullmqConnection.js";

export const DEFAULT_JOB_OPTIONS = Object.freeze({
    removeOnComplete: Object.freeze({
        age: 24 * 60 * 60,
        count: 1000,
    }),
    removeOnFail: Object.freeze({
        age: 7 * 24 * 60 * 60,
        count: 5000,
    }),
});

const queueRegistry = new Map();

export function createQueue(queueName, { env = process.env } = {}) {
    if (typeof queueName !== "string" || !queueName.trim()) {
        throw new TypeError("A non-empty queue name is required");
    }

    const existing = queueRegistry.get(queueName);
    if (existing) return existing.queue;

    const connection = createBullMqProducerConnection({ env });
    const queue = new Queue(queueName, {
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });

    queue.on("error", (error) => {
        const safeReason = error?.code || error?.name || "queue_error";
        console.error(`[BullMQ:queue:${queueName}] Error (${safeReason})`);
    });

    queueRegistry.set(queueName, { queue, connection });
    return queue;
}

export function getRegisteredQueue(queueName) {
    return queueRegistry.get(queueName)?.queue || null;
}

export async function closeQueues() {
    const entries = [...queueRegistry.values()];
    queueRegistry.clear();

    await Promise.allSettled(entries.map(async ({ queue, connection }) => {
        await queue.close();
        await closeBullMqConnection(connection);
    }));
}
