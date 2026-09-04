import assert from "node:assert/strict";
import test from "node:test";
import {
    buildCrmOrderJobId,
    enqueueCrmOrder,
    POST_PAYMENT_JOB_OPTIONS,
} from "../src/queues/postPaymentQueue.js";
import { POST_PAYMENT_JOB_NAMES } from "../src/queues/queueNames.js";
import {
    CRM_ORDER_CLAIM_LEASE_MS,
    dispatchCrmOrder,
    processCrmOrder,
    scanCrmOrderRepairs,
} from "../src/services/guestProfileService.js";
import {
    claimStripeWebhookEvent,
    completeStripeWebhookEvent,
} from "../src/services/stripeWebhookEventService.js";
import { confirmReservationPaymentAtomic } from "../src/services/reservationPaymentConfirmationService.js";
import { processPostPaymentJob } from "../src/workers/processors/postPaymentProcessor.js";
import { registerWorkerSchedulers } from "../src/workers/registerSchedulers.js";

function clone(value) {
    return structuredClone(value);
}

function key(businessId, value) {
    return `${businessId}::${value}`;
}

function createCrmRepository({ orders, businesses, failReplaceProfile = 0 }) {
    const orderMap = new Map(orders.map((order) => [
        key(order.businessId, order.orderId),
        clone({
            crmProcessed: false,
            crmProcessingStatus: "pending",
            crmProcessingRetryable: true,
            crmProcessingAttemptCount: 0,
            ...order,
        }),
    ]));
    const businessMap = new Map(businesses.map((business) => [business.businessId, clone(business)]));
    const ledgers = new Map();
    const profiles = new Map();
    const visits = new Map();
    let remainingProfileFailures = failReplaceProfile;

    const repository = {
        orderMap,
        businessMap,
        ledgers,
        profiles,
        visits,

        async claimOrder({ businessId, orderId, claimId, now, staleBefore }) {
            const order = orderMap.get(key(businessId, orderId));
            if (!order || order.paymentStatus !== "paid" || order.crmProcessed || !order.crmEmail) {
                return null;
            }
            const eligible = !order.crmProcessingStatus ||
                order.crmProcessingStatus === "pending" ||
                (order.crmProcessingStatus === "failed" && order.crmProcessingRetryable !== false) ||
                (order.crmProcessingStatus === "processing" &&
                    new Date(order.crmProcessingClaimedAt) <= staleBefore);
            if (!eligible) return null;
            order.crmProcessingStatus = "processing";
            order.crmProcessingClaimId = claimId;
            order.crmProcessingClaimedAt = now;
            order.crmProcessingAttemptCount += 1;
            return clone(order);
        },

        async loadOrder({ businessId, orderId }) {
            const order = orderMap.get(key(businessId, orderId));
            return order ? clone(order) : null;
        },

        async loadBusiness({ businessId }) {
            const business = businessMap.get(businessId);
            return business ? clone(business) : null;
        },

        async ensureLedger(contribution) {
            const ledgerKey = key(contribution.businessId, contribution.orderId);
            if (!ledgers.has(ledgerKey)) {
                ledgers.set(ledgerKey, clone({ ...contribution, status: "pending" }));
            }
            return clone(ledgers.get(ledgerKey));
        },

        async claimGuest({ businessId, email, claimId, now, staleBefore }) {
            const profileKey = key(businessId, email);
            const profile = profiles.get(profileKey) || {
                businessId,
                email,
                guestStatus: "lead",
                visitCount: 0,
                orderCount: 0,
                paidOrderCount: 0,
                totalSpendCents: 0,
                favouriteItems: [],
            };
            if (
                profile.crmProjectionClaimId &&
                new Date(profile.crmProjectionClaimedAt) > staleBefore
            ) return null;
            profile.crmProjectionClaimId = claimId;
            profile.crmProjectionClaimedAt = now;
            profiles.set(profileKey, profile);
            return clone(profile);
        },

        async ensureProfileBaseline({ businessId, email, profile, now }) {
            const stored = profiles.get(key(businessId, email));
            if (!stored.crmProjectionBaseline) {
                stored.crmProjectionBaseline = {
                    capturedAt: now,
                    firstVisitAt: profile.firstVisitAt || null,
                    lastVisitAt: profile.lastVisitAt || null,
                    firstOrderId: profile.firstOrderId || null,
                    lastOrderId: profile.lastOrderId || null,
                    visitCount: profile.visitCount || 0,
                    orderCount: profile.orderCount || 0,
                    paidOrderCount: profile.paidOrderCount || 0,
                    totalSpendCents: profile.totalSpendCents || 0,
                    favouriteItems: profile.favouriteItems || [],
                };
            }
            return clone(stored.crmProjectionBaseline);
        },

        async ensureVisitBaseline({ businessId, email, visitDate, now }) {
            const visit = visits.get(key(businessId, `${email}::${visitDate}`));
            if (!visit) {
                return {
                    exists: false,
                    existed: false,
                    capturedAt: now,
                    orderIds: [],
                    paidOrderIds: [],
                    spendCents: 0,
                };
            }
            return clone(visit.baseline);
        },

        async listLedgerEntries({ businessId, email }) {
            return [...ledgers.values()]
                .filter((entry) => entry.businessId === businessId && entry.email === email)
                .map(clone);
        },

        async replaceProfile({ businessId, email, projection }) {
            if (remainingProfileFailures > 0) {
                remainingProfileFailures -= 1;
                throw new Error("simulated projection failure");
            }
            Object.assign(profiles.get(key(businessId, email)), clone(projection));
        },

        async replaceVisit({ businessId, email, visit, now }) {
            const visitKey = key(businessId, `${email}::${visit.visitDate}`);
            visits.set(visitKey, {
                businessId,
                email,
                visitDate: visit.visitDate,
                orderIds: clone(visit.orderIds),
                paidOrderIds: clone(visit.paidOrderIds),
                spendCents: visit.spendCents,
                baseline: clone(visit.baseline || {
                    exists: false,
                    existed: false,
                    capturedAt: now,
                    orderIds: [],
                    paidOrderIds: [],
                    spendCents: 0,
                }),
            });
        },

        async completeLedger({ businessId, orderId, now }) {
            Object.assign(ledgers.get(key(businessId, orderId)), {
                status: "completed",
                completedAt: now,
            });
        },

        async completeOrder({ businessId, orderId, claimId, now }) {
            const order = orderMap.get(key(businessId, orderId));
            assert.equal(order.crmProcessingClaimId, claimId);
            Object.assign(order, {
                crmProcessed: true,
                crmProcessedAt: now,
                crmProcessingStatus: "completed",
                crmProcessingClaimId: null,
                crmProcessingClaimedAt: null,
                crmProcessingRetryable: false,
            });
        },

        async failOrder({ businessId, orderId, claimId, now, error, retryable }) {
            const order = orderMap.get(key(businessId, orderId));
            if (order?.crmProcessingClaimId !== claimId) return;
            Object.assign(order, {
                crmProcessingStatus: "failed",
                crmProcessingFailedAt: now,
                crmProcessingLastError: error.message,
                crmProcessingRetryable: retryable,
                crmProcessingClaimId: null,
                crmProcessingClaimedAt: null,
            });
        },

        async releaseGuest({ businessId, email, claimId }) {
            const profile = profiles.get(key(businessId, email));
            if (profile?.crmProjectionClaimId === claimId) {
                profile.crmProjectionClaimId = null;
                profile.crmProjectionClaimedAt = null;
            }
        },
    };
    return repository;
}

