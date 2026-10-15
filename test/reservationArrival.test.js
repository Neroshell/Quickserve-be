import assert from "node:assert/strict";
import test from "node:test";
import { createReservationNotComingToken } from "../src/services/reservationNotComingTokenService.js";
import { inspectReservationNotComingToken } from "../src/services/reservationNotComingService.js";

const TOKEN_ENV = {
  RESERVATION_CANCELLATION_TOKEN_SECRET:
    "test_secret_key_with_at_least_32_characters_long_for_hmac_sha256",
  SESSION_SECRET:
    "test_secret_key_with_at_least_32_characters_long_for_hmac_sha256",
};

function hotelBusiness() {
  return {
    _id: "business-hotel-1",
    businessId: "business-hotel-1",
    name: "Grand Hotel",
    type: "hotel",
  };
}

test("inspectReservationNotComingToken returns invalid for hotel reservations (rejected by hotel business check)", async () => {
  const hotelReservation = {
    _id: "reservation-hotel-1",
    businessId: "business-hotel-1",
    checkInDate: "2026-08-10",
    status: "confirmed",
    email: "hotel-guest@example.com",
    customerName: "Hotel Guest",
    arrivalReminderVersion: "1753948800000",
    cancellationTokenExpiresAt: new Date("2026-08-11T12:00:00.000Z"),
    toObject() { return this; },
  };
  const notComingToken = createReservationNotComingToken(hotelReservation, { env: TOKEN_ENV });
  const result = await inspectReservationNotComingToken({
    token: notComingToken,
    now: new Date("2026-08-10T12:00:00.000Z"),
    env: TOKEN_ENV,
    reservationModel: {
      findOne: () => ({
        select: async () => null,
      }),
    },
    businessModel: {
      findOne: () => ({ lean: async () => hotelBusiness() }),
    },
  });
  assert.equal(result.outcome, "invalid");
});