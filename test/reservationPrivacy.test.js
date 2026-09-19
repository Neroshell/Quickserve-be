import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getReservationById } from "../src/controllers/publicController.js";
import {
  PUBLIC_RESERVATION_LINK_ERROR,
  PublicReservationAccessError,
  resolveReservationConfirmationAccess,
  resolveReservationPaymentAccess,
  toPublicReservationConfirmationDto,
} from "../src/services/reservationPublicAccessService.js";

const RESERVATION_A = "64b000000000000000000001";
const RESERVATION_B = "64b000000000000000000002";
const SESSION_A = "cs_test_session_a123456";
const SESSION_B = "cs_test_session_b123456";
const PAYMENT_TOKEN = "a".repeat(64);
const NOW = new Date("2026-09-19T12:00:00.000Z");

function query(value) {
  return {
    select() {
      return this;
    },
    lean() {
      return Promise.resolve(value);
    },
  };
}

function baseReservation(overrides = {}) {
  return {
    _id: RESERVATION_A,
    businessId: "biz-a",
    publicReference: "RSV-ALPHA",
    customerName: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+49123456789",
    specialRequest: "Private note",
    createdBy: { userId: "staff-secret", email: "staff@example.com" },
    internalAudit: "do-not-return",
    checkInDate: "2026-10-01",
    checkOutDate: "2026-10-03",
    guestCount: 2,
    servicePointLabel: "Room 10",
    roomTypeSnapshot: "Suite",
    pricePerNight: 100,
    numberOfNights: 2,
    subtotal: 200,
    taxRateApplied: 10,
    taxLabel: "Tax",
    taxAmount: 20,
    taxAmountCents: 2000,
    platformFeeLabel: "Platform Fee",
    platformFeeTotal: 0,
    customerPlatformFeeCents: 0,
    totalPrice: 220,
    grossAmount: 22000,
    currency: "eur",
    status: "confirmed",
    paymentStatus: "paid",
    verificationCode: "123456",
    stripeSessionId: SESSION_A,
    stripeCheckoutSessionId: SESSION_A,
    stripePaymentIntentId: "pi_secret",
    amountPaidCents: 22000,
    ...overrides,
  };
}

function baseAttempt(overrides = {}) {
  return {
    checkoutType: "reservation",
    reservationId: RESERVATION_A,
    businessId: "biz-a",
    stripeSessionId: SESSION_A,
    stripeExpiresAt: new Date("2026-09-20T12:00:00.000Z"),
    status: "completed",
    ...overrides,
  };
}

function baseBusiness(overrides = {}) {
  return {
    businessId: "biz-a",
    name: "Hotel Alpha",
    displayName: "Hotel Alpha",
    logoUrl: "https://cdn.example/logo.png",
    currency: "eur",
    countryCode: "de",
    slug: "hotel-alpha",
    ...overrides,
  };
}

function accessModels({
  reservation = baseReservation(),
  attempt = baseAttempt(),
  business = baseBusiness(),
} = {}) {
  return {
    reservationModel: {
      findOne(filter) {
        if (filter.secureToken) {
          return query(filter.secureToken === PAYMENT_TOKEN ? reservation : null);
        }
        const sessionMatches = filter.$or?.some(
          condition =>
            condition.stripeSessionId === reservation.stripeSessionId ||
            condition.stripeCheckoutSessionId === reservation.stripeCheckoutSessionId,
        );
        return query(
          String(filter._id) === String(reservation._id) &&
          filter.businessId === reservation.businessId &&
          sessionMatches
            ? reservation
            : null,
        );
      },
    },
    pendingCheckoutModel: {
      findOne(filter) {
        const allowedStatuses = filter.status?.$in || [];
        return query(
          filter.checkoutType === "reservation" &&
          String(filter.reservationId) === String(attempt.reservationId) &&
          filter.stripeSessionId === attempt.stripeSessionId &&
          allowedStatuses.includes(attempt.status)
            ? attempt
            : null,
        );
      },
    },
    businessModel: {
      findOne(filter) {
        return query(filter.businessId === business.businessId ? business : null);
      },
    },
  };
}

function resolveConfirmation(overrides = {}) {
  const models = accessModels(overrides);
  return resolveReservationConfirmationAccess({
    reservationId: overrides.reservationId || RESERVATION_A,
    checkoutSessionId: overrides.checkoutSessionId || SESSION_A,
    now: overrides.now || NOW,
    ...models,
  });
}