function paidOrder(overrides = {}) {
    return {
        businessId: "business-a",
        orderId: "ORDER-1",
        paymentStatus: "paid",
        crmEmail: "guest@example.com",
        paidAt: new Date("2026-08-03T10:00:00.000Z"),
        createdAt: new Date("2026-08-03T09:55:00.000Z"),
        total: 12,
        tipAmount: 2,
        items: [{ itemName: "Pizza", quantity: 1 }],
        ...overrides,
    };
}

test("duplicate and concurrent CRM jobs never double count", async () => {
    const repository = createCrmRepository({
        orders: [paidOrder()],
        businesses: [{ businessId: "business-a", timezone: "UTC" }],
    });
    const [first, concurrent] = await Promise.all([
        processCrmOrder({ businessId: "business-a", orderId: "ORDER-1", repository }),
        processCrmOrder({ businessId: "business-a", orderId: "ORDER-1", repository }),
    ]);
    const duplicate = await processCrmOrder({
        businessId: "business-a",
        orderId: "ORDER-1",
        repository,
    });
    const profile = repository.profiles.get(key("business-a", "guest@example.com"));

    assert.equal([first, concurrent].filter((result) => result.completed).length, 1);
    assert.equal(duplicate.reason, "already_completed");
    assert.equal(profile.orderCount, 1);
    assert.equal(profile.paidOrderCount, 1);
    assert.equal(profile.totalSpendCents, 1000);
    assert.equal(repository.ledgers.size, 1);
});

