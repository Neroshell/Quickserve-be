import test from "node:test";
import assert from "node:assert/strict";

import Business from "../src/models/Business.js";
import ServicePoint from "../src/models/ServicePoint.js";
import { getHotelBookingReadiness } from "../src/controllers/reservationController.js";

function hotel(overrides = {}) {
  return {
    businessId: "hotel-a",
    businessType: "hotel",
    modules: ["lodging"],
    status: "active",
    onboardingCompleted: true,
    billingStatus: "active",
    defaultPaymentMethodId: "pm_hotel",
    stripeAccountId: "acct_hotel",
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
    settings: { reservationsEnabled: true, offlinePaymentEnabled: true, acceptCash: true },
    ...overrides,
  };
}

test("hotel booking readiness is derived from the session tenant, never a request businessId", async () => {
  const originalFindOne = Business.findOne;
  const originalExists = ServicePoint.exists;
  let businessQuery;
  let roomQuery;

  Business.findOne = (query) => {
    businessQuery = query;
    return { lean: async () => hotel() };
  };
  ServicePoint.exists = async (query) => {
    roomQuery = query;
    return { _id: "room-a" };
  };

  let body;
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { body = value; return this; },
  };

  try {
    await getHotelBookingReadiness({
      session: { user: { businessId: "hotel-a" } },
      query: { businessId: "hotel-b" },
    }, response);

    assert.deepEqual(businessQuery, { businessId: "hotel-a" });
    assert.equal(roomQuery.businessId, "hotel-a");
    assert.equal(body.walkIn.ready, true);
    assert.equal(body.online.ready, true);
  } finally {
    Business.findOne = originalFindOne;
    ServicePoint.exists = originalExists;
  }
});
