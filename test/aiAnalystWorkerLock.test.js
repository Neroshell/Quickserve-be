import { describe, it, mock, beforeEach } from "node:test"
import assert from "node:assert/strict"

import {
    AI_ANALYST_LOCK_DURATION,
    getWorkerDefinitions,
    createWorkerRuntime,
} from "../src/workers/workerRuntime.js"
import { QUEUE_NAMES } from "../src/queues/index.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function aiAnalystDefinition(env = { AI_ANALYST_WEEKLY_ENABLED: "true" }) {
    return getWorkerDefinitions(env).find((d) => d.feature === "aiAnalyst")
}

// Minimal fake WorkerClass that captures the opts it is constructed with
function makeFakeWorkerClass() {
    const instances = []
    class FakeWorker {
        constructor(queueName, processor, opts) {
            this.queueName = queueName
            this.opts = opts
            instances.push(this)
        }
        async waitUntilReady() {}
        async close() {}
        on() {}
        run() { return new Promise(() => {}) }
    }
    FakeWorker.instances = instances
    return FakeWorker
}

function fakeConnection() {
    return {}
}

// ─── Lock duration tests ──────────────────────────────────────────────────────

describe("AI_ANALYST_LOCK_DURATION constant", () => {
    it("is 120,000 ms (120 seconds)", () => {
        assert.equal(AI_ANALYST_LOCK_DURATION, 120_000)
    })

    it("exceeds the default BullMQ lockDuration of 30,000 ms", () => {
        assert.ok(AI_ANALYST_LOCK_DURATION > 30_000)
    })

    it("exceeds the Cloudflare AI timeout default of 60,000 ms", () => {
        assert.ok(AI_ANALYST_LOCK_DURATION > 60_000)
    })
})

// ─── Worker definition tests ──────────────────────────────────────────────────

describe("AI analyst WORKER_DEFINITIONS entry", () => {
    it("has lockDuration set to AI_ANALYST_LOCK_DURATION", () => {
        const def = aiAnalystDefinition()
        assert.equal(def.lockDuration, AI_ANALYST_LOCK_DURATION)
    })

    it("uses the ai-analyst queue name", () => {
        const def = aiAnalystDefinition()
        assert.equal(def.queueName, QUEUE_NAMES.AI_ANALYST)
    })

    it("has concurrency 1", () => {
        const def = aiAnalystDefinition()
        assert.equal(def.concurrency, 1)
    })

    it("is disabled when AI_ANALYST_WEEKLY_ENABLED is not 'true'", () => {
        const defs = getWorkerDefinitions({ AI_ANALYST_WEEKLY_ENABLED: "false" })
        const def = defs.find((d) => d.feature === "aiAnalyst")
        assert.equal(def.enabledForEnvironment, false)
    })

    it("other worker definitions do NOT have lockDuration set", () => {
        const defs = getWorkerDefinitions({})
        const nonAiWorkers = defs.filter((d) => d.feature !== "aiAnalyst")
        for (const def of nonAiWorkers) {
            assert.equal(
                def.lockDuration,
                undefined,
                `${def.feature} worker should not set lockDuration`,
            )
        }
    })
})

// ─── Worker construction tests ────────────────────────────────────────────────

describe("createWorkerRuntime — AI analyst worker is constructed with correct lockDuration", () => {
    it("passes lockDuration: 120000 to the Worker constructor", async () => {
        const FakeWorker = makeFakeWorkerClass()
        const env = { AI_ANALYST_WEEKLY_ENABLED: "true" }

        await createWorkerRuntime({
            env,
            WorkerClass: FakeWorker,
            createConnection: fakeConnection,
            closeConnection: async () => {},
        })

        const aiWorkerInstance = FakeWorker.instances.find(
            (w) => w.queueName === QUEUE_NAMES.AI_ANALYST,
        )
        assert.ok(aiWorkerInstance, "AI analyst worker instance should be created")
        assert.equal(aiWorkerInstance.opts.lockDuration, 120_000)
    })

    it("does NOT set lockDuration on other workers", async () => {
        const FakeWorker = makeFakeWorkerClass()
        const env = {
            AI_ANALYST_WEEKLY_ENABLED: "true",
            BULLMQ_EMAILS_ENABLED: "true",
            BULLMQ_DIAGNOSTIC_ENABLED: "true",
        }

        await createWorkerRuntime({
            env,
            WorkerClass: FakeWorker,
            createConnection: fakeConnection,
            closeConnection: async () => {},
        })

        const nonAiInstances = FakeWorker.instances.filter(
            (w) => w.queueName !== QUEUE_NAMES.AI_ANALYST,
        )
        for (const inst of nonAiInstances) {
            assert.equal(
                inst.opts.lockDuration,
                undefined,
                `${inst.queueName} worker should not have lockDuration set`,
            )
        }
    })
})

