import test from "node:test";
import assert from "node:assert/strict";

import { getHotelBookingReadiness } from "../src/services/hotelBookingReadinessService.js";

function hotel(overrides = {}) {
  return {
    businessType: "hotel",
    modules: ["lodging"],
    status: "active",
    onboardingCompleted: true,
    billingStatus: "active",
    defaultPaymentMethodId: "pm_hotel",
    stripeAccountId: "acct_hotel",
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
    settings: { reservationsEnabled: true, offlinePaymentEnabled: true, acceptCash: true, acceptPOS: true },
    ...overrides,
  };
}

test("walk-ins and online payments are independently ready", () => {
  const readiness = getHotelBookingReadiness({ business: hotel(), accommodationReady: true });
  assert.equal(readiness.walkIn.ready, true);
  assert.equal(readiness.walkIn.state, "ready");
  assert.equal(readiness.online.ready, true);
  assert.equal(readiness.online.state, "ready");
  assert.deepEqual(readiness.walkIn.enabledPaymentMethods, ["cash", "pos_card"]);
});

test("Stripe is not required for billing-ready walk-ins", () => {
  const readiness = getHotelBookingReadiness({
    business: hotel({ onboardingCompleted: false, stripeAccountId: null, stripeChargesEnabled: false, stripePayoutsEnabled: false }),
    accommodationReady: true,
  });
  assert.equal(readiness.walkIn.ready, true);
  assert.equal(readiness.online.ready, false);
});

test("missing billing method blocks walk-ins without blocking Stripe-ready online bookings", () => {
  const readiness = getHotelBookingReadiness({
    business: hotel({ defaultPaymentMethodId: null }),
    accommodationReady: true,
  });
  assert.equal(readiness.walkIn.ready, false);
  assert.equal(readiness.walkIn.code, "HOTEL_WALK_IN_BILLING_UNAVAILABLE");
  assert.equal(readiness.walkIn.state, "setup_required");
  assert.equal(readiness.online.ready, true);
});

test("disabled offline methods are not offered", () => {
  const readiness = getHotelBookingReadiness({
    business: hotel({ settings: { reservationsEnabled: true, offlinePaymentEnabled: true, acceptCash: false, acceptPOS: true } }),
    accommodationReady: true,
  });
  assert.equal(readiness.walkIn.ready, true);
  assert.deepEqual(readiness.walkIn.enabledPaymentMethods, ["pos_card"]);
});

test("inactive and unconfigured hotels are never reported ready", () => {
  const inactive = getHotelBookingReadiness({ business: hotel({ status: "suspended" }), accommodationReady: true });
  const unconfigured = getHotelBookingReadiness({ business: hotel(), accommodationReady: false });
  assert.equal(inactive.walkIn.ready, false);
  assert.equal(inactive.walkIn.state, "unavailable");
  assert.equal(inactive.online.ready, false);
  assert.equal(unconfigured.walkIn.code, "HOTEL_ACCOMMODATION_NOT_READY");
  assert.equal(unconfigured.online.code, "HOTEL_ACCOMMODATION_NOT_READY");
});
