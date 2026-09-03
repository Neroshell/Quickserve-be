import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
    getStripeInvoiceCustomerId,
    getStripeInvoiceSubscriptionId,
    mapStripeInvoiceToLedger,
    listBillingInvoicesForBusiness,
    upsertBillingInvoiceFromStripe,
} from "../src/services/billingInvoiceLedgerService.js";
import {
    attemptPastDueInvoicePayment,
    findRecoverableStripeInvoice,
} from "../src/services/billingRecoveryService.js";
import { dispatchBillingNotification } from "../src/services/email/emailDispatchService.js";
import {
    buildBillingNotification,
    ensureBillingEmailIntent,
    processBillingEmailDelivery,
    resolveBillingCurrency,
} from "../src/services/email/billingEmailDeliveryService.js";
import {
    buildEmailJobId,
    validateEmailJobPayload,
} from "../src/queues/emailQueue.js";
import {
    BILLING_JOB_NAMES,
    EMAIL_JOB_NAMES,
} from "../src/queues/queueNames.js";
import {
    formatMoneyFromMinorUnits,
    getCurrencyMinorUnitExponent,
    minorUnitsToMajor,
} from "../src/utils/money.js";
import { isBillingActionDue } from "../src/services/billingLifecycleService.js";

function stripeInvoice(overrides = {}) {
    return {
        id: "in_123",
        subscription: "sub_123",
        customer: "cus_123",
        status: "paid",
        paid: true,
        currency: "eur",
        amount_due: 1599,
        amount_paid: 1599,
        subtotal: 1400,
        total_tax_amounts: [{ amount: 199 }],
        period_start: 1785542400,
        period_end: 1788220800,
        created: 1788220800,
        status_transitions: { paid_at: 1788220810 },
        hosted_invoice_url: "https://invoice.stripe.test/in_123",
        invoice_pdf: "https://invoice.stripe.test/in_123.pdf",
        ...overrides,
    };
}

test("Stripe paid invoices map to a complete integer-minor-unit ledger row", () => {
    const mapped = mapStripeInvoiceToLedger({
        businessId: "business-1",
        invoice: stripeInvoice(),
        eventType: "invoice.paid",
    });
    assert.equal(mapped.businessId, "business-1");
    assert.equal(mapped.status, "paid");
    assert.equal(mapped.currency, "EUR");
    assert.equal(mapped.amountDue, 1599);
    assert.equal(mapped.amountPaid, 1599);
    assert.equal(mapped.tax, 199);
    assert.equal(mapped.hostedInvoiceUrl, "https://invoice.stripe.test/in_123");
    assert.equal(mapped.invoicePdf, "https://invoice.stripe.test/in_123.pdf");
    assert.ok(mapped.stripeCreatedAt instanceof Date);
    assert.ok(mapped.paidAt instanceof Date);
});

