import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateOfflinePricing,
  calculateOnlinePricing,
  calculatePricingBreakdown,
  getCustomerPricingBreakdown,
} from "../src/services/pricingService.js";
import {
  buildReservationStripeLineItems,
  buildReservationPricingSnapshot,
  ensureReservationPricingSnapshot,
  getCustomerReservationPricing,
} from "../src/services/reservationPricingService.js";

test("business-absorbed online pricing matches the menu settlement behavior", () => {
  const pricing = calculatePricingBreakdown({
    subtotalCents: 12000,
    taxRate: 19,
    commissionAmountCents: 360,
    commissionRateApplied: 3,
    planApplied: "growth",
    business: { platformFeeMode: "business_absorbs" },
  });

  assert.equal(pricing.taxAmountCents, 2280);
  assert.equal(pricing.customerPlatformFeeCents, 0);
  assert.equal(pricing.businessAbsorbedPlatformFeeCents, 360);
  assert.equal(pricing.totalCents, 14280);
  assert.equal(pricing.netToBusinessAmountCents, 13920);
});

test("customer-paid online pricing adds only the customer-facing fee", () => {
  const pricing = calculatePricingBreakdown({
    subtotalCents: 12000,
    taxRate: 19,
    commissionAmountCents: 360,
    business: {
      platformFeeMode: "customer_pays",
      platformFeeLabel: "Service Fee",
    },
  });

  assert.equal(pricing.customerPlatformFeeCents, 360);
  assert.equal(pricing.businessAbsorbedPlatformFeeCents, 0);
  assert.equal(pricing.totalCents, 14640);
  assert.equal(pricing.netToBusinessAmountCents, 14280);
  assert.equal(pricing.platformFeeLabel, "Service Fee");
});

test("split online pricing preserves the menu cent-rounding behavior", () => {
  const pricing = calculatePricingBreakdown({
    subtotalCents: 1999,
    taxRate: 7.7,
    commissionAmountCents: 60,
    business: {
      platformFeeMode: "split",
      customerPlatformFeePercent: 33,
    },
  });

  assert.equal(pricing.taxAmountCents, 154);
  assert.equal(pricing.customerPlatformFeeCents, 20);
  assert.equal(pricing.businessAbsorbedPlatformFeeCents, 40);
  assert.equal(pricing.totalCents, 2173);
  assert.equal(pricing.netToBusinessAmountCents, 2113);
});

test("legacy pass-to-customer setting remains supported", () => {
  const pricing = calculatePricingBreakdown({
    subtotalCents: 1000,
    commissionAmountCents: 25,
    business: { passPlatformFeeToCustomer: true },
  });

  assert.equal(pricing.platformFeeMode, "customer_pays");
  assert.equal(pricing.customerPlatformFeePercent, 100);
  assert.equal(pricing.customerPlatformFeeCents, 25);
});

test("online pricing resolves the online plan commission from the existing calculator", async () => {
  const calls = [];
  const pricing = await calculateOnlinePricing({
    subtotalCents: 5000,
    business: { currentPlan: "growth", taxRate: 10 },
    commissionCalculator: async (subtotalCents, planSlug) => {
      calls.push({ subtotalCents, planSlug });
      return {
        commissionAmountCents: 150,
        commissionRateApplied: 3,
        planApplied: "growth",
      };
    },
  });

  assert.deepEqual(calls, [{ subtotalCents: 5000, planSlug: "growth" }]);
  assert.equal(pricing.taxAmountCents, 500);
  assert.equal(pricing.commissionRateApplied, 3);
  assert.equal(pricing.planApplied, "growth");
});

test("offline pricing uses the offline commission resolver and shared breakdown", async () => {
  const calls = [];
  const pricing = await calculateOfflinePricing({
    subtotalCents: 1999,
    business: {
      currentPlan: "growth",
      taxRate: 7.7,
      platformFeeMode: "split",
      customerPlatformFeePercent: 33,
    },
    commissionCalculator: async (subtotalCents, planSlug) => {
      calls.push({ subtotalCents, planSlug });
      return {
        commissionAmountCents: 60,
        commissionRateApplied: 3,
        planApplied: "growth",
      };
    },
  });

  assert.deepEqual(calls, [{ subtotalCents: 1999, planSlug: "growth" }]);
  assert.equal(pricing.taxAmountCents, 154);
  assert.equal(pricing.platformFeeCents, 60);
  assert.equal(pricing.customerPlatformFeeCents, 20);
  assert.equal(pricing.businessAbsorbedPlatformFeeCents, 40);
  assert.equal(pricing.totalCents, 2173);
  assert.equal(pricing.commissionRateApplied, 3);
  assert.equal(pricing.planApplied, "growth");
});

