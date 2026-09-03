import assert from "node:assert/strict";
import test from "node:test";
import {
    BILLING_JOB_OPTIONS,
    buildBillingJobId,
} from "../src/queues/billingQueue.js";
import { BILLING_JOB_NAMES } from "../src/queues/queueNames.js";
import {
    getBillingActionPeriodKey,
    processBillingLifecycleAction,
    scanBillingLifecycleCandidates,
} from "../src/services/billingLifecycleService.js";
import {
    processBillingLifecycle,
    processReservationExpiry,
} from "../src/controllers/cronController.js";
import { registerWorkerSchedulers } from "../src/workers/registerSchedulers.js";

function getPath(object, path) {
    return path.split(".").reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
    const parts = path.split(".");
    const final = parts.pop();
    let target = object;
    for (const part of parts) {
        if (!target[part] || typeof target[part] !== "object") {
            target[part] = {};
        }
        target = target[part];
    }
    target[final] = value;
}

function comparable(value) {
    if (value instanceof Date) return value.getTime();
    return value;
}

function matches(document, filter) {
    for (const [key, condition] of Object.entries(filter || {})) {
        if (key === "$or") {
            if (!condition.some((branch) => matches(document, branch))) return false;
            continue;
        }
        const actual = getPath(document, key);
        if (
            condition &&
            typeof condition === "object" &&
            !(condition instanceof Date) &&
            !Array.isArray(condition)
        ) {
            if ("$ne" in condition && comparable(actual) === comparable(condition.$ne)) return false;
            if ("$nin" in condition && condition.$nin.some((value) => comparable(actual) === comparable(value))) return false;
            if ("$in" in condition && !condition.$in.some((value) => comparable(actual) === comparable(value))) return false;
            if ("$lte" in condition && !(comparable(actual) <= comparable(condition.$lte))) return false;
            if ("$lt" in condition && !(comparable(actual) < comparable(condition.$lt))) return false;
            if ("$gte" in condition && !(comparable(actual) >= comparable(condition.$gte))) return false;
            if ("$gt" in condition && !(comparable(actual) > comparable(condition.$gt))) return false;
            continue;
        }
        if (condition === null) {
            if (actual !== null && actual !== undefined) return false;
        } else if (comparable(actual) !== comparable(condition)) {
            return false;
        }
    }
    return true;
}

function clone(value) {
    return structuredClone(value);
}

function businessStore(overrides = {}) {
    const document = {
        _id: "mongo-business-1",
        businessId: "business-1",
        name: "Test Business",
        ownerEmail: "owner@example.com",
        status: "active",
        stripeSubscriptionId: "sub_1",
        billingStatus: "past_due",
        billingFailedAt: new Date("2026-08-06T12:00:00.000Z"),
        offlineServiceRestricted: false,
        offlineServiceRestrictedAt: null,
        billingLifecycleClaims: {
            upcomingInvoice: {},
            overdueWarningDay3: {},
            overdueWarningDay5: {},
            restrictService: {},
            restoreService: {},
        },
        ...overrides,
    };
    return {
        document,
        findOne(filter) {
            return { lean: async () => matches(document, filter) ? clone(document) : null };
        },
        findOneAndUpdate(filter, update) {
            if (!matches(document, filter)) {
                return { lean: async () => null };
            }
            for (const [path, value] of Object.entries(update.$set || {})) {
                setPath(document, path, value);
            }
            return { lean: async () => clone(document) };
        },
        async updateOne(filter, update) {
            if (!matches(document, filter)) return { matchedCount: 0, modifiedCount: 0 };
            for (const [path, value] of Object.entries(update.$set || {})) {
                setPath(document, path, value);
            }
            return { matchedCount: 1, modifiedCount: 1 };
        },
    };
}

function candidatesFor(jobName, businesses) {
    return (definition) => definition.jobName === jobName ? businesses : [];
}

