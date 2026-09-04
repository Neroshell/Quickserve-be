import assert from "node:assert/strict";
import test from "node:test";
import {
    enqueueReservationPaymentExpiry,
    RESERVATION_JOB_OPTIONS,
} from "../src/queues/reservationQueue.js";
import { RESERVATION_JOB_NAMES } from "../src/queues/queueNames.js";
import {
    expireReservationPaymentWindow,
    runReservationExpiryRepairScan,
} from "../src/services/reservationExpiryService.js";
import { processReservationJob } from "../src/workers/processors/reservationProcessor.js";
import {
    registerWorkerSchedulers,
} from "../src/workers/registerSchedulers.js";
import Business from "../src/models/Business.js";
import Reservation from "../src/models/Reservation.js";
import { updateReservationStatus } from "../src/controllers/reservationController.js";

function same(value, expected) {
    if (value instanceof Date || expected instanceof Date) {
        return new Date(value).getTime() === new Date(expected).getTime();
    }
    return String(value) === String(expected);
}

function reservationStore(overrides = {}) {
    const document = {
        _id: "reservation-1",
        businessId: "business-1",
        status: "accepted_awaiting_payment",
        paymentStatus: "pending",
        paymentExpiresAt: new Date("2026-08-02T12:00:00.000Z"),
        ...overrides,
    };
    let transitions = 0;
    return {
        document,
        get transitions() {
            return transitions;
        },
        findOne(filter) {
            const found = same(document._id, filter._id) &&
                same(document.businessId, filter.businessId);
            return { lean: async () => found ? { ...document } : null };
        },
        async findOneAndUpdate(filter, update) {
            const matches = same(document._id, filter._id) &&
                same(document.businessId, filter.businessId) &&
                document.status === filter.status &&
                document.paymentStatus !== filter.paymentStatus.$ne &&
                same(document.paymentExpiresAt, filter.paymentExpiresAt);
            if (!matches) return null;
            Object.assign(document, update.$set);
            transitions += 1;
            return { ...document };
        },
    };
}

test("delayed expiry expires an unpaid reservation exactly once", async () => {
    const store = reservationStore();
    const payload = {
        businessId: "business-1",
        reservationId: "reservation-1",
        expectedPaymentExpiry: "2026-08-02T12:00:00.000Z",
    };
    const first = await expireReservationPaymentWindow({
        ...payload,
        now: new Date("2026-08-02T12:00:01.000Z"),
        reservationModel: store,
    });
    const duplicate = await expireReservationPaymentWindow({
        ...payload,
        now: new Date("2026-08-02T12:00:02.000Z"),
        reservationModel: store,
    });

    assert.equal(first.expired, true);
    assert.equal(duplicate.expired, false);
    assert.equal(duplicate.reason, "status_changed");
    assert.equal(store.document.status, "expired");
    assert.equal(store.transitions, 1);
});

test("paid reservations and changed expiry versions are successful no-ops", async () => {
    const base = {
        businessId: "business-1",
        reservationId: "reservation-1",
        expectedPaymentExpiry: "2026-08-02T12:00:00.000Z",
        now: new Date("2026-08-02T12:00:01.000Z"),
    };
    const paidStore = reservationStore({ paymentStatus: "paid" });
    const changedStore = reservationStore({
        paymentExpiresAt: new Date("2026-08-02T12:30:00.000Z"),
    });

    const paid = await expireReservationPaymentWindow({
        ...base,
        reservationModel: paidStore,
    });
    const changed = await expireReservationPaymentWindow({
        ...base,
        reservationModel: changedStore,
    });

    assert.equal(paid.reason, "already_paid");
    assert.equal(changed.reason, "expiry_changed");
    assert.equal(paidStore.transitions, 0);
    assert.equal(changedStore.transitions, 0);
});

test("repair scan catches missed unpaid expiry and returns counts", async () => {
    let filter;
    const result = await runReservationExpiryRepairScan({
        now: new Date("2026-08-02T12:05:00.000Z"),
        reservationModel: {
            async updateMany(nextFilter) {
                filter = nextFilter;
                return { matchedCount: 3, modifiedCount: 2 };
            },
        },
    });

    assert.equal(filter.status, "accepted_awaiting_payment");
    assert.deepEqual(filter.paymentStatus, { $ne: "paid" });
    assert.ok(filter.paymentExpiresAt.$lte instanceof Date);
    assert.deepEqual(result, { matchedCount: 3, expiredCount: 2 });
});