test("offline pricing preserves the previous half-cent rounding sequence", async () => {
  const pricing = await calculateOfflinePricing({
    subtotalCents: 150,
    business: {
      currentPlan: "basic",
      platformFeeMode: "customer_pays",
    },
    commissionCalculator: async () => ({
      commissionAmountCents: 2,
      commissionRateApplied: 1,
      planApplied: "basic",
    }),
  });

  assert.equal(pricing.platformFeeCents, 1);
  assert.equal(pricing.customerPlatformFeeCents, 1);
  assert.equal(pricing.totalCents, 151);
});

test("customer projection excludes internal commission and settlement fields", () => {
  const pricing = calculatePricingBreakdown({
    subtotalCents: 5000,
    taxRate: 10,
    commissionAmountCents: 150,
    business: { platformFeeMode: "split", customerPlatformFeePercent: 50 },
  });
  const customerPricing = getCustomerPricingBreakdown(pricing);

  assert.equal(customerPricing.customerPlatformFeeCents, 75);
  assert.equal(customerPricing.totalCents, 5575);
  assert.equal("commissionAmountCents" in customerPricing, false);
  assert.equal("businessAbsorbedPlatformFeeCents" in customerPricing, false);
  assert.equal("netToBusinessAmountCents" in customerPricing, false);
});

test("hotel pricing snapshots use nightly rate times nights as the commission base", async () => {
  const snapshot = await buildReservationPricingSnapshot({
    reservation: { pricePerNight: 100, numberOfNights: 2 },
    business: {
      currentPlan: "growth",
      taxRate: 19,
      platformFeeMode: "split",
      customerPlatformFeePercent: 50,
      platformFeeLabel: "Service Fee",
    },
    commissionCalculator: async (subtotalCents) => ({
      commissionAmountCents: Math.round(subtotalCents * 0.03),
      commissionRateApplied: 3,
      planApplied: "growth",
    }),
  });

  assert.equal(snapshot.subtotal, 200);
  assert.equal(snapshot.taxAmount, 38);
  assert.equal(snapshot.platformFeeCents, 600);
  assert.equal(snapshot.customerPlatformFeeCents, 300);
  assert.equal(snapshot.businessAbsorbedPlatformFeeCents, 300);
  assert.equal(snapshot.totalPrice, 241);
  assert.equal(snapshot.grossAmount, 24100);
  assert.equal(snapshot.netToBusinessAmount, 23500);
});

test("legacy paid reservations are displayed without recalculating their historical amount", async () => {
  const reservation = {
    paymentStatus: "paid",
    totalPrice: 200,
    pricePerNight: 100,
    numberOfNights: 2,
  };

  const result = await ensureReservationPricingSnapshot({
    reservation,
    business: { taxRate: 19, platformFeeMode: "customer_pays" },
  });
  const customerPricing = getCustomerReservationPricing(result);

  assert.equal(result.pricingSnapshotVersion, undefined);
  assert.equal(customerPricing.subtotal, 200);
  assert.equal(customerPricing.taxAmount, 0);
  assert.equal(customerPricing.customerPlatformFeeAmount, 0);
  assert.equal(customerPricing.total, 200);
});

test("hotel Stripe line items sum exactly to the backend total", () => {
  const pricing = {
    subtotalCents: 20000,
    taxLabel: "Tax",
    taxAmountCents: 3800,
    platformFeeLabel: "Service Fee",
    customerPlatformFeeCents: 300,
    totalCents: 24100,
  };
  const lineItems = buildReservationStripeLineItems({
    pricing,
    currency: "EUR",
    businessName: "QuickServe Hotel",
  });

  assert.deepEqual(
    lineItems.map((item) => item.price_data.product_data.name),
    ["Accommodation at QuickServe Hotel", "Tax", "Service Fee"]
  );
  assert.equal(
    lineItems.reduce(
      (total, item) => total + item.price_data.unit_amount * item.quantity,
      0
    ),
    pricing.totalCents
  );
});

test("hotel Stripe omits zero tax and business-paid fee rows", () => {
  const lineItems = buildReservationStripeLineItems({
    pricing: {
      subtotalCents: 20000,
      taxAmountCents: 0,
      customerPlatformFeeCents: 0,
    },
    currency: "eur",
    businessName: "QuickServe Hotel",
  });

  assert.equal(lineItems.length, 1);
  assert.equal(lineItems[0].price_data.unit_amount, 20000);
});

test("offline pricing consumers load successfully", async () => {
  await Promise.all([
    import("../src/controllers/orderController.js"),
    import("../src/controllers/waitstaffOrdersController.js"),
  ]);
});