test("concurrent billing scans and period claims send one notice", async () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const store = businessStore();
    const snapshot = clone(store.document);
    let notices = 0;
    const runScan = () => scanBillingLifecycleCandidates({
        now,
        candidateSource: candidatesFor(
            BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3,
            [snapshot],
        ),
        handleCandidate: (action) => processBillingLifecycleAction({
            ...action,
            businessModel: store,
            claimId: `claim-${Math.random()}`,
            sendNotification: async () => {
                notices += 1;
                return { success: true, messageId: "message-1" };
            },
        }),
    });

    await Promise.all([runScan(), runScan()]);
    assert.equal(notices, 1);

    const periodKey = getBillingActionPeriodKey(
        BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3,
        store.document,
    );
    const duplicate = await processBillingLifecycleAction({
        jobName: BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3,
        businessId: store.document.businessId,
        periodKey,
        now,
        businessModel: store,
        sendNotification: async () => assert.fail("duplicate notice"),
    });
    assert.equal(duplicate.skipped, true);
    assert.equal(
        store.document.billingLifecycleClaims.overdueWarningDay3.status,
        "completed",
    );
});

test("restriction is conditionally durable before its notification", async () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const store = businessStore({
        billingFailedAt: new Date("2026-08-01T12:00:00.000Z"),
    });
    const jobName = BILLING_JOB_NAMES.RESTRICT_SERVICE;
    const periodKey = getBillingActionPeriodKey(jobName, store.document);
    let observedDurableState = false;
    const result = await processBillingLifecycleAction({
        jobName,
        businessId: store.document.businessId,
        periodKey,
        now,
        businessModel: store,
        sendNotification: async () => {
            observedDurableState = store.document.offlineServiceRestricted === true;
            return { success: true, messageId: "restriction-message" };
        },
    });

    assert.equal(result.success, true);
    assert.equal(observedDurableState, true);
    assert.equal(store.document.offlineServiceRestricted, true);
    assert.ok(store.document.offlineServiceRestrictedAt instanceof Date);
});

test("restoration is conditionally durable before its notification", async () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const store = businessStore({
        billingStatus: "active",
        billingFailedAt: null,
        offlineServiceRestricted: true,
        offlineServiceRestrictedAt: new Date("2026-08-09T12:00:00.000Z"),
    });
    const jobName = BILLING_JOB_NAMES.RESTORE_SERVICE;
    const periodKey = getBillingActionPeriodKey(jobName, store.document);
    let observedDurableState = false;
    const result = await processBillingLifecycleAction({
        jobName,
        businessId: store.document.businessId,
        periodKey,
        now,
        businessModel: store,
        sendNotification: async () => {
            observedDurableState = store.document.offlineServiceRestricted === false;
            return { success: true, messageId: "restoration-message" };
        },
    });

    assert.equal(result.success, true);
    assert.equal(observedDurableState, true);
    assert.equal(store.document.offlineServiceRestricted, false);
    assert.equal(store.document.offlineServiceRestrictedAt, null);
    assert.equal(
        store.document.billingLifecycleClaims.restoreService.status,
        "completed",
    );
});

test("email failure does not roll back or retry a durable restriction transition", async () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const store = businessStore({
        billingFailedAt: new Date("2026-08-01T12:00:00.000Z"),
    });
    const jobName = BILLING_JOB_NAMES.RESTRICT_SERVICE;
    const periodKey = getBillingActionPeriodKey(jobName, store.document);
    const result = await processBillingLifecycleAction({
        jobName,
        businessId: store.document.businessId,
        periodKey,
        now,
        businessModel: store,
        sendNotification: async () => {
            throw new Error("provider offline");
        },
    });

    assert.equal(result.success, true);
    assert.equal(result.notification.reason, "dispatch_failed");
    assert.equal(store.document.offlineServiceRestricted, true);
    assert.equal(
        store.document.billingLifecycleClaims.restrictService.status,
        "completed",
    );
});

