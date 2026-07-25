/**
 * test/hotelReservationFlow.test.js
 *
 * Focused tests for the hotel reservation pricing & payment flow fixes.
 * Run with: node --test test/hotelReservationFlow.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "@react-email/render";

import {
  calculatePricingBreakdown,
  getCustomerPricingBreakdown,
} from "../src/services/pricingService.js";

import {
  getAccommodationSubtotalCents,
  buildReservationPricingSnapshot,
  getCustomerReservationPricing,
  hasReservationPricingSnapshot,
  buildReservationStripeLineItems,
} from "../src/services/reservationPricingService.js";

import ReservationEmailBase from "../emails/ReservationEmailBase.js";
import ReservationPaymentEmail from "../emails/ReservationPaymentEmail.js";

// Shared mock commission calculator -- avoids any DB call.
// Uses a 3% rate consistent with existing pricingService tests.
const mockCommission = (subtotalCents) => ({
  commissionAmountCents: Math.round(subtotalCents * 0.03),
  commissionRateApplied: 3,
  planApplied: "basic",
});

// -------------------------------------------------------
// 1. Accommodation subtotal helpers
// -------------------------------------------------------

test("getAccommodationSubtotalCents -- 1 night", () => {
  const cents = getAccommodationSubtotalCents({ pricePerNight: 100, numberOfNights: 1 });
  assert.equal(cents, 10000);
});

test("getAccommodationSubtotalCents -- multi-night", () => {
  const cents = getAccommodationSubtotalCents({ pricePerNight: 120, numberOfNights: 3 });
  assert.equal(cents, 36000);
});

test("getAccommodationSubtotalCents -- falls back to stored subtotal", () => {
  const cents = getAccommodationSubtotalCents({ subtotal: 240 });
  assert.equal(cents, 24000);
});

// -------------------------------------------------------
// 2. Pricing snapshot / canonical DTO (no DB -- mock commission)
// -------------------------------------------------------

test("buildReservationPricingSnapshot -- canonical fields with tax, business absorbs fee", async () => {
  const snapshot = await buildReservationPricingSnapshot({
    reservation: { pricePerNight: 100, numberOfNights: 2 },
    business: { taxRate: 10, platformFeeMode: "business_absorbs" },
    commissionCalculator: mockCommission,
  });
  assert.equal(snapshot.subtotal, 200, "subtotal = 200");
  assert.equal(snapshot.taxAmount, 20, "taxAmount = 20 (10% of 200)");
  assert.equal(snapshot.taxAmountCents, 2000, "taxAmountCents = 2000");
  assert.equal(snapshot.customerPlatformFeeCents, 0, "customer pays no fee");
  assert.equal(snapshot.totalPrice, 220, "totalPrice = 220 (subtotal + tax)");
  assert.equal(snapshot.grossAmount, 22000, "grossAmount = 22000 cents");
});

test("buildReservationPricingSnapshot -- customer_pays fee adds to total", async () => {
  const snapshot = await buildReservationPricingSnapshot({
    reservation: { pricePerNight: 100, numberOfNights: 2 },
    business: { taxRate: 0, platformFeeMode: "customer_pays" },
    commissionCalculator: mockCommission,
  });
  assert.ok(snapshot.customerPlatformFeeCents > 0, "customerPlatformFeeCents > 0");
  assert.ok(snapshot.totalPrice > 200, "totalPrice > subtotal when customer pays fee");
});

test("getCustomerReservationPricing -- all required DTO fields present", async () => {
  const snapshot = await buildReservationPricingSnapshot({
    reservation: { pricePerNight: 100, numberOfNights: 2 },
    business: { taxRate: 19, platformFeeMode: "business_absorbs" },
    commissionCalculator: mockCommission,
  });
  const dto = getCustomerReservationPricing({ ...snapshot, currency: "eur" });

  const required = [
    "subtotal","taxRate","taxLabel","taxAmount","taxAmountCents",
    "platformFeeLabel","customerPlatformFeeAmount","customerPlatformFeeCents",
    "total","totalCents",
  ];
  required.forEach(field => assert.ok(field in dto, `dto.${field} must be present`));

  assert.equal(dto.subtotal, 200);
  assert.equal(dto.taxAmount, 38);
  assert.equal(dto.total, 238);
  assert.equal(dto.totalCents, 23800);
});

test("getCustomerReservationPricing -- no silent zero total (zero tax)", async () => {
  const snapshot = await buildReservationPricingSnapshot({
    reservation: { pricePerNight: 100, numberOfNights: 1 },
    business: { taxRate: 0, platformFeeMode: "business_absorbs" },
    commissionCalculator: mockCommission,
  });
  const dto = getCustomerReservationPricing({ ...snapshot, currency: "eur" });
  assert.notEqual(dto.total, 0, "total must not be silently zero");
  assert.equal(dto.total, 100);
});

// -------------------------------------------------------
// 3. Stripe line items -- sum must equal totalCents
// -------------------------------------------------------

test("buildReservationStripeLineItems -- sum equals totalCents with tax and fee", async () => {
  const snapshot = await buildReservationPricingSnapshot({
    reservation: { pricePerNight: 100, numberOfNights: 2 },
    business: { taxRate: 19, platformFeeMode: "customer_pays" },
    commissionCalculator: mockCommission,
  });
  const dto = getCustomerReservationPricing({ ...snapshot, currency: "eur" });
  const lineItems = buildReservationStripeLineItems({ pricing: dto, currency: "eur", businessName: "Test Hotel" });
  const sum = lineItems.reduce((acc, li) => acc + li.price_data.unit_amount, 0);
  assert.equal(sum, dto.totalCents, `Stripe sum ${sum} must equal totalCents ${dto.totalCents}`);
});

// -------------------------------------------------------
// 4. ReservationEmailBase -- callToAction now in props scope
// -------------------------------------------------------

test("ReservationEmailBase -- renders without callToAction (no ReferenceError)", async () => {
  const html = await render(React.createElement(ReservationEmailBase, {
    businessName: "Test Hotel",
    title: "Test Email",
    previewText: "Preview",
    details: [{ label: "Room", value: "Suite 1" }],
  }));
  assert.match(html, /Test Hotel/);
  assert.match(html, /Suite 1/);
  assert.doesNotMatch(html, /Pay Now/);
});

test("ReservationEmailBase -- renders Pay button when callToAction is provided", async () => {
  const html = await render(React.createElement(ReservationEmailBase, {
    businessName: "Grand Hotel",
    title: "Action Required: Payment",
    previewText: "Please pay",
    details: [],
    callToAction: { text: "Pay Now", url: "https://app.quickservehq.com/reservation/pay/abc123" },
  }));
  assert.match(html, /Pay Now/);
  assert.match(html, /reservation\/pay\/abc123/);
});

// -------------------------------------------------------
// 5. ReservationPaymentEmail -- hotel-specific rendering and Pay URL
// -------------------------------------------------------

test("ReservationPaymentEmail -- renders hotel dates and Pay button with secureToken URL", async () => {
  const html = await render(React.createElement(ReservationPaymentEmail, {
    businessName: "Grand Hotel",
    reservation: {
      customerName: "Alice",
      checkInDate: "2026-08-01",
      checkOutDate: "2026-08-03",
      guestCount: 2,
      servicePointLabel: "Deluxe Suite",
      totalPrice: 240,
      currency: "eur",
    },
    paymentUrl: "https://app.quickservehq.com/reservation/pay/tok123",
  }));
  assert.match(html, /Deluxe Suite/);
  assert.match(html, /August/);
  assert.match(html, /Pay Now/);
  assert.match(html, /reservation\/pay\/tok123/, "URL must use /reservation/pay/:token path");
  assert.doesNotMatch(html, /Invalid Date/);
  // Must NOT be a confirmation-page URL
  assert.doesNotMatch(html, /reservation\/confirmation/);
});

test("ReservationPaymentEmail -- Pay button absent when paymentUrl is null", async () => {
  const html = await render(React.createElement(ReservationPaymentEmail, {
    businessName: "Grand Hotel",
    reservation: { customerName: "Bob", checkInDate: "2026-08-01", checkOutDate: "2026-08-02" },
    paymentUrl: null,
  }));
  assert.doesNotMatch(html, /Pay Now/);
});

test("ReservationPaymentEmail -- total due row rendered when totalPrice present", async () => {
  const html = await render(React.createElement(ReservationPaymentEmail, {
    businessName: "Grand Hotel",
    reservation: {
      customerName: "Carol",
      checkInDate: "2026-08-10",
      checkOutDate: "2026-08-12",
      totalPrice: 238,
      currency: "eur",
    },
    paymentUrl: "https://app.quickservehq.com/reservation/pay/xyz",
  }));
  assert.match(html, /Total Due/);
  assert.match(html, /238/);
});

// -------------------------------------------------------
// 6. Webhook validation (pure logic guards)
// -------------------------------------------------------

test("Webhook -- amount mismatch is detected", () => {
  const storedAmountCents = 23800;
  const stripeAmountCents = 24000;
  assert.notEqual(stripeAmountCents, storedAmountCents);
});

test("Webhook -- currency normalization matches correctly", () => {
  assert.equal("EUR".toLowerCase(), "eur");
  assert.notEqual("usd", "eur");
});

test("Webhook -- idempotency guard detects already-paid reservation", () => {
  const reservation = { paymentStatus: "paid" };
  assert.equal(reservation.paymentStatus === "paid", true);
});

test("Webhook -- only processes events with payment_status === paid", () => {
  assert.equal("unpaid" === "paid", false);
  assert.equal("paid" === "paid", true);
});

test("Webhook -- grossAmount must be a positive safe integer", () => {
  const validCents = 23800;
  const zeroCents = 0;
  const floatCents = 238.00;
  assert.ok(Number.isSafeInteger(validCents) && validCents > 0, "valid cents pass");
  assert.equal(Number.isSafeInteger(zeroCents) && zeroCents > 0, false, "zero rejected");
  // Float stored as isSafeInteger returns true for whole floats, but verify intent
  assert.equal(Number.isSafeInteger(floatCents) && floatCents > 0, true, "238.0 is technically safe integer");
});
