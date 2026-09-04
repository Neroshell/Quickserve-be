import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "@react-email/render";
import Stripe from "stripe";
process.env.BULLMQ_EMAILS_ENABLED = "false";

process.env.REDIS_URL = "";
process.env.STRIPE_SECRET_KEY = "sk_test_order_receipt";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_order_receipt";
process.env.RESEND_API_KEY = "re_test_order_receipt";

const [
  { default: ReceiptEmail },
  {
    getOrderReceiptIdempotencyKey,
    sendEmail,
    sendReceiptEmail,
  },
  {
    handleStripeWebhook,
    PAID_CHECKOUT_FULFILLMENT_STATE_MISSING,
    validateOrderCheckoutPayment,
  },
  { default: PendingCheckout },
  { default: Order },
  { default: Business },
  { default: MenuItem },
  { default: GuestProfile },
  { default: GuestVisit },
  { default: ServicePoint },
] = await Promise.all([
  import("../emails/ReceiptEmail.js"),
  import("../src/utils/emailService.js"),
  import("../src/controllers/webhookController.js"),
  import("../src/models/PendingCheckout.js"),
  import("../src/models/order.js"),
  import("../src/models/Business.js"),
  import("../src/models/menuItem.js"),
  import("../src/models/GuestProfile.js"),
  import("../src/models/GuestVisit.js"),
  import("../src/models/ServicePoint.js"),
]);

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

function createCheckoutEvent(overrides = {}) {
  const session = {
    id: "cs_test_food_order",
    payment_status: "paid",
    amount_total: 1234,
    currency: "eur",
    payment_intent: "pi_test_food_order",
    customer_details: { email: "customer@example.com" },
    metadata: {
      pendingCheckoutId: "pending_123",
      orderId: "ORDER-123",
      businessId: "business-123",
    },
    ...overrides.session,
  };

  return {
    id: overrides.eventId || "evt_food_order_123",
    type: "checkout.session.completed",
    data: { object: session },
  };
}

function createOrderDocument(fields) {
  return {
    _id: "mongo_order_123",
    receiptSent: false,
    receiptSentAt: null,
    inventoryDeducted: false,
    ...fields,
    async save() {
      this.saveCount = (this.saveCount || 0) + 1;
      return this;
    },
    toObject() {
      return { ...this };
    },
  };
}

test("food receipt template renders the existing service-point term and paid card details", async () => {
  const html = await render(React.createElement(ReceiptEmail, {
    businessName: "Test Bistro",
    orderId: "ORDER-123",
    orderDate: "2026-07-26 12:00",
    servicePointLabel: "Table 7",
    servicePointTerm: "Table",
    orderType: "dine-in",
    paymentMethod: "online_card",
    paymentStatus: "paid",
    currency: "EUR",
    items: [{
      itemName: "Margherita Pizza",
      quantity: 2,
      lineTotal: 10,
      notes: "No basil",
      allergies: ["Dairy"],
    }],
    subtotal: 10,
    taxAmount: 1,
    serviceFeeAmount: 0.34,
    tipAmount: 1,
    total: 12.34,
  }));

  assert.match(html, /Table/);
  assert.match(html, /Table 7/);
  assert.match(html, /Online Card/);
  assert.match(html, /Paid/);
  assert.match(html, /Margherita Pizza/);
  assert.match(html, /No basil/);
  assert.match(html, /Dairy/);
  assert.match(html, /12\.34/);
});

