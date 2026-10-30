import test from "node:test";
import assert from "node:assert/strict";
import Reservation from "../src/models/Reservation.js";

function stay(overrides = {}) {
  return new Reservation({
    businessId: "hotel-a",
    businessSlug: "hotel-a",
    customerName: "Walk-in Guest",
    phone: "+35612345678",
    checkInDate: "2026-10-27",
    checkOutDate: "2026-10-28",
    guestCount: 1,
    source: "walk_in",
    ...overrides,
  });
}

test("hotel cash/POS walk-ins may omit email without a placeholder address", async () => {
  await assert.doesNotReject(stay().validate());
});

test("public hotel reservations still require guest email", async () => {
  await assert.rejects(
    stay({ source: "public_hub" }).validate(),
    /email.*required/i,
  );
});
