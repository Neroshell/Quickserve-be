import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import {
    closeWorkerRuntime,
    createWorkerRuntime,
    getWorkerDefinitions,
    registerWorkerLogging,
    waitForWorkerRuntime,
} from "../src/workers/workerRuntime.js";
import {
    BILLING_JOB_OPTIONS,
    POST_PAYMENT_JOB_OPTIONS,
    QUEUE_NAMES,
    RESERVATION_JOB_OPTIONS,
} from "../src/queues/index.js";

class FakeWorker extends EventEmitter {
    constructor(queueName, processor, options) {
        super();
        this.queueName = queueName;
        this.processor = processor;
        this.options = options;
        this.readyCalls = 0;
        this.closeCalls = 0;
    }

    async waitUntilReady() {
        this.readyCalls += 1;
    }

    async run() {}

    async close() {
        this.closeCalls += 1;
    }
}

function fullyEnabledEnv(overrides = {}) {
    return {
        BULLMQ_DIAGNOSTIC_ENABLED: "true",
        BULLMQ_EMAILS_ENABLED: "true",
        BULLMQ_RESERVATION_SCHEDULERS_ENABLED: "true",
        BULLMQ_BILLING_SCHEDULERS_ENABLED: "true",
        BULLMQ_POST_PAYMENT_ENABLED: "true",
        ...overrides,
    };
}

test("disabled features create no workers, connections, or QueueEvents", async () => {
    let connectionCreates = 0;
    const runtime = await createWorkerRuntime({
        env: {},
        WorkerClass: FakeWorker,
        createConnection() {
            connectionCreates += 1;
            return {};
        },
    });

    assert.equal(runtime.resources.length, 0);
    assert.equal(connectionCreates, 0);
    assert.equal(getWorkerDefinitions({}).every((item) => !item.enabledForEnvironment), true);

    const runtimeSource = await readFile(
        new URL("../src/workers/workerRuntime.js", import.meta.url),
        "utf8",
    );
    const entrySource = await readFile(
        new URL("../src/workers/index.js", import.meta.url),
        "utf8",
    );
    assert.doesNotMatch(runtimeSource, /\bQueueEvents\b/);
    assert.doesNotMatch(entrySource, /\bQueueEvents\b/);
});

test("only explicitly enabled workers are initialized", async () => {
    const connections = [];
    const runtime = await createWorkerRuntime({
        env: { BULLMQ_EMAILS_ENABLED: "true" },
        WorkerClass: FakeWorker,
        createConnection() {
            const connection = { id: connections.length + 1 };
            connections.push(connection);
            return connection;
        },
    });

    assert.equal(runtime.resources.length, 1);
    assert.equal(runtime.resources[0].queueName, QUEUE_NAMES.EMAIL);
    assert.equal(runtime.resources[0].worker.options.concurrency, 3);
    assert.equal(runtime.resources[0].worker.options.autorun, false);
    assert.equal(connections.length, 1);
});

test("all enabled workers retain their processors and concurrency", async () => {
    const runtime = await createWorkerRuntime({
        env: fullyEnabledEnv(),
        WorkerClass: FakeWorker,
        createConnection: () => ({}),
    });
    await waitForWorkerRuntime(runtime);

    assert.deepEqual(
        runtime.resources.map(({ queueName, concurrency }) => [queueName, concurrency]),
        [
            [QUEUE_NAMES.DIAGNOSTIC, 1],
            [QUEUE_NAMES.EMAIL, 3],
            [QUEUE_NAMES.RESERVATIONS, 1],
            [QUEUE_NAMES.BILLING, 1],
            [QUEUE_NAMES.POST_PAYMENT, 1],
        ],
    );
    assert.equal(runtime.resources.every(({ worker }) => worker.readyCalls === 1), true);

    const diagnostic = runtime.resources.find(
        ({ queueName }) => queueName === QUEUE_NAMES.DIAGNOSTIC,
    );
    const result = await diagnostic.processor({
        id: "diagnostic-runtime-test",
        name: "diagnostic-ping",
        data: {
            message: "runtime smoke test",
            requestedAt: "2026-08-04T12:00:00.000Z",
        },
    });
    assert.equal(result.success, true);
});