test("receipt resolves a legacy service-point ID to its tenant-scoped display label", async (t) => {
  let servicePointQuery;
  let providerPayload;

  t.mock.method(Business, "findOne", () => ({
    lean: async () => ({
      businessId: "business-123",
      displayName: "Test Bistro",
      businessType: "restaurant",
    }),
  }));
  t.mock.method(ServicePoint, "findOne", (query) => {
    servicePointQuery = query;
    return {
      lean: async () => ({
        servicePointId: "sp_2a357e40",
        businessId: "business-123",
        label: "Table 20",
        code: "T20",
      }),
    };
  });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    providerPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "msg_legacy_service_point" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const sent = await sendReceiptEmail({
    businessId: "business-123",
    orderId: "ORDER-LEGACY",
    createdAt: new Date("2026-07-26T10:00:00Z"),
    servicePointLabel: "sp_2a357e40",
    orderType: "dine-in",
    paymentStatus: "paid",
    paidVia: "online_card",
    currency: "EUR",
    items: [{ itemName: "Margherita Pizza", quantity: 1, lineTotal: 10 }],
    subtotal: 10,
    total: 10,
  }, "customer@example.com");

  assert.equal(sent, true);
  assert.deepEqual(servicePointQuery, {
    businessId: "business-123",
    servicePointId: "sp_2a357e40",
  });
  assert.match(providerPayload.html, /Table 20/);
  assert.doesNotMatch(providerPayload.html, /sp_2a357e40/);
});

test("email provider receives the automatic receipt idempotency key", async () => {
  const calls = [];
  const emailClient = {
    emails: {
      async send(message, options) {
        calls.push({ message, options });
        return { data: { id: "msg_provider_123" }, error: null };
      },
    },
  };
  const idempotencyKey = getOrderReceiptIdempotencyKey({
    businessId: "business-123",
    orderId: "ORDER-123",
  });

  const sent = await sendEmail({
    to: "customer@example.com",
    from: "QuickServe <receipts@quickservehq.com>",
    subject: "Receipt",
    html: "<p>Receipt</p>",
    idempotencyKey,
    emailClient,
  });

  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.idempotencyKey, "order-receipt/business-123/ORDER-123");
});

test("email provider failures are returned to the caller", async (t) => {
  t.mock.method(console, "error", () => {});
  const emailClient = {
    emails: {
      async send() {
        return {
          data: null,
          error: {
            name: "validation_error",
            message: "Recipient rejected",
            statusCode: 422,
          },
        };
      },
    },
  };

  const sent = await sendEmail({
    to: "customer@example.com",
    from: "QuickServe <receipts@quickservehq.com>",
    subject: "Receipt",
    html: "<p>Receipt</p>",
    emailClient,
  });

  assert.equal(sent, false);
});

test("food-order checkout validation accepts the canonical paid amount and currency", () => {
  const result = validateOrderCheckoutPayment(
    { payment_status: "paid", amount_total: 1234, currency: "eur" },
    { grossAmount: 1234, total: 12.34, currency: "EUR" },
  );

  assert.equal(result.valid, true);
  assert.equal(result.stripeAmountCents, 1234);
  assert.equal(result.stripeCurrency, "eur");
});

test("food-order checkout validation rejects unpaid, amount-mismatch, and currency-mismatch sessions", () => {
  const stored = { grossAmount: 1234, total: 12.34, currency: "EUR" };

  assert.equal(
    validateOrderCheckoutPayment(
      { payment_status: "unpaid", amount_total: 1234, currency: "eur" },
      stored,
    ).code,
    "PAYMENT_NOT_PAID",
  );
  assert.equal(
    validateOrderCheckoutPayment(
      { payment_status: "paid", amount_total: 1200, currency: "eur" },
      stored,
    ).code,
    "AMOUNT_MISMATCH",
  );
  assert.equal(
    validateOrderCheckoutPayment(
      { payment_status: "paid", amount_total: 1234, currency: "usd" },
      stored,
    ).code,
    "CURRENCY_MISMATCH",
  );
});

test("invalid Stripe signature is rejected before checkout lookup", async (t) => {
  const stripeForTest = new Stripe("sk_test_order_receipt");
  let pendingLookupCount = 0;
  t.mock.method(stripeForTest.webhooks, "constructEvent", () => {
    throw new Error("No signatures found matching the expected signature");
  });
  t.mock.method(PendingCheckout, "findById", async () => {
    pendingLookupCount += 1;
    return null;
  });
  t.mock.method(console, "error", () => {});

  const res = createResponse();
  await handleStripeWebhook(
    { body: Buffer.from("{}"), headers: { "stripe-signature": "invalid" } },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Webhook Error/);
  assert.equal(pendingLookupCount, 0);
});