test("both invoice webhook paths wire the durable ledger before optional email", async () => {
    const source = await readFile(
        new URL("../src/controllers/webhookController.js", import.meta.url),
        "utf8",
    );
    const paidStart = source.indexOf('event.type === "invoice.paid"');
    const failedStart = source.indexOf('event.type === "invoice.payment_failed"');
    const nextEvent = source.indexOf('event.type === "customer.subscription.updated"');
    const paidSource = source.slice(paidStart, failedStart);
    const failedSource = source.slice(failedStart, nextEvent);
    assert.match(paidSource, /await billingInvoiceUpsert\(/);
    assert.match(paidSource, /billingStatus: "active"/);
    assert.ok(paidSource.indexOf("billingInvoiceUpsert") < paidSource.indexOf("billingEmailDispatcher"));
    assert.match(paidSource, /Billing email dispatch failed after paid state persisted/);
    assert.match(failedSource, /billingStatus: ['"]past_due['"]/);
    assert.match(failedSource, /await billingInvoiceUpsert\(/);
});

test("failed Stripe invoices retain their exact currency and failure state", () => {
    const mapped = mapStripeInvoiceToLedger({
        businessId: "business-1",
        invoice: stripeInvoice({ paid: false, status: "open", currency: "jpy", amount_due: 1200, amount_paid: 0 }),
        eventType: "invoice.payment_failed",
    });
    assert.equal(mapped.status, "failed");
    assert.equal(mapped.currency, "JPY");
    assert.equal(mapped.amountDue, 1200);
    assert.equal(mapped.amountPaid, 0);
});

test("new Stripe invoice parent shape resolves the canonical subscription", () => {
    const invoice = stripeInvoice({
        subscription: undefined,
        parent: { subscription_details: { subscription: { id: "sub_parent" } } },
        customer: { id: "cus_parent" },
    });
    assert.equal(getStripeInvoiceSubscriptionId(invoice), "sub_parent");
    assert.equal(getStripeInvoiceCustomerId(invoice), "cus_parent");
});

test("invoice upsert is tenant scoped and idempotent by Stripe invoice ID", async () => {
    let updateCall;
    const invoiceModel = {
        findOne() { return { lean: async () => null }; },
        async findOneAndUpdate(filter, update, options) {
            updateCall = { filter, update, options };
            return update.$set;
        },
    };
    await upsertBillingInvoiceFromStripe({
        businessId: "business-1",
        invoice: stripeInvoice(),
        eventType: "invoice.paid",
        invoiceModel,
    });
    assert.deepEqual(updateCall.filter, { businessId: "business-1", stripeInvoiceId: "in_123" });
    assert.equal(updateCall.options.upsert, true);
    assert.equal(updateCall.options.runValidators, true);
});

test("invoice upsert rejects a Stripe invoice already owned by another tenant", async () => {
    const invoiceModel = {
        findOne() { return { lean: async () => ({ businessId: "business-2" }) }; },
        findOneAndUpdate: async () => assert.fail("cross-tenant update attempted"),
    };
    await assert.rejects(
        upsertBillingInvoiceFromStripe({
            businessId: "business-1",
            invoice: stripeInvoice(),
            eventType: "invoice.paid",
            invoiceModel,
        }),
        { code: "BILLING_INVOICE_TENANT_CONFLICT" },
    );
});

test("a late failure event cannot downgrade an already-paid ledger row", async () => {
    const paid = { businessId: "business-1", status: "paid" };
    const invoiceModel = {
        findOne() { return { lean: async () => paid }; },
        findOneAndUpdate: async () => assert.fail("paid row was downgraded"),
    };
    const result = await upsertBillingInvoiceFromStripe({
        businessId: "business-1",
        invoice: stripeInvoice({ paid: false, status: "open" }),
        eventType: "invoice.payment_failed",
        invoiceModel,
    });
    assert.equal(result, paid);
});

test("a failed invoice later becoming paid updates one ledger identity", async () => {
    let row = null;
    let writes = 0;
    const invoiceModel = {
        findOne() { return { lean: async () => row }; },
        async findOneAndUpdate(filter, update) {
            writes += 1;
            row = { ...(row || {}), ...update.$set };
            assert.equal(filter.stripeInvoiceId, "in_123");
            return row;
        },
    };
    await upsertBillingInvoiceFromStripe({
        businessId: "business-1",
        invoice: stripeInvoice({ paid: false, status: "open", amount_paid: 0 }),
        eventType: "invoice.payment_failed",
        invoiceModel,
    });
    assert.equal(row.status, "failed");
    await upsertBillingInvoiceFromStripe({
        businessId: "business-1",
        invoice: stripeInvoice(),
        eventType: "invoice.paid",
        invoiceModel,
    });
    assert.equal(row.status, "paid");
    assert.equal(row.stripeInvoiceId, "in_123");
    assert.equal(writes, 2);
});

test("invoice history is tenant-filtered, newest-first, and local URLs avoid Stripe reads", async () => {
    let findFilter;
    let sortSpec;
    const rows = [
        { stripeInvoiceId: "in_new", hostedInvoiceUrl: "https://local/new", invoicePdf: "https://local/new.pdf" },
        { stripeInvoiceId: "in_old", hostedInvoiceUrl: "https://local/old", invoicePdf: "https://local/old.pdf" },
    ];
    const invoiceModel = {
        find(filter) {
            findFilter = filter;
            return {
                sort(spec) {
                    sortSpec = spec;
                    return { lean: async () => rows };
                },
            };
        },
    };
    const result = await listBillingInvoicesForBusiness({
        businessId: "business-1",
        invoiceModel,
        stripeClient: { invoices: { retrieve: async () => assert.fail("unnecessary Stripe read") } },
    });
    assert.deepEqual(findFilter, { businessId: "business-1" });
    assert.deepEqual(sortSpec, { stripeCreatedAt: -1, createdAt: -1 });
    assert.equal(result[0].hosted_invoice_url, "https://local/new");
    assert.equal(result[0].invoice_pdf, "https://local/new.pdf");
});

test("legacy invoice history uses Stripe URL lookup only when both local URLs are absent", async () => {
    let retrievals = 0;
    const invoiceModel = {
        find() {
            return { sort: () => ({ lean: async () => [{ stripeInvoiceId: "in_legacy" }] }) };
        },
    };
    const [result] = await listBillingInvoicesForBusiness({
        businessId: "business-1",
        invoiceModel,
        stripeClient: {
            invoices: {
                retrieve: async () => {
                    retrievals += 1;
                    return { hosted_invoice_url: "https://stripe/legacy", invoice_pdf: "https://stripe/legacy.pdf" };
                },
            },
        },
    });
    assert.equal(retrievals, 1);
    assert.equal(result.hostedInvoiceUrl, "https://stripe/legacy");
    assert.equal(result.invoicePdf, "https://stripe/legacy.pdf");
});

test("recovery selects only an open unpaid invoice for the exact customer and subscription", async () => {
    const stripeClient = {
        invoices: {
            list: async () => ({ data: [
                stripeInvoice({ id: "wrong-sub", status: "open", paid: false, amount_remaining: 100, subscription: "sub_other" }),
                stripeInvoice({ id: "match", status: "open", paid: false, amount_remaining: 100 }),
            ] }),
        },
    };
    const result = await findRecoverableStripeInvoice({
        stripeClient,
        business: { stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_123" },
    });
    assert.equal(result.id, "match");
});

test("recovery never accepts a cross-customer invoice", async () => {
    const stripeClient = {
        invoices: { list: async () => ({ data: [stripeInvoice({ customer: "cus_other", status: "open", paid: false, amount_remaining: 100 })] }) },
    };
    assert.equal(await findRecoverableStripeInvoice({
        stripeClient,
        business: { stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_123" },
    }), null);
});

test("card recovery pays the matching invoice exactly once and leaves webhook authority intact", async () => {
    let payCalls = 0;
    const stripeClient = {
        invoices: {
            list: async () => ({ data: [stripeInvoice({ status: "open", paid: false, amount_remaining: 1599 })] }),
            pay: async (id, options) => {
                payCalls += 1;
                assert.equal(id, "in_123");
                assert.deepEqual(options, { payment_method: "pm_new" });
                return { id, paid: true, status: "paid" };
            },
        },
    };
    const result = await attemptPastDueInvoicePayment({
        stripeClient,
        business: { businessId: "business-1", billingStatus: "past_due", stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_123" },
        paymentMethodId: "pm_new",
    });
    assert.equal(payCalls, 1);
    assert.deepEqual(result, { attempted: true, recovered: true, pending: false, reason: "invoice_paid" });
});

test("recovery never lists or pays invoices for an active business", async () => {
    const stripeClient = { invoices: { list: async () => assert.fail("invoice list called"), pay: async () => assert.fail("invoice pay called") } };
    const result = await attemptPastDueInvoicePayment({
        stripeClient,
        business: { businessId: "business-1", billingStatus: "active" },
    });
    assert.equal(result.reason, "not_past_due");
});

test("card verification preserves past_due until the invoice webhook restores it", async () => {
    const source = await readFile(
        new URL("../src/controllers/billingController.js", import.meta.url),
        "utf8",
    );
    const start = source.indexOf("export async function verifyPaymentMethod");
    const end = source.indexOf("// --- Stripe Subscription Helpers ---", start);
    const verifySource = source.slice(start, end);
    assert.match(verifySource, /const wasPastDue = existingBiz\.billingStatus === "past_due"/);
    assert.match(verifySource, /billingStatus: wasPastDue \? 'past_due' : 'active'/);
    assert.match(verifySource, /paymentMethodId: paymentMethod\.id/);
    assert.ok(verifySource.indexOf("defaultPaymentMethodId") < verifySource.indexOf("attemptPastDueInvoicePayment"));
    assert.doesNotMatch(verifySource, /recovery\.recovered[\s\S]{0,100}billingStatus/);
});

test("a declined immediate recovery remains past due without throwing", async () => {
    const stripeClient = {
        invoices: {
            list: async () => ({ data: [stripeInvoice({ status: "open", paid: false, amount_remaining: 1599 })] }),
            pay: async () => { throw Object.assign(new Error("declined"), { code: "card_declined" }); },
        },
    };
    const result = await attemptPastDueInvoicePayment({
        stripeClient,
        business: { businessId: "business-1", billingStatus: "past_due", stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_123" },
    });
    assert.equal(result.attempted, true);
    assert.equal(result.recovered, false);
    assert.equal(result.reason, "invoice_payment_failed");
});

test("billing email dispatch persists intent before enqueue and uses a stable job contract", async () => {
    const calls = [];
    const result = await dispatchBillingNotification({
        jobName: EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS,
        businessId: "business-1",
        entityId: "in_123",
        recipient: "owner@example.com",
        metadata: { stripeInvoiceId: "in_123" },
        env: { BULLMQ_EMAILS_ENABLED: "true" },
        dependencies: {
            ensureIntent: async (input) => {
                calls.push(["intent", input]);
                return { deliveryId: "delivery-1", deliveryVersion: "1", status: "pending", retryable: true };
            },
            enqueue: async (name, payload) => {
                calls.push(["enqueue", name, payload]);
                return { jobId: "job-1" };
            },
            markEnqueued: async (input) => calls.push(["marked", input]),
        },
    });
    assert.equal(result.queued, true);
    assert.deepEqual(calls.map((call) => call[0]), ["intent", "enqueue", "marked"]);
});

test("billing EmailDelivery intent records recipient, type, tenant, period, and metadata", async () => {
    let inserted;
    const deliveryModel = {
        async findOneAndUpdate(filter, update) {
            inserted = { filter, ...update.$setOnInsert };
            return inserted;
        },
    };
    const intent = await ensureBillingEmailIntent({
        jobName: EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_5,
        businessId: "business-1",
        entityId: "failure-period-1",
        recipient: "OWNER@EXAMPLE.COM",
        metadata: { periodKey: "failure-period-1" },
        deliveryModel,
    });
    assert.equal(intent.entityType, "billing");
    assert.equal(intent.businessId, "business-1");
    assert.equal(intent.entityId, "failure-period-1");
    assert.equal(intent.recipient, "OWNER@EXAMPLE.COM");
    assert.equal(intent.metadata.periodKey, "failure-period-1");
    assert.equal(intent.status, "pending");
    assert.match(intent.deliveryId, /business-1/);
});

test("billing email worker claims once and records provider delivery outcome", async () => {
    const state = {
        deliveryId: "delivery-1",
        businessId: "business-1",
        entityType: "billing",
        entityId: "in_123",
        jobName: EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS,
        deliveryVersion: "1",
        recipient: "owner@example.com",
        metadata: { stripeInvoiceId: "in_123" },
        status: "pending",
        retryable: true,
        sentAt: null,
        attemptCount: 0,
    };
    const deliveryModel = {
        async findOneAndUpdate(filter, update) {
            if (filter.claimId && state.claimId !== filter.claimId) return null;
            Object.assign(state, update.$set || {});
            state.attemptCount += update.$inc?.attemptCount || 0;
            return { ...state };
        },
        async updateOne() { return { matchedCount: 1 }; },
    };
    const leanResult = (value) => ({ lean: async () => value });
    let renderedHtml;
    const result = await processBillingEmailDelivery({
        name: EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS,
        data: { businessId: "business-1", deliveryId: "delivery-1" },
    }, {
        deliveryModel,
        businessModel: {
            findOne: () => leanResult({ businessId: "business-1", name: "Sushi House", ownerEmail: "owner@example.com", currency: "EUR" }),
            updateOne: async () => ({ matchedCount: 1 }),
        },
        invoiceModel: {
            findOne: () => leanResult({ stripeInvoiceId: "in_123", currency: "JPY", amountPaid: 5000 }),
        },
        planModel: { findOne: () => leanResult(null) },
        sendEmail: async ({ html, idempotencyKey }) => {
            renderedHtml = html;
            assert.equal(idempotencyKey, "delivery-1");
            return { success: true, messageId: "provider-message-1" };
        },
        now: new Date("2026-09-01T00:00:00.000Z"),
    });
    assert.equal(result.success, true);
    assert.equal(state.status, "sent");
    assert.equal(state.attemptCount, 1);
    assert.equal(state.providerMessageId, "provider-message-1");
    assert.match(renderedHtml, /¥5,000/);
});

test("enqueue failure is captured as retryable delivery state instead of escaping", async () => {
    let markedFailure;
    const result = await dispatchBillingNotification({
        jobName: EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_3,
        businessId: "business-1",
        entityId: "failure-period",
        recipient: "owner@example.com",
        env: { BULLMQ_EMAILS_ENABLED: "true" },
        dependencies: {
            ensureIntent: async () => ({ deliveryId: "delivery-2", deliveryVersion: "1", status: "pending", retryable: true }),
            enqueue: async () => { throw Object.assign(new Error("redis down"), { code: "ECONNREFUSED" }); },
            markFailed: async (input) => { markedFailure = input; },
        },
    });
    assert.equal(result.queued, false);
    assert.equal(result.reason, "enqueue_failed");
    assert.equal(markedFailure.deliveryId, "delivery-2");
});

test("billing email jobs validate and generate deterministic tenant-aware IDs", () => {
    const payload = { businessId: "business-1", entityId: "in_123", deliveryId: "delivery-1", deliveryVersion: "1" };
    assert.deepEqual(validateEmailJobPayload(EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS, payload), payload);
    const first = buildEmailJobId(EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS, payload);
    const second = buildEmailJobId(EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS, payload);
    assert.equal(first, second);
    assert.match(first, /business-1/);
});

test("all six billing notification types use the same one-intent/one-job pipeline", async () => {
    const jobNames = [
        EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE,
        EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS,
        EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_3,
        EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_5,
        EMAIL_JOB_NAMES.BILLING_OFFLINE_RESTRICTED,
        EMAIL_JOB_NAMES.BILLING_SERVICE_RESTORED,
    ];
    const intents = [];
    const enqueued = [];
    for (const jobName of jobNames) {
        const result = await dispatchBillingNotification({
            jobName,
            businessId: "business-1",
            entityId: `${jobName}-entity`,
            recipient: "owner@example.com",
            env: { BULLMQ_EMAILS_ENABLED: "true" },
            dependencies: {
                ensureIntent: async (input) => {
                    intents.push(input.jobName);
                    return { deliveryId: `${jobName}-delivery`, deliveryVersion: "1", status: "pending", retryable: true };
                },
                enqueue: async (name) => {
                    enqueued.push(name);
                    return { jobId: `${name}-job` };
                },
                markEnqueued: async () => {},
            },
        });
        assert.equal(result.queued, true);
    }
    assert.deepEqual(intents, jobNames);
    assert.deepEqual(enqueued, jobNames);
});

test("payment success email renders the ledger invoice currency, including JPY", async () => {
    const notification = await buildBillingNotification({
        jobName: EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS,
        business: { name: "Sushi House", currency: "EUR" },
        delivery: { metadata: { stripeInvoiceId: "in_jpy" } },
        invoice: { currency: "JPY", amountPaid: 1200, amountDue: 1200 },
        plan: { currency: "USD" },
    });
    assert.equal(notification.currency, "JPY");
    assert.match(notification.html, /¥1,200/);
    assert.doesNotMatch(notification.html, /1,200\.00/);
});

test("upcoming invoice preview currency outranks plan and business currency", async () => {
    const notification = await buildBillingNotification({
        jobName: EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE,
        business: { businessId: "business-1", name: "Sushi House", currency: "EUR", stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_123" },
        delivery: { metadata: { invoiceDate: "2026-09-01T00:00:00.000Z" } },
        plan: { currency: "USD" },
        stripeClient: { invoices: { createPreview: async () => ({ total: 1200, currency: "jpy" }) } },
    });
    assert.equal(notification.currency, "JPY");
    assert.match(notification.html, /¥1,200/);
});

test("currency resolution follows Stripe invoice, preview, plan, then business", () => {
    assert.equal(resolveBillingCurrency({ stripeInvoice: { currency: "gbp" }, stripePreview: { currency: "jpy" }, plan: { currency: "usd" }, business: { currency: "eur" } }), "GBP");
    assert.equal(resolveBillingCurrency({ stripePreview: { currency: "jpy" }, plan: { currency: "usd" }, business: { currency: "eur" } }), "JPY");
    assert.equal(resolveBillingCurrency({ plan: { currency: "usd" }, business: { currency: "eur" } }), "USD");
    assert.equal(resolveBillingCurrency({ business: { currency: "eur" } }), "EUR");
});

test("dynamic USD billing emails contain no hardcoded euro symbol", async () => {
    const business = { businessId: "business-1", name: "Global Cafe", currency: "USD", stripeCustomerId: "cus_123" };
    const upcoming = await buildBillingNotification({
        jobName: EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE,
        business,
        delivery: { metadata: { invoiceDate: "2026-09-01T00:00:00.000Z" } },
        plan: { currency: "USD" },
        stripeClient: { invoices: { createPreview: async () => ({ total: 5000, currency: "usd" }) } },
    });
    const paid = await buildBillingNotification({
        jobName: EMAIL_JOB_NAMES.BILLING_PAYMENT_SUCCESS,
        business,
        delivery: { metadata: {} },
        invoice: { currency: "USD", amountPaid: 5000 },
        plan: { currency: "USD" },
    });
    assert.match(upcoming.html, /\$50\.00/);
    assert.match(paid.html, /\$50\.00/);
    assert.doesNotMatch(`${upcoming.html}${paid.html}`, /€|&euro;/);
});

test("minor-unit helpers support zero-, two-, and three-decimal currencies", () => {
    assert.equal(getCurrencyMinorUnitExponent("JPY"), 0);
    assert.equal(getCurrencyMinorUnitExponent("EUR"), 2);
    assert.equal(getCurrencyMinorUnitExponent("KWD"), 3);
    assert.equal(minorUnitsToMajor(1200, "JPY"), 1200);
    assert.equal(minorUnitsToMajor(1599, "EUR"), 15.99);
    assert.match(formatMoneyFromMinorUnits(1200, "JPY"), /1,200/);
    assert.match(formatMoneyFromMinorUnits(1599, "EUR"), /15\.99/);
});

test("the T-1 and Day 3/5/7 lifecycle schedule remains unchanged", () => {
    const active = {
        businessId: "business-1",
        status: "active",
        stripeSubscriptionId: "sub_123",
        billingStatus: "active",
        nextInvoiceDate: new Date("2026-09-02T00:00:00.000Z"),
    };
    assert.equal(
        isBillingActionDue(BILLING_JOB_NAMES.UPCOMING_INVOICE, active, new Date("2026-09-01T12:00:00.000Z")),
        true,
    );

    const pastDue = {
        ...active,
        billingStatus: "past_due",
        billingFailedAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    assert.equal(isBillingActionDue(BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3, pastDue, new Date("2026-09-04T00:00:00.000Z")), true);
    assert.equal(isBillingActionDue(BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_5, pastDue, new Date("2026-09-06T00:00:00.000Z")), true);
    assert.equal(isBillingActionDue(BILLING_JOB_NAMES.RESTRICT_SERVICE, pastDue, new Date("2026-09-08T00:00:00.000Z")), true);
    assert.equal(isBillingActionDue(BILLING_JOB_NAMES.RESTRICT_SERVICE, pastDue, new Date("2026-09-07T23:59:59.000Z")), false);
});