test("a worker crash after an Order claim is recoverable after the lease", async () => {
    const repository = createCrmRepository({
        orders: [paidOrder()],
        businesses: [{ businessId: "business-a", timezone: "UTC" }],
    });
    const crashedAt = new Date("2026-08-03T10:05:00.000Z");
    await repository.claimOrder({
        businessId: "business-a",
        orderId: "ORDER-1",
        claimId: "dead-worker",
        now: crashedAt,
        staleBefore: new Date(crashedAt.getTime() - CRM_ORDER_CLAIM_LEASE_MS),
    });
    const recovered = await processCrmOrder({
        businessId: "business-a",
        orderId: "ORDER-1",
        now: new Date(crashedAt.getTime() + CRM_ORDER_CLAIM_LEASE_MS + 1),
        repository,
    });
    assert.equal(recovered.completed, true);
    assert.equal(
        repository.orderMap.get(key("business-a", "ORDER-1")).crmProcessingStatus,
        "completed",
    );
});

test("the same email is isolated across businesses", async () => {
    const repository = createCrmRepository({
        orders: [
            paidOrder(),
            paidOrder({ businessId: "business-b", orderId: "ORDER-2", total: 20 }),
        ],
        businesses: [
            { businessId: "business-a", timezone: "UTC" },
            { businessId: "business-b", timezone: "UTC" },
        ],
    });
    await processCrmOrder({ businessId: "business-a", orderId: "ORDER-1", repository });
    await processCrmOrder({ businessId: "business-b", orderId: "ORDER-2", repository });

    assert.equal(repository.profiles.size, 2);
    assert.equal(
        repository.profiles.get(key("business-a", "guest@example.com")).totalSpendCents,
        1000,
    );
    assert.equal(
        repository.profiles.get(key("business-b", "guest@example.com")).totalSpendCents,
        1800,
    );
});

test("multiple paid orders on one local business day update exactly one visit", async () => {
    const repository = createCrmRepository({
        orders: [
            paidOrder(),
            paidOrder({
                orderId: "ORDER-2",
                paidAt: new Date("2026-08-03T20:00:00.000Z"),
                total: 8,
                tipAmount: 0,
                items: [{ itemName: "Pizza", quantity: 2 }],
            }),
        ],
        businesses: [{ businessId: "business-a", timezone: "Europe/Berlin" }],
    });
    await processCrmOrder({ businessId: "business-a", orderId: "ORDER-1", repository });
    await processCrmOrder({ businessId: "business-a", orderId: "ORDER-2", repository });
    const profile = repository.profiles.get(key("business-a", "guest@example.com"));
    const visits = [...repository.visits.values()];

    assert.equal(profile.visitCount, 1);
    assert.equal(profile.orderCount, 2);
    assert.equal(profile.totalSpendCents, 1800);
    assert.equal(profile.favouriteItems[0].quantity, 3);
    assert.equal(visits.length, 1);
    assert.deepEqual(visits[0].paidOrderIds.sort(), ["ORDER-1", "ORDER-2"]);
    assert.equal(visits[0].spendCents, 1800);
});