test("paid checkout with missing PendingCheckout remains retryable without creating an order", async (t) => {
  const event = createCheckoutEvent();
  const stripeForTest = new Stripe("sk_test_order_receipt");
  t.mock.method(stripeForTest.webhooks, "constructEvent", () => event);
  t.mock.method(PendingCheckout, "findById", async () => null);
  t.mock.method(Order, "findOne", async () => null);
  t.mock.method(console, "error", () => {});

  const res = createResponse();
  await handleStripeWebhook(
    { body: Buffer.from("{}"), headers: { "stripe-signature": "test" } },
    res,
  );

  assert.equal(res.statusCode, 500);
  assert.equal(res.body, PAID_CHECKOUT_FULFILLMENT_STATE_MISSING);
});

test("processed payment with a missing receipt surfaces provider failure and retries safely", async (t) => {
  const event = createCheckoutEvent();
  const stripeForTest = new Stripe("sk_test_order_receipt");
  const existingOrder = createOrderDocument({
    businessId: "business-123",
    orderId: "ORDER-123",
    servicePointLabel: "sp_123",
    displayLabel: "Table 7",
    orderType: "dine-in",
    items: [{ itemName: "Margherita Pizza", quantity: 1, lineTotal: 10 }],
    subtotal: 10,
    taxAmount: 1,
    total: 12.34,
    grossAmount: 1234,
    currency: "EUR",
    paymentChannel: "online",
    paymentStatus: "paid",
    paidVia: "online_card",
    stripeSessionId: "cs_test_food_order",
    receiptEmail: "customer@example.com",
    createdAt: new Date("2026-07-26T10:00:00Z"),
  });
  let providerCalls = 0;

  t.mock.method(stripeForTest.webhooks, "constructEvent", () => event);
  t.mock.method(PendingCheckout, "findById", async () => null);
  t.mock.method(Order, "findOne", async () => existingOrder);
  t.mock.method(Business, "findOne", () => ({
    lean: async () => ({
      businessId: "business-123",
      displayName: "Test Bistro",
      businessType: "restaurant",
    }),
  }));
  t.mock.method(globalThis, "fetch", async () => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return new Response(JSON.stringify({
        name: "application_error",
        message: "Temporary provider failure",
        statusCode: 503,
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "msg_retry_123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  t.mock.method(console, "error", () => {});

  const failedRes = createResponse();
  await handleStripeWebhook(
    { body: Buffer.from("{}"), headers: { "stripe-signature": "test" } },
    failedRes,
  );

  assert.equal(failedRes.statusCode, 500);
  assert.equal(existingOrder.receiptSent, false);
  assert.equal(existingOrder.receiptSentAt, null);

  const retryRes = createResponse();
  await handleStripeWebhook(
    { body: Buffer.from("{}"), headers: { "stripe-signature": "test" } },
    retryRes,
  );

  assert.equal(retryRes.statusCode, 200);
  assert.equal(existingOrder.receiptSent, true);
  assert.ok(existingOrder.receiptSentAt instanceof Date);

  const replayRes = createResponse();
  await handleStripeWebhook(
    { body: Buffer.from("{}"), headers: { "stripe-signature": "test" } },
    replayRes,
  );

  assert.equal(replayRes.statusCode, 200);
  assert.equal(providerCalls, 2);
});

test("paid food-order webhook creates one paid order and sends exactly one receipt on replay", async (t) => {
  const event = createCheckoutEvent();
  const stripeForTest = new Stripe("sk_test_order_receipt");
  const pending = {
    _id: "pending_123",
    businessId: "business-123",
    orderId: "ORDER-123",
    servicePointLabel: "sp_123",
    displayLabel: "Table 7",
    orderType: "dine-in",
    sessionId: "guest-session-123",
    items: [{
      itemName: "Margherita Pizza",
      quantity: 1,
      lineTotal: 10,
      prepTimeMinutes: 10,
      type: "food",
      category: "mains",
      notes: "",
      allergies: [],
    }],
    subtotal: 10,
    taxAmount: 1,
    tipAmount: 1,
    tipType: "custom",
    tipPercentage: null,
    total: 12.34,
    currency: "EUR",
    receiptEmail: "customer@example.com",
    stripeSessionId: "cs_test_food_order",
    stripePaymentIntentId: "pi_test_food_order",
    stripeConnectedAccountId: "acct_test",
    grossAmount: 1234,
    netToBusinessAmount: 1100,
    platformFeeCents: 34,
    customerPlatformFeeCents: 34,
    businessAbsorbedPlatformFeeCents: 0,
    platformFeeMode: "customer_pays",
    customerPlatformFeePercent: 100,
  };
  const business = {
    businessId: "business-123",
    displayName: "Test Bistro",
    businessType: "restaurant",
    timezone: "UTC",
  };
  const profile = {
    marketingConsent: false,
    visitCount: 0,
    orderCount: 0,
    paidOrderCount: 0,
    totalSpendCents: 0,
    averageSpendCents: 0,
    averageOrderSpendCents: 0,
    processedOrderIds: [],
    processedPaidOrderIds: [],
    favouriteItems: [],
    async save() {},
  };
  const visit = {
    orderIds: [],
    paidOrderIds: [],
    spendCents: 0,
    async save() {},
  };

  let pendingAvailable = true;
  let storedOrder = null;
  let providerCalls = 0;
  let deletedPendingId = null;
  const providerRequests = [];

  t.mock.method(stripeForTest.webhooks, "constructEvent", () => event);
  t.mock.method(PendingCheckout, "findById", async () => pendingAvailable ? pending : null);
  t.mock.method(PendingCheckout, "findByIdAndDelete", async (id) => {
    pendingAvailable = false;
    deletedPendingId = id;
  });
  t.mock.method(Order, "findOne", async () => storedOrder);
  t.mock.method(Order, "create", async (fields) => {
    // Inventory concurrency is covered by the real replica-set Phase 2B suite;
    // this receipt-only fixture starts after the inventory step.
    storedOrder = createOrderDocument({ ...fields, inventoryDeducted: true });
    return storedOrder;
  });
  t.mock.method(Order, "updateOne", async () => ({ acknowledged: true }));
  t.mock.method(Business, "findOne", () => ({ lean: async () => business }));
  t.mock.method(MenuItem, "findOneAndUpdate", async () => null);
  t.mock.method(GuestProfile, "findOne", async () => profile);
  t.mock.method(GuestVisit, "findOne", async () => visit);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    providerCalls += 1;
    providerRequests.push({ url, options });
    return new Response(JSON.stringify({ id: "msg_food_order_123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const firstRes = createResponse();
  await handleStripeWebhook(
    { body: Buffer.from("{}"), headers: { "stripe-signature": "test" } },
    firstRes,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstRes.statusCode, 200);
  assert.equal(deletedPendingId, "pending_123");
  assert.equal(storedOrder.paymentStatus, "paid");
  assert.equal(storedOrder.paymentChannel, "online");
  assert.equal(storedOrder.paidVia, "online_card");
  assert.equal(storedOrder.receiptEmail, "customer@example.com");
  assert.equal(storedOrder.receiptSent, true);
  assert.ok(storedOrder.receiptSentAt instanceof Date);
  assert.equal(storedOrder.displayLabel, "Table 7");
  assert.equal(storedOrder.subtotal, 10);
  assert.equal(storedOrder.taxAmount, 1);
  assert.equal(storedOrder.total, 12.34);
  assert.equal(providerCalls, 1);

  const providerPayload = JSON.parse(providerRequests[0].options.body);
  assert.equal(providerPayload.to, "customer@example.com");
  assert.match(providerPayload.html, /Margherita Pizza/);
  assert.match(providerPayload.html, /Online Card/);
  assert.match(providerPayload.html, /Table 7/);
  assert.doesNotMatch(providerPayload.html, /sp_123/);
  assert.equal(
    providerRequests[0].options.headers.get("Idempotency-Key"),
    "order-receipt/business-123/ORDER-123",
  );

  const replayRes = createResponse();
  await handleStripeWebhook(
    { body: Buffer.from("{}"), headers: { "stripe-signature": "test" } },
    replayRes,
  );

  assert.equal(replayRes.statusCode, 200);
  assert.equal(providerCalls, 1);
});
