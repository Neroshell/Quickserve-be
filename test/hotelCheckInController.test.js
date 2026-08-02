import test from "node:test";
import assert from "node:assert/strict";
import Reservation from "../src/models/Reservation.js";
import {
  checkInHotelReservation,
  getHotelPaymentExpiresAt,
  HOTEL_PAYMENT_WINDOW_MINUTES,
  updateReservationStatus,
} from "../src/controllers/reservationController.js";
import { getHotelCheckInWindow } from "../src/services/hotelCheckInService.js";
import { hashCheckInCode } from "../src/utils/checkInCode.js";

function createResponse() {
  return {
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
}

test("hotel booking payment links expire after 30 minutes", () => {
  const acceptedAt = Date.parse("2026-07-18T12:00:00.000Z");
  const expiresAt = getHotelPaymentExpiresAt(acceptedAt);

  assert.equal(HOTEL_PAYMENT_WINDOW_MINUTES, 30);
  assert.equal(expiresAt.toISOString(), "2026-07-18T12:30:00.000Z");
});

test("hotel check-in window respects midnight hour settings", () => {
  const { checkInCodeValidFrom, checkInCodeExpiresAt } = getHotelCheckInWindow(
    {
      checkInDate: "2026-07-19",
      checkOutDate: "2026-07-21",
    },
    {
      timezone: "UTC",
      hotelSettings: {
        checkInTime: "00:01",
        checkOutTime: "00:59",
      },
    }
  );

  assert.equal(checkInCodeValidFrom.toISOString(), "2026-07-19T00:01:00.000Z");
  assert.equal(checkInCodeExpiresAt.toISOString(), "2026-07-21T00:59:00.000Z");
});

test("generic status updates cannot bypass check-in code verification", async () => {
  const req = { params: { id: "reservation-1" }, body: { status: "checked_in" } };
  const res = createResponse();

  await updateReservationStatus(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /check-in code/i);
});

test("a matching active code checks in the guest and records the staff member", async () => {
  const originalFindOne = Reservation.findOne;
  const originalFindOneAndUpdate = Reservation.findOneAndUpdate;
  const now = Date.now();
  let capturedUpdate;

  const reservation = {
    _id: "reservation-1",
    businessId: "hotel-1",
    checkInDate: "2026-07-18",
    status: "confirmed",
    paymentStatus: "paid",
    checkInCodeHash: hashCheckInCode("123456"),
    checkInCodeValidFrom: new Date(now - 60_000),
    checkInCodeExpiresAt: new Date(now + 60_000),
    checkInCodeLockedAt: null,
    checkInCodeUsedAt: null,
    checkInCodeFailedAttempts: 0,
  };

  Reservation.findOne = (filter) => {
    assert.deepEqual(filter, {
      _id: "reservation-1",
      businessId: "hotel-1",
    });
    return {
    select: async () => reservation,
    };
  };
  Reservation.findOneAndUpdate = async (query, update) => {
    assert.equal(query.businessId, "hotel-1");
    capturedUpdate = update;
    return { ...reservation, ...update.$set };
  };

  try {
    const req = {
      params: { id: reservation._id },
      body: { code: "123456" },
      session: {
        user: {
          businessId: "hotel-1",
          userId: "owner-1",
          name: "Hotel Owner",
          email: "owner@example.com",
          role: "owner",
        },
      },
    };
    const res = createResponse();

    await checkInHotelReservation(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.reservation.status, "checked_in");
    assert.ok(capturedUpdate.$set.checkInCodeUsedAt instanceof Date);
    assert.ok(capturedUpdate.$set.checkedInAt instanceof Date);
    assert.deepEqual(capturedUpdate.$set.checkedInBy, {
      userId: "owner-1",
      name: "Hotel Owner",
      email: "owner@example.com",
      role: "owner",
    });
  } finally {
    Reservation.findOne = originalFindOne;
    Reservation.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("a locked check-in code returns structured lock state for the owner UI", async () => {
  const originalFindOne = Reservation.findOne;
  const lockedAt = new Date("2026-07-18T12:00:00.000Z");
  const reservation = {
    _id: "reservation-locked",
    businessId: "hotel-1",
    checkInDate: "2026-07-18",
    status: "confirmed",
    paymentStatus: "paid",
    checkInCodeHash: hashCheckInCode("123456"),
    checkInCodeValidFrom: new Date("2026-07-18T11:00:00.000Z"),
    checkInCodeExpiresAt: new Date("2026-07-19T11:00:00.000Z"),
    checkInCodeLockedAt: lockedAt,
    checkInCodeUsedAt: null,
  };

  Reservation.findOne = () => ({
    select: async () => reservation,
  });

  try {
    const req = {
      params: { id: reservation._id },
      body: { code: "123456" },
      session: { user: { businessId: "hotel-1", role: "owner" } },
    };
    const res = createResponse();

    await checkInHotelReservation(req, res);

    assert.equal(res.statusCode, 423);
    assert.equal(res.body.code, "CHECK_IN_CODE_LOCKED");
    assert.equal(res.body.checkInCodeLocked, true);
    assert.equal(res.body.attemptsRemaining, 0);
    assert.equal(res.body.lockedAt, lockedAt);
  } finally {
    Reservation.findOne = originalFindOne;
  }
});

test("the fifth incorrect check-in code locks the credential", async () => {
  const originalFindOne = Reservation.findOne;
  const originalUpdateOne = Reservation.updateOne;
  const now = Date.now();
  let capturedUpdate;
  const reservation = {
    _id: "reservation-final-attempt",
    businessId: "hotel-1",
    checkInDate: "2026-07-18",
    status: "confirmed",
    paymentStatus: "paid",
    checkInCodeHash: hashCheckInCode("123456"),
    checkInCodeValidFrom: new Date(now - 60_000),
    checkInCodeExpiresAt: new Date(now + 60_000),
    checkInCodeLockedAt: null,
    checkInCodeUsedAt: null,
    checkInCodeFailedAttempts: 4,
  };

  Reservation.findOne = () => ({
    select: async () => reservation,
  });
  Reservation.updateOne = async (_filter, update) => {
    capturedUpdate = update;
    return { acknowledged: true, modifiedCount: 1 };
  };

  try {
    const req = {
      params: { id: reservation._id },
      body: { code: "654321" },
      session: { user: { businessId: "hotel-1", role: "owner" } },
    };
    const res = createResponse();

    await checkInHotelReservation(req, res);

    assert.equal(res.statusCode, 423);
    assert.equal(res.body.code, "CHECK_IN_CODE_LOCKED");
    assert.equal(res.body.checkInCodeLocked, true);
    assert.equal(capturedUpdate.$set.checkInCodeFailedAttempts, 5);
    assert.ok(capturedUpdate.$set.checkInCodeLockedAt instanceof Date);
  } finally {
    Reservation.findOne = originalFindOne;
    Reservation.updateOne = originalUpdateOne;
  }
});

test("reservation schema records who triggered a confirmation resend", () => {
  assert.ok(Reservation.schema.path("confirmationEmailResentAt"));
  assert.ok(Reservation.schema.path("confirmationEmailResentBy"));
});