test("failed CRM processing is visible and remains repairable", async () => {
    const repository = createCrmRepository({
        orders: [paidOrder()],
        businesses: [{ businessId: "business-a", timezone: "UTC" }],
        failReplaceProfile: 1,
    });
    await assert.rejects(
        processCrmOrder({ businessId: "business-a", orderId: "ORDER-1", repository }),
        /simulated projection failure/,
    );
    const failed = repository.orderMap.get(key("business-a", "ORDER-1"));
    assert.equal(failed.paymentStatus, "paid");
    assert.equal(failed.crmProcessingStatus, "failed");
    assert.equal(failed.crmProcessingRetryable, true);

    const repaired = await processCrmOrder({
        businessId: "business-a",
        orderId: "ORDER-1",
        now: new Date("2026-08-03T10:10:00.000Z"),
        repository,
    });
    assert.equal(repaired.completed, true);
    assert.equal(repository.profiles.get(key("business-a", "guest@example.com")).orderCount, 1);
});

test("repair scanning isolates one business enqueue failure from the others", async () => {
    const candidates = [
        { ...paidOrder(), _id: "1", crmProcessingStatus: "failed", crmProcessingFailedAt: new Date(0) },
        { ...paidOrder({ businessId: "business-b", orderId: "ORDER-2" }), _id: "2", crmProcessingStatus: "pending" },
    ];
    const orderModel = {
        find(filter) {
            const chain = {
                sort() { return chain; },
                limit() { return chain; },
                async lean() {
                    return clone(candidates.filter(
                        (order) => order.businessId === filter.businessId,
                    ));
                },
            };
            return chain;
        },
        async updateOne() { return { matchedCount: 1 }; },
    };
    const businessModel = {
        find() {
            const chain = {
                select() { return chain; },
                sort() { return chain; },
                limit() { return chain; },
                async lean() {
                    return [
                        { _id: "business-1", businessId: "business-a" },
                        { _id: "business-2", businessId: "business-b" },
                    ];
                },
            };
            return chain;
        },
    };
    const summary = await scanCrmOrderRepairs({
        now: new Date("2026-08-03T11:00:00.000Z"),
        orderModel,
        businessModel,
        env: { BULLMQ_POST_PAYMENT_ENABLED: "true" },
        enqueue: async ({ businessId }) => {
            if (businessId === "business-a") throw new Error("Redis unavailable for A");
            return { queued: true };
        },
    });
    assert.deepEqual(summary, { candidates: 2, queued: 1, failed: 1, batches: 2 });
});

test("CRM enqueue failure cannot change authoritative paid state", async () => {
    const paid = paidOrder();
    const updates = [];
    const result = await dispatchCrmOrder({
        businessId: paid.businessId,
        orderId: paid.orderId,
        env: { BULLMQ_POST_PAYMENT_ENABLED: "true" },
        enqueue: async () => { throw new Error("Redis down"); },
        orderModel: {
            async updateOne(filter, update) { updates.push({ filter, update }); },
        },
    });
    assert.equal(result.queued, false);
    assert.equal(paid.paymentStatus, "paid");
    assert.equal(updates.some(({ update }) => update.$set?.paymentStatus), false);
});

test("the disabled queue flag preserves CRM behavior through the durable direct path", async () => {
    let directCalls = 0;
    const result = await dispatchCrmOrder({
        businessId: "business-a",
        orderId: "ORDER-1",
        env: {},
        enqueue: async () => ({
            queued: false,
            reason: "post_payment_queue_disabled",
        }),
        isDatabaseReady: () => true,
        processOrder: async ({ businessId, orderId }) => {
            directCalls += 1;
            return { completed: true, businessId, orderId };
        },
    });
    assert.equal(directCalls, 1);
    assert.equal(result.direct, true);
    assert.equal(result.result.completed, true);
});

test("post-payment queue and worker use the requested stable ID and retry policy", async () => {
    const added = [];
    const payload = { businessId: "business:a", orderId: "ORDER:1" };
    const queued = await enqueueCrmOrder(payload, {
        env: { BULLMQ_POST_PAYMENT_ENABLED: "true" },
        queue: {
            async add(name, data, options) {
                added.push({ name, data, options });
                return { id: options.jobId };
            },
        },
    });
    assert.equal(queued.jobId, buildCrmOrderJobId(payload));
    assert.equal(queued.jobId, "postpayment-crm-order-business-a-ORDER-1");
    assert.equal(added[0].name, POST_PAYMENT_JOB_NAMES.CRM_ORDER);
    assert.equal(added[0].options.attempts, 8);
    assert.deepEqual(added[0].options.backoff, POST_PAYMENT_JOB_OPTIONS.backoff);

    const processed = await processPostPaymentJob(
        { name: POST_PAYMENT_JOB_NAMES.CRM_ORDER, data: payload },
        { processOrder: async (data) => ({ completed: true, ...data }) },
    );
    assert.equal(processed.completed, true);
});

