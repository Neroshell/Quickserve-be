import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReservationExpiryFilter,
  expireAwaitingPaymentReservations,
} from "../src/services/reservationExpiryService.js";
import Business from "../src/models/Business.js";
import Reservation from "../src/models/Reservation.js";
import {
  getReservations,
  toOwnerReservationResponse,
} from "../src/controllers/reservationController.js";

test("owner-triggered reservation expiry is tenant-scoped and includes the deadline instant", () => {
  const now = new Date("2026-07-29T10:30:00.000Z");

  assert.deepEqual(
    buildReservationExpiryFilter({ businessId: "hotel_1", now }),
    {
      businessId: "hotel_1",
      status: "accepted_awaiting_payment",
      paymentStatus: { $ne: "paid" },
      paymentExpiresAt: { $lte: now },
    },
  );
});

test("reservation expiry refuses an accidental unscoped owner operation", () => {
  assert.throws(
    () => buildReservationExpiryFilter(),
    /businessId is required/,
  );
});

test("the trusted scheduled job can reuse the same atomic expiry operation", async () => {
  const now = new Date("2026-07-29T10:30:00.000Z");
  let capturedFilter;
  let capturedUpdate;
  const reservationModel = {
    async updateMany(filter, update) {
      capturedFilter = filter;
      capturedUpdate = update;
      return { modifiedCount: 2 };
    },
  };

  const result = await expireAwaitingPaymentReservations({
    now,
    allTenants: true,
    reservationModel,
  });

  assert.deepEqual(capturedFilter, {
    status: "accepted_awaiting_payment",
    paymentStatus: { $ne: "paid" },
    paymentExpiresAt: { $lte: now },
  });
  assert.deepEqual(capturedUpdate, { $set: { status: "expired" } });
  assert.equal(result.modifiedCount, 2);
});

test("loading the owner list synchronizes expiry for the authenticated tenant", async (t) => {
  let expiryFilter;
  let listFilter;
  t.mock.method(Business, "findOne", () => ({
    lean: async () => ({
      businessId: "hotel_1",
      ownerEmail: "owner@example.com",
    }),
  }));
  t.mock.method(Reservation, "updateMany", async (filter) => {
    expiryFilter = filter;
    return { modifiedCount: 1 };
  });
  t.mock.method(Reservation, "find", (filter) => {
    listFilter = filter;
    return {
      sort() {
        return this;
      },
      async lean() {
        return [
          {
            _id: "reservation_1",
            businessId: "hotel_1",
            status: "expired",
            paymentStatus: "pending",
            secureToken: "secret-token",
          },
        ];
      },
    };
  });
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

  await getReservations(
    {
      query: { businessId: "hotel_1" },
      session: {
        user: {
          businessId: "hotel_1",
          email: "owner@example.com",
          role: "owner",
        },
      },
    },
    res,
  );

  assert.equal(expiryFilter.businessId, "hotel_1");
  assert.equal(expiryFilter.status, "accepted_awaiting_payment");
  assert.deepEqual(expiryFilter.paymentStatus, { $ne: "paid" });
  assert.ok(expiryFilter.paymentExpiresAt.$lte instanceof Date);
  assert.deepEqual(listFilter, {
    businessId: "hotel_1",
    archivedAt: null,
  });
  assert.equal(res.body[0].status, "expired");
  assert.equal(res.body[0].paymentUrl, null);
  assert.equal("secureToken" in res.body[0], false);
});

test("owner reservation responses expose an active payment URL without leaking its token field", () => {
  const previousBaseUrl = process.env.FRONTEND_BASE_URL;
  process.env.FRONTEND_BASE_URL = "https://owner-ui.example";
  try {
    const result = toOwnerReservationResponse({
      _id: "reservation_1",
      status: "accepted_awaiting_payment",
      paymentStatus: "pending",
      secureToken: "secret-token",
    });

    assert.equal(
      result.paymentUrl,
      "https://owner-ui.example/reservation/pay/secret-token",
    );
    assert.equal("secureToken" in result, false);
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.FRONTEND_BASE_URL;
    } else {
      process.env.FRONTEND_BASE_URL = previousBaseUrl;
    }
  }
});

test("terminal or paid reservations do not expose a payment URL", () => {
  for (const reservation of [
    {
      status: "expired",
      paymentStatus: "pending",
      secureToken: "secret-token",
    },
    {
      status: "accepted_awaiting_payment",
      paymentStatus: "paid",
      secureToken: "secret-token",
    },
  ]) {
    const result = toOwnerReservationResponse(reservation);
    assert.equal(result.paymentUrl, null);
    assert.equal("secureToken" in result, false);
  }
});