async function denied(promise) {
  await assert.rejects(
    promise,
    error =>
      error instanceof PublicReservationAccessError &&
      error.statusCode === 404 &&
      error.message === PUBLIC_RESERVATION_LINK_ERROR,
  );
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(values) {
      Object.assign(this.headers, values);
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test("1. anonymous raw reservationId cannot retrieve private reservation data", async () => {
  const res = responseRecorder();
  await getReservationById({ params: { reservationId: RESERVATION_A }, headers: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: PUBLIC_RESERVATION_LINK_ERROR });
  assert.equal(res.headers["Cache-Control"], "private, no-store, max-age=0");
});

test("2. raw reservationId response does not reveal guest email", async () => {
  const res = responseRecorder();
  await getReservationById({ params: { reservationId: RESERVATION_A }, headers: {} }, res);
  assert.doesNotMatch(JSON.stringify(res.body), /ada@example\.com/);
});

test("3. raw reservationId response does not reveal guest phone", async () => {
  const res = responseRecorder();
  await getReservationById({ params: { reservationId: RESERVATION_A }, headers: {} }, res);
  assert.doesNotMatch(JSON.stringify(res.body), /49123456789/);
});

test("4. raw reservationId response does not reveal internal fields", async () => {
  const res = responseRecorder();
  await getReservationById({ params: { reservationId: RESERVATION_A }, headers: {} }, res);
  assert.doesNotMatch(JSON.stringify(res.body), /staff-secret|internalAudit|stripe/);
});

test("5. unknown IDs and missing capabilities use the same safe public error", async () => {
  await denied(resolveReservationConfirmationAccess({ reservationId: "unknown" }));
  await denied(resolveReservationConfirmationAccess({ reservationId: RESERVATION_A }));
});

test("6. correct Checkout Session capability and reservation succeed", async () => {
  const result = await resolveConfirmation();
  assert.equal(result.reservation.reference, "RSV-ALPHA");
  assert.equal(result.business.displayName, "Hotel Alpha");
});

test("7. wrong Checkout Session capability is denied", async () => {
  await denied(resolveConfirmation({ checkoutSessionId: SESSION_B }));
});

test("8. expired open Checkout Session capability is denied", async () => {
  await denied(resolveConfirmation({
    attempt: baseAttempt({
      status: "open",
      stripeExpiresAt: new Date("2026-09-19T11:59:59.000Z"),
    }),
  }));
});

test("9. capability A plus reservation B is denied", async () => {
  await denied(resolveConfirmation({ reservationId: RESERVATION_B }));
});

test("10. cross-tenant attempt and reservation pairing is denied", async () => {
  await denied(resolveConfirmation({
    attempt: baseAttempt({ businessId: "biz-b" }),
  }));
});

test("11. tampered Checkout Session capability is denied", async () => {
  await denied(resolveConfirmation({ checkoutSessionId: `${SESSION_A}x` }));
});

test("12. revoked or inactive payment-attempt capability is denied", async () => {
  await denied(resolveConfirmation({ attempt: baseAttempt({ status: "expired" }) }));
});

test("13. confirmation response contains only the approved reservation DTO fields", () => {
  const dto = toPublicReservationConfirmationDto(baseReservation());
  assert.deepEqual(Object.keys(dto).sort(), [
    "checkInDate", "checkOutDate", "currency", "date", "endTime", "guestCount",
    "maskedEmail", "numberOfNights", "paymentStatus", "pricePerNight", "pricing",
    "reference", "roomType", "servicePointLabel", "startTime", "status", "type",
    "verificationCode",
  ].sort());
});

test("14. confirmation DTO excludes internal staff identities", () => {
  const dto = toPublicReservationConfirmationDto(baseReservation());
  assert.equal("createdBy" in dto, false);
  assert.doesNotMatch(JSON.stringify(dto), /staff-secret|staff@example\.com/);
});

test("15. confirmation DTO excludes private and operational notes", () => {
  const dto = toPublicReservationConfirmationDto(baseReservation());
  assert.equal("specialRequest" in dto, false);
  assert.doesNotMatch(JSON.stringify(dto), /Private note/);
});

test("16. confirmation DTO excludes audit and security fields", () => {
  const dto = toPublicReservationConfirmationDto(baseReservation());
  assert.equal("internalAudit" in dto, false);
  assert.equal("secureToken" in dto, false);
  assert.equal("_id" in dto, false);
  assert.equal("businessId" in dto, false);
});

test("17. confirmation DTO masks email and omits name and phone", () => {
  const dto = toPublicReservationConfirmationDto(baseReservation());
  assert.equal(dto.maskedEmail, "a***@example.com");
  assert.equal("customerName" in dto, false);
  assert.equal("phone" in dto, false);
  assert.doesNotMatch(JSON.stringify(dto), /Ada Lovelace|49123456789/);
});

test("18. confirmation DTO excludes provider and payment-internal fields", () => {
  const dto = toPublicReservationConfirmationDto(baseReservation());
  assert.doesNotMatch(JSON.stringify(dto), /cs_test|pi_secret|amountPaidCents|grossAmount/);
});

test("19. pending reservation state is represented without becoming payment truth", async () => {
  const result = await resolveConfirmation({
    reservation: baseReservation({ status: "pending", paymentStatus: "pending" }),
    attempt: baseAttempt({ status: "open" }),
  });
  assert.equal(result.reservation.status, "pending");
  assert.equal(result.reservation.paymentStatus, "pending");
});

test("20. awaiting-payment state remains readable only through an unexpired open attempt", async () => {
  const result = await resolveConfirmation({
    reservation: baseReservation({
      status: "accepted_awaiting_payment",
      paymentStatus: "pending",
    }),
    attempt: baseAttempt({ status: "open" }),
  });
  assert.equal(result.reservation.status, "accepted_awaiting_payment");
});

test("21. paid confirmed reservation remains readable through its completed attempt", async () => {
  const result = await resolveConfirmation();
  assert.equal(result.reservation.status, "confirmed");
  assert.equal(result.reservation.paymentStatus, "paid");
});

test("22. cancelled paid reservation renders its canonical cancelled state", async () => {
  const result = await resolveConfirmation({
    reservation: baseReservation({ status: "cancelled" }),
  });
  assert.equal(result.reservation.status, "cancelled");
});

test("23. confirmation capability expires after the post-service retention window", async () => {
  await denied(resolveConfirmation({
    reservation: baseReservation({
      checkInDate: "2026-07-01",
      checkOutDate: "2026-07-03",
    }),
  }));
});

test("24. completed stay remains readable during the 30-day post-stay window", async () => {
  const result = await resolveConfirmation({
    reservation: baseReservation({
      status: "checked_out",
      checkInDate: "2026-09-10",
      checkOutDate: "2026-09-15",
    }),
  });
  assert.equal(result.reservation.status, "checked_out");
});

test("25. confirmation capability is read-only and not accepted by action routes", async () => {
  const routes = await readFile(new URL("../src/routes/public-route.js", import.meta.url), "utf8");
  assert.match(routes, /router\.get\("\/reservations\/by-id\/:reservationId", getReservationById\)/);
  assert.doesNotMatch(routes, /router\.post\("\/reservations\/by-id\/:reservationId"/);
  assert.doesNotMatch(routes, /RESERVATION_CONFIRMATION_SESSION_HEADER/);
});

test("26. owner reservation reads remain tenant-scoped", async () => {
  const source = await readFile(new URL("../src/controllers/reservationController.js", import.meta.url), "utf8");
  assert.match(source, /const baseQuery = \{ businessId, archivedAt: null \}/);
  assert.match(source, /Reservation\.findOne\(\{[\s\S]*\.\.\.baseQuery,[\s\S]*_id: reservationId/);
});

test("27. manager reservation reads remain permission-scoped", async () => {
  const routes = await readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8");
  assert.match(routes, /router\.get\("\/reservations", requirePermission\(PERMISSIONS\.RESERVATIONS_VIEW\), getReservations\)/);
});

test("28. cross-tenant management query input remains denied", async () => {
  const source = await readFile(new URL("../src/controllers/reservationController.js", import.meta.url), "utf8");
  assert.match(source, /requestedBusinessId !== businessId/);
  assert.match(source, /Unauthorized access to this business/);
});

test("29. staff without reservation permission remains denied by owner-route middleware", async () => {
  const routes = await readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8");
  assert.match(routes, /PERMISSIONS\.RESERVATIONS_VIEW/);
  assert.match(routes, /PERMISSIONS\.RESERVATIONS_MANAGE/);
});

test("30. public capability does not grant management API access", async () => {
  const [publicRoutes, ownerRoutes] = await Promise.all([
    readFile(new URL("../src/routes/public-route.js", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(publicRoutes, /updateReservationStatus|reassignHotelRoom|deleteReservation/);
  assert.match(ownerRoutes, /requirePermission\(PERMISSIONS\.RESERVATIONS_MANAGE\)/);
});

test("payment capability returns a strict DTO only while awaiting payment", async () => {
  const reservation = baseReservation({
    status: "accepted_awaiting_payment",
    paymentStatus: "pending",
    paymentExpiresAt: new Date("2026-09-19T13:00:00.000Z"),
  });
  const models = accessModels({ reservation });
  const result = await resolveReservationPaymentAccess({
    secureToken: PAYMENT_TOKEN,
    now: NOW,
    reservationModel: models.reservationModel,
    businessModel: models.businessModel,
  });
  assert.equal(result.reservation.status, "accepted_awaiting_payment");
  assert.equal("email" in result.reservation, false);
  assert.equal("verificationCode" in result.reservation, false);
});

test("payment capability is rejected after its payment expiry", async () => {
  const reservation = baseReservation({
    status: "accepted_awaiting_payment",
    paymentStatus: "pending",
    paymentExpiresAt: new Date("2026-09-19T11:59:59.000Z"),
  });
  const models = accessModels({ reservation });
  await denied(resolveReservationPaymentAccess({
    secureToken: PAYMENT_TOKEN,
    now: NOW,
    reservationModel: models.reservationModel,
    businessModel: models.businessModel,
  }));
});