test("post-payment repair scheduler registers only in the worker and respects its flag", async () => {
    const registrations = [];
    const createQueueFn = () => ({
        async upsertJobScheduler(id, repeat, job) {
            registrations.push({ id, repeat, job });
        },
    });
    const env = { BULLMQ_POST_PAYMENT_ENABLED: "true" };
    const api = await registerWorkerSchedulers({ runtime: "api", env, createQueueFn });
    const worker = await registerWorkerSchedulers({ runtime: "worker", env, createQueueFn });
    const disabled = await registerWorkerSchedulers({ runtime: "worker", env: {}, createQueueFn });

    assert.deepEqual(api, { reservation: false, billing: false, postPayment: false, aiAnalyst: false, inventory: false });
    assert.deepEqual(worker, { reservation: false, billing: false, postPayment: true, aiAnalyst: false, inventory: false });
    assert.deepEqual(disabled, { reservation: false, billing: false, postPayment: false, aiAnalyst: false, inventory: false });
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].job.name, POST_PAYMENT_JOB_NAMES.CRM_ORDER_REPAIR_SCAN);
});

test("reservation payment confirmation uses a conditional tenant-scoped update", async () => {
    let filter;
    let update;
    const paidReservation = paidOrder({ _id: "reservation-1", status: "confirmed" });
    const result = await confirmReservationPaymentAtomic({
        reservationId: "reservation-1",
        businessId: "business-a",
        expectedAmountCents: 1000,
        expectedCurrency: "EUR",
        checkoutSessionId: "cs_1",
        paymentIntentId: "pi_1",
        reservationModel: {
            async findOneAndUpdate(nextFilter, nextUpdate) {
                filter = nextFilter;
                update = nextUpdate;
                return paidReservation;
            },
        },
    });
    assert.equal(result.transitioned, true);
    assert.equal(filter.businessId, "business-a");
    assert.equal(filter.status, "accepted_awaiting_payment");
    assert.deepEqual(filter.paymentStatus, { $ne: "paid" });
    assert.equal(filter.grossAmount, 1000);
    assert.equal(filter.currency, "eur");
    assert.equal(update.$set.status, "confirmed");
    assert.equal(update.$set.paymentStatus, "paid");
});

test("Stripe webhook event claims are durable and completed events deduplicate", async () => {
    let document = null;
    const query = (value) => ({ lean: async () => value ? clone(value) : null });
    const eventModel = {
        findOneAndUpdate(filter, update) {
            if (document && document.status !== "failed") {
                const error = new Error("duplicate");
                error.code = 11000;
                throw error;
            }
            document = {
                ...(document || {}),
                ...update.$setOnInsert,
                ...update.$set,
                attemptCount: (document?.attemptCount || 0) + 1,
            };
            return query(document);
        },
        findOne() { return query(document); },
        async updateOne(filter, update) {
            if (document.eventId !== filter.eventId || document.claimId !== filter.claimId) {
                return { matchedCount: 0 };
            }
            Object.assign(document, update.$set);
            return { matchedCount: 1 };
        },
    };
    const claim = await claimStripeWebhookEvent({
        eventId: "evt_1",
        eventType: "checkout.session.completed",
        claimId: "claim-1",
        eventModel,
    });
    assert.equal(claim.claimed, true);
    await completeStripeWebhookEvent({
        eventId: "evt_1",
        claimId: "claim-1",
        eventModel,
    });
    const duplicate = await claimStripeWebhookEvent({
        eventId: "evt_1",
        eventType: "checkout.session.completed",
        claimId: "claim-2",
        eventModel,
    });
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.reason, "already_processed");
});