test("reservation queue uses a versioned stable ID and requested retry policy", async () => {
    const added = [];
    const queue = {
        async add(name, data, options) {
            added.push({ name, data, options });
            return { id: options.jobId };
        },
    };
    const payload = {
        businessId: "business-1",
        reservationId: "reservation:1",
        expectedPaymentExpiry: "2026-08-02T12:00:00.000Z",
    };
    const options = {
        env: { BULLMQ_RESERVATION_SCHEDULERS_ENABLED: "true" },
        queue,
        now: new Date("2026-08-02T11:30:00.000Z"),
    };
    const first = await enqueueReservationPaymentExpiry(payload, options);
    const second = await enqueueReservationPaymentExpiry(payload, options);

    assert.equal(first.jobId, second.jobId);
    assert.equal(first.jobId.includes(":"), false);
    assert.equal(added[0].name, RESERVATION_JOB_NAMES.EXPIRE_PAYMENT_WINDOW);
    assert.equal(added[0].options.delay, 30 * 60 * 1000);
    assert.equal(added[0].options.attempts, 5);
    assert.deepEqual(added[0].options.backoff, RESERVATION_JOB_OPTIONS.backoff);
});

test("disabled flags preserve behavior and only worker runtime registers schedulers", async () => {
    let queueCreates = 0;
    const createQueueFn = () => {
        queueCreates += 1;
        return { async upsertJobScheduler() {} };
    };
    const enabled = {
        BULLMQ_RESERVATION_SCHEDULERS_ENABLED: "true",
        BULLMQ_BILLING_SCHEDULERS_ENABLED: "true",
    };

    const disabledEnqueue = await enqueueReservationPaymentExpiry(
        {
            businessId: "business-1",
            reservationId: "reservation-1",
            expectedPaymentExpiry: "2026-08-02T12:00:00.000Z",
        },
        { env: {}, queue: { add: () => assert.fail("must not enqueue") } },
    );
    const apiRegistration = await registerWorkerSchedulers({
        runtime: "api",
        env: enabled,
        createQueueFn,
    });
    const disabledWorker = await registerWorkerSchedulers({
        runtime: "worker",
        env: {},
        createQueueFn,
    });

    assert.equal(disabledEnqueue.queued, false);
    assert.deepEqual(apiRegistration, {
        reservation: false,
        billing: false,
        postPayment: false,
        aiAnalyst: false,
        inventory: false,
    });
    assert.deepEqual(disabledWorker, {
        reservation: false,
        billing: false,
        postPayment: false,
        aiAnalyst: false,
        inventory: false,
    });
    assert.equal(queueCreates, 0);
});

test("reservation processor routes repair and delayed jobs without changing payment truth", async () => {
    let repairCalls = 0;
    let expiryCalls = 0;
    await processReservationJob(
        { name: RESERVATION_JOB_NAMES.EXPIRY_REPAIR_SCAN, data: {} },
        { repairScan: async () => ({ expiredCount: ++repairCalls }) },
    );
    await processReservationJob(
        {
            name: RESERVATION_JOB_NAMES.EXPIRE_PAYMENT_WINDOW,
            data: {
                businessId: "business-1",
                reservationId: "reservation-1",
                expectedPaymentExpiry: "2026-08-02T12:00:00.000Z",
            },
        },
        { expireOne: async () => ({ expired: ++expiryCalls === 1 }) },
    );
    assert.equal(repairCalls, 1);
    assert.equal(expiryCalls, 1);
});

test("acceptance enqueues delayed expiry only after payment expiry is persisted", async (t) => {
    let persisted = false;
    let scheduledPayload = null;
    const reservation = {
        _id: "reservation-accept-1",
        businessId: "hotel-1",
        status: "pending_approval",
        paymentStatus: "pending",
        checkInDate: "2026-09-01",
        checkOutDate: "2026-09-02",
        pricingSnapshotVersion: 1,
        subtotal: 100,
        grossAmount: 10000,
        activeRefundId: null,
        email: null,
        async save() {
            persisted = Boolean(this.paymentExpiresAt) &&
                this.status === "accepted_awaiting_payment";
        },
        toObject() {
            return { ...this };
        },
    };
    t.mock.method(Reservation, "findOne", async () => reservation);
    t.mock.method(Business, "findOne", () => ({
        lean: async () => ({
            businessId: "hotel-1",
            businessType: "hotel",
            modules: ["lodging"],
            ownerEmail: "owner@example.com",
        }),
    }));
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

    await updateReservationStatus(
        {
            params: { id: reservation._id },
            body: { status: "accepted_awaiting_payment" },
            session: {
                user: {
                    businessId: "hotel-1",
                    role: "owner",
                    email: "owner@example.com",
                },
            },
            app: {
                locals: {
                    enqueueReservationPaymentExpiry: async (payload) => {
                        assert.equal(persisted, true);
                        scheduledPayload = payload;
                        return { queued: true };
                    },
                    publishEvent: async () => ({ published: false }),
                },
            },
        },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(scheduledPayload.businessId, "hotel-1");
    assert.equal(scheduledPayload.reservationId, reservation._id);
    assert.equal(
        new Date(scheduledPayload.expectedPaymentExpiry).getTime(),
        new Date(reservation.paymentExpiresAt).getTime(),
    );
});
