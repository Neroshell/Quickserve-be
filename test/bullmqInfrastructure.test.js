import test from "node:test";
import assert from "node:assert/strict";
import {
    BullMqConfigurationError,
    assertBullMqAvailable,
    closeBullMqConnection,
    createBullMqProducerConnection,
    createBullMqWorkerConnection,
    getBullMqAvailability,
} from "../src/config/bullmqConnection.js";
import {
    createDiagnosticJobId,
    enqueueDiagnosticJob,
    getDiagnosticQueueHealth,
    isDiagnosticQueueEnabled,
    validateDiagnosticPayload,
} from "../src/queues/diagnosticQueue.js";
import { enqueueQueueDiagnostic } from "../src/controllers/queueDiagnosticController.js";
import { getRegisteredQueue } from "../src/queues/createQueue.js";
import { DIAGNOSTIC_JOB_NAME, QUEUE_NAMES } from "../src/queues/queueNames.js";
import { processDiagnosticJob } from "../src/workers/processors/diagnosticProcessor.js";

test("queue names expose only the Phase 0 queue set", () => {
    assert.deepEqual(QUEUE_NAMES, {
        DIAGNOSTIC: "diagnostic",
        EMAIL: "email",
        RESERVATIONS: "reservations",
        BILLING: "billing",
        POST_PAYMENT: "post-payment",
    });
    assert.equal(DIAGNOSTIC_JOB_NAME, "diagnostic-ping");
});

test("diagnostic payload validation normalizes safe values", () => {
    assert.deepEqual(
        validateDiagnosticPayload({
            message: "  phase zero ping  ",
            requestedAt: "2026-08-02T12:00:00.000Z",
        }),
        {
            message: "phase zero ping",
            requestedAt: "2026-08-02T12:00:00.000Z",
        },
    );

    assert.throws(
        () => validateDiagnosticPayload({ message: "", requestedAt: "invalid" }),
        /Diagnostic message/,
    );
});

test("diagnostic job IDs are deterministic with a supplied nonce and contain no colon", () => {
    const jobId = createDiagnosticJobId({
        requestedAt: "2026-08-02T12:00:00.000Z",
        nonce: "fixed:nonce",
    });

    assert.equal(jobId, "diagnostic-1785672000000-fixednonce");
    assert.equal(jobId.includes(":"), false);
});

test("BullMQ remains disabled unless explicitly enabled", () => {
    const availability = getBullMqAvailability({
        BULLMQ_ENABLED: "false",
        REDIS_URL: "redis://example.invalid",
    });

    assert.deepEqual(availability, {
        enabled: false,
        redisConfigured: true,
        canInitialize: false,
    });
    assert.throws(
        () => assertBullMqAvailable({
            BULLMQ_ENABLED: "false",
            REDIS_URL: "redis://example.invalid",
        }),
        (error) => error instanceof BullMqConfigurationError
            && error.code === "BULLMQ_DISABLED",
    );
});

test("diagnostics default disabled and do not initialize a queue", async () => {
    const env = {
        BULLMQ_ENABLED: "true",
        REDIS_URL: "redis://example.invalid",
    };
    const payload = {
        message: "phase zero ping",
        requestedAt: "2026-08-02T12:00:00.000Z",
    };

    await assert.rejects(
        () => enqueueDiagnosticJob(payload, { env }),
        (error) => error.code === "BULLMQ_DIAGNOSTIC_DISABLED",
    );
    assert.equal(isDiagnosticQueueEnabled(env), false);
    assert.equal(getRegisteredQueue(QUEUE_NAMES.DIAGNOSTIC), null);
    assert.deepEqual(await getDiagnosticQueueHealth({ env }), {
        enabled: true,
        redisConfigured: true,
        canInitialize: true,
        diagnosticEnabled: false,
        producerRedisStatus: "disabled",
        canAttemptDiagnosticEnqueue: false,
    });
});

test("diagnostic producer route returns a clear disabled response", async () => {
    const previous = process.env.BULLMQ_DIAGNOSTIC_ENABLED;
    delete process.env.BULLMQ_DIAGNOSTIC_ENABLED;
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
    try {
        await enqueueQueueDiagnostic({}, res);
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, {
            queued: false,
            code: "BULLMQ_DIAGNOSTIC_DISABLED",
            error: "Diagnostic queue disabled",
        });
    } finally {
        if (previous === undefined) {
            delete process.env.BULLMQ_DIAGNOSTIC_ENABLED;
        } else {
            process.env.BULLMQ_DIAGNOSTIC_ENABLED = previous;
        }
    }
});

test("BullMQ rejects missing REDIS_URL without creating a Redis connection", () => {
    const env = { BULLMQ_ENABLED: "true", REDIS_URL: "" };

    assert.throws(
        () => createBullMqProducerConnection({ env }),
        (error) => error instanceof BullMqConfigurationError
            && error.code === "BULLMQ_REDIS_URL_MISSING",
    );
});

test("producer and worker receive separate lazy ioredis connections", async () => {
    const env = {
        BULLMQ_ENABLED: "true",
        REDIS_URL: "rediss://localhost:6379",
    };
    const producer = createBullMqProducerConnection({ env });
    const worker = createBullMqWorkerConnection({ env });

    assert.notEqual(producer, worker);
    assert.equal(producer.status, "wait");
    assert.equal(worker.status, "wait");
    assert.equal(producer.options.maxRetriesPerRequest, 1);
    assert.equal(worker.options.maxRetriesPerRequest, null);
    assert.deepEqual(producer.options.tls, {});

    await Promise.all([
        closeBullMqConnection(producer),
        closeBullMqConnection(worker),
    ]);
});

test("diagnostic processor validates data and returns a safe result", async () => {
    const result = await processDiagnosticJob({
        id: "diagnostic-test-job",
        name: DIAGNOSTIC_JOB_NAME,
        data: {
            message: "phase zero ping",
            requestedAt: "2026-08-02T12:00:00.000Z",
        },
    });

    assert.equal(result.success, true);
    assert.equal(Number.isNaN(new Date(result.processedAt).getTime()), false);
    assert.deepEqual(Object.keys(result).sort(), ["processedAt", "success"]);
});