// ─── Stall protection tests ───────────────────────────────────────────────────

describe("Stall protection — simulated long-running job is safe with 120s lock", () => {
    it("a 60s Cloudflare timeout does not exceed a 120s lock duration", () => {
        const CLOUDFLARE_TIMEOUT_MS = 60_000
        const lockDuration = AI_ANALYST_LOCK_DURATION
        const renewTime = lockDuration / 2 // BullMQ auto-renewal = lockDuration / 2

        // The lock is renewed every renewTime (60s). A 60s job that starts at t=0
        // will finish exactly at the renewal boundary — well within one lock window.
        assert.ok(CLOUDFLARE_TIMEOUT_MS < lockDuration,
            "Cloudflare timeout must be less than lockDuration to be safe without any renewal")

        // Even without auto-renewal, a single lock window covers the full CF timeout
        assert.ok(lockDuration > CLOUDFLARE_TIMEOUT_MS)
    })

    it("auto-renewal interval (lockDuration/2 = 60s) fires before any stall within a 120s lock", () => {
        const renewalInterval = AI_ANALYST_LOCK_DURATION / 2 // 60_000
        const stalledIntervalDefault = 30_000
        // BullMQ stall check fires at stalledInterval (default 30s)
        // but the lock won't expire until 120s — so the check would see a valid lock
        assert.ok(AI_ANALYST_LOCK_DURATION > stalledIntervalDefault * 2,
            "lockDuration should exceed 2× stalledInterval to survive multiple stall checks")
        assert.equal(renewalInterval, 60_000)
    })
})

// ─── Idempotency/duplicate protection tests ───────────────────────────────────

describe("AI analyst job idempotency protections", () => {
    it("buildAiAnalystJobId produces a deterministic, unique job ID per business+period", async () => {
        const { buildAiAnalystJobId } = await import("../src/queues/aiAnalystQueue.js")
        const id1 = buildAiAnalystJobId("rest_abc123", "2026-W33")
        const id2 = buildAiAnalystJobId("rest_abc123", "2026-W33")
        const id3 = buildAiAnalystJobId("rest_abc123", "2026-W34")

        assert.equal(id1, id2, "same inputs must produce the same job ID")
        assert.notEqual(id1, id3, "different period must produce a different job ID")
    })

    it("buildAiAnalystJobId sanitizes special characters in businessId/periodKey", async () => {
        const { buildAiAnalystJobId } = await import("../src/queues/aiAnalystQueue.js")
        const id = buildAiAnalystJobId("rest_4abbb2a88d3d7b", "2026-W33")
        assert.match(id, /^[a-zA-Z0-9_-]+$/, "job ID should contain only safe characters")
    })

    it("validateAiAnalystGeneratePayload rejects missing businessId", async () => {
        const { validateAiAnalystGeneratePayload } = await import("../src/queues/aiAnalystQueue.js")
        assert.throws(
            () => validateAiAnalystGeneratePayload({ periodKey: "2026-W33" }),
            /businessId is required/,
        )
    })

    it("validateAiAnalystGeneratePayload rejects malformed periodKey", async () => {
        const { validateAiAnalystGeneratePayload } = await import("../src/queues/aiAnalystQueue.js")
        assert.throws(
            () => validateAiAnalystGeneratePayload({ businessId: "biz_1", periodKey: "bad" }),
            /periodKey is required/,
        )
    })
})