test("worker-local completed, failed, stalled, and error logs remain structured", (t) => {
    const worker = new FakeWorker("email", async () => {}, {});
    const logs = [];
    const warnings = [];
    const errors = [];
    t.mock.method(console, "log", (...args) => logs.push(args));
    t.mock.method(console, "warn", (...args) => warnings.push(args));
    t.mock.method(console, "error", (...args) => errors.push(args));
    registerWorkerLogging(worker, QUEUE_NAMES.EMAIL, (job) => job.data?.orderId);

    const job = {
        id: "job-1",
        name: "order-receipt",
        data: { orderId: "ORDER-1", email: "must-not-be-logged@example.com" },
        attemptsMade: 1,
        opts: { attempts: 6 },
    };
    worker.emit("active", job);
    worker.emit("completed", job, { messageId: "provider-1" });
    worker.emit("failed", job, Object.assign(new TypeError("provider failed"), {
        code: "PROVIDER_FAILED",
    }));
    worker.emit("stalled", job.id);
    worker.emit("error", new RangeError("worker connection failed"));

    assert.equal(logs.length, 2);
    assert.equal(warnings.length, 2);
    assert.equal(errors.length, 1);
    assert.deepEqual(warnings[0][1], {
        queue: "email",
        jobName: "order-receipt",
        jobId: "job-1",
        entityId: "ORDER-1",
        attempt: 1,
        exhausted: false,
        alert: null,
        errorClass: "TypeError",
        reason: "PROVIDER_FAILED",
    });
    const serializedLogs = JSON.stringify([logs, warnings, errors]);
    assert.equal(serializedLogs.includes("must-not-be-logged@example.com"), false);
});

test("graceful shutdown closes only initialized worker resources", async () => {
    const closedConnections = [];
    const runtime = await createWorkerRuntime({
        env: {
            BULLMQ_EMAILS_ENABLED: "true",
            BULLMQ_POST_PAYMENT_ENABLED: "true",
        },
        WorkerClass: FakeWorker,
        createConnection: () => ({ id: `connection-${closedConnections.length + 1}` }),
    });

    await closeWorkerRuntime(runtime, {
        closeConnection(connection) {
            closedConnections.push(connection.id);
        },
    });

    assert.equal(runtime.resources.length, 2);
    assert.equal(runtime.resources.every(({ worker }) => worker.closeCalls === 1), true);
    assert.equal(closedConnections.length, 2);

    let disabledCloseCalls = 0;
    const disabledRuntime = await createWorkerRuntime({
        env: {},
        WorkerClass: FakeWorker,
        createConnection: () => assert.fail("disabled runtime must not connect"),
    });
    await closeWorkerRuntime(disabledRuntime, {
        closeConnection() {
            disabledCloseCalls += 1;
        },
    });
    assert.equal(disabledCloseCalls, 0);
});

test('runtime initialization failure closes its unowned connection', async () => {
    const closedConnections = [];
    class ThrowingWorker {
        constructor() {
            throw new Error('worker construction failed');
        }
    }

    await assert.rejects(
        () => createWorkerRuntime({
            env: { BULLMQ_EMAILS_ENABLED: 'true' },
            WorkerClass: ThrowingWorker,
            createConnection: () => ({ id: 'unowned-email-connection' }),
            closeConnection(connection) {
                closedConnections.push(connection.id);
            },
        }),
        /worker construction failed/,
    );
    assert.deepEqual(closedConnections, ['unowned-email-connection']);
});

test("worker optimization leaves retry and backoff policies unchanged", () => {
    assert.deepEqual(RESERVATION_JOB_OPTIONS, {
        attempts: 5,
        backoff: { type: "exponential", delay: 10_000 },
    });
    assert.deepEqual(BILLING_JOB_OPTIONS, {
        attempts: 8,
        backoff: { type: "exponential", delay: 60_000 },
    });
    assert.deepEqual(POST_PAYMENT_JOB_OPTIONS, {
        attempts: 8,
        backoff: { type: "exponential", delay: 15_000 },
    });
});