test("one business failure does not block other billing candidates", async () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const businesses = [
        clone(businessStore({ businessId: "business-fails" }).document),
        clone(businessStore({ businessId: "business-succeeds" }).document),
    ];
    const visited = [];
    const result = await scanBillingLifecycleCandidates({
        now,
        candidateSource: candidatesFor(
            BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3,
            businesses,
        ),
        handleCandidate: async ({ businessId }) => {
            visited.push(businessId);
            if (businessId === "business-fails") throw new Error("isolated failure");
        },
    });

    assert.deepEqual(visited, ["business-fails", "business-succeeds"]);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.completed, 1);
});

test("billing jobs use stable IDs and requested attempts/backoff", () => {
    const payload = {
        businessId: "business:1",
        periodKey: "failure-2026-08-06T12:00:00.000Z",
    };
    const first = buildBillingJobId(
        BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3,
        payload,
    );
    const second = buildBillingJobId(
        BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3,
        payload,
    );
    assert.equal(first, second);
    assert.equal(first.includes(":"), false);
    assert.equal(BILLING_JOB_OPTIONS.attempts, 8);
    assert.deepEqual(BILLING_JOB_OPTIONS.backoff, {
        type: "exponential",
        delay: 60_000,
    });
});

test("only worker runtime registers the five-minute and hourly schedulers", async () => {
    const calls = [];
    const queue = {
        async upsertJobScheduler(id, repeat, template) {
            calls.push({ id, repeat, template });
        },
    };
    const env = {
        BULLMQ_RESERVATION_SCHEDULERS_ENABLED: "true",
        BULLMQ_BILLING_SCHEDULERS_ENABLED: "true",
    };
    await registerWorkerSchedulers({
        runtime: "api",
        env,
        createQueueFn: () => queue,
    });
    assert.equal(calls.length, 0);

    const result = await registerWorkerSchedulers({
        runtime: "worker",
        env,
        createQueueFn: () => queue,
    });
    assert.deepEqual(result, {
        reservation: true,
        billing: true,
        postPayment: false,
        aiAnalyst: false,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].repeat.every, 5 * 60 * 1000);
    assert.equal(calls[1].repeat.every, 60 * 60 * 1000);
    assert.equal(calls[0].template.opts.attempts, 5);
    assert.equal(calls[1].template.opts.attempts, 8);
});

function response() {
    return {
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
}

test("cron recovery endpoints stay authenticated, safe, and scheduler-free", async () => {
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "phase-2-secret";
    let billingRecoveries = 0;
    let reservationRecoveries = 0;
    try {
        const unauthorized = response();
        await processReservationExpiry(
            { headers: {}, app: { locals: {} } },
            unauthorized,
        );
        assert.equal(unauthorized.statusCode, 401);

        const billingRes = response();
        await processBillingLifecycle(
            {
                headers: { authorization: "Bearer phase-2-secret" },
                app: {
                    locals: {
                        runBillingLifecycleRecovery: async () => {
                            billingRecoveries += 1;
                            return {
                                summary: { candidates: 0, completed: 0, failed: 0 },
                                results: [],
                            };
                        },
                    },
                },
            },
            billingRes,
        );
        const reservationRes = response();
        await processReservationExpiry(
            {
                headers: { authorization: "Bearer phase-2-secret" },
                app: {
                    locals: {
                        runReservationExpiryRepairScan: async () => {
                            reservationRecoveries += 1;
                            return { matchedCount: 1, expiredCount: 1 };
                        },
                    },
                },
            },
            reservationRes,
        );

        assert.equal(billingRecoveries, 1);
        assert.equal(reservationRecoveries, 1);
        assert.equal(billingRes.body.mode, "manual_recovery");
        assert.equal(reservationRes.body.expiredCount, 1);
    } finally {
        if (previousSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = previousSecret;
    }
});
