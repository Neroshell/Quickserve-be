import Redis from "ioredis";

export class BullMqConfigurationError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "BullMqConfigurationError";
        this.code = code;
    }
}

export function isBullMqEnabled(env = process.env) {
    return env.BULLMQ_ENABLED === "true";
}

export function getBullMqAvailability(env = process.env) {
    const enabled = isBullMqEnabled(env);
    const redisConfigured = Boolean(env.REDIS_URL?.trim());

    return {
        enabled,
        redisConfigured,
        canInitialize: enabled && redisConfigured,
    };
}

export function assertBullMqAvailable(env = process.env) {
    const availability = getBullMqAvailability(env);

    if (!availability.enabled) {
        throw new BullMqConfigurationError(
            "BullMQ is disabled",
            "BULLMQ_DISABLED",
        );
    }

    if (!availability.redisConfigured) {
        throw new BullMqConfigurationError(
            "REDIS_URL is required when BullMQ is enabled",
            "BULLMQ_REDIS_URL_MISSING",
        );
    }

    return availability;
}

function safeConnectionError(error) {
    return error?.code || error?.name || "connection_error";
}

function registerLifecycleLogging(connection, role) {
    connection.on("connect", () => {
        console.log(`[BullMQ:${role}] Connected`);
    });
    connection.on("ready", () => {
        console.log(`[BullMQ:${role}] Ready`);
    });
    connection.on("error", (error) => {
        console.error(`[BullMQ:${role}] Redis error (${safeConnectionError(error)})`);
    });
    connection.on("close", () => {
        console.warn(`[BullMQ:${role}] Connection closed`);
    });
    connection.on("reconnecting", () => {
        console.warn(`[BullMQ:${role}] Reconnecting`);
    });
}

function createBullMqConnection({ role, env, maxRetriesPerRequest, retryStrategy }) {
    assertBullMqAvailable(env);
    const redisUrl = env.REDIS_URL.trim();

    // BullMQ intentionally owns dedicated ioredis connections. Session Redis and
    // SSE pub/sub clients have different command and lifecycle requirements and
    // must never be shared with queue producers or workers.
    const connection = new Redis(redisUrl, {
        enableReadyCheck: false,
        lazyConnect: true,
        connectTimeout: 5000,
        maxRetriesPerRequest,
        retryStrategy,
        tls: redisUrl.startsWith("rediss://") ? {} : undefined,
    });

    registerLifecycleLogging(connection, role);
    return connection;
}

export function createBullMqProducerConnection({ env = process.env } = {}) {
    return createBullMqConnection({
        role: "producer",
        env,
        // API requests fail after one Redis retry, while the client may keep
        // reconnecting in the background so a transient outage can recover.
        maxRetriesPerRequest: 1,
        retryStrategy(attempt) {
            return Math.min(attempt * 200, 1000);
        },
    });
}

export function createBullMqWorkerConnection({ env = process.env } = {}) {
    return createBullMqConnection({
        role: "worker",
        env,
        maxRetriesPerRequest: null,
        retryStrategy(attempt) {
            return Math.min(attempt * 250, 5000);
        },
    });
}

export async function closeBullMqConnection(connection) {
    if (!connection || connection.status === "end") return;

    if (connection.status === "wait") {
        connection.disconnect();
        return;
    }

    try {
        await connection.quit();
    } catch {
        connection.disconnect();
    }
}
