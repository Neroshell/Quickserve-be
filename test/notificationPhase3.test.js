import assert from "node:assert/strict";
import test from "node:test";

process.env.REDIS_URL = "";
process.env.BULLMQ_NOTIFICATIONS_ENABLED = "false";

const [
  { NOTIFICATION_TYPES },
  { prepareNotificationEvent },
  {
    formatNotificationReservationTime,
    notifyExternalReservationCreated,
    notifyGuestReservationArrived,
  },
  {
    createReservationArrivalToken,
    hashReservationArrivalToken,
  },
  { createReservationNotComingToken, hashReservationNotComingToken },
  { checkInRestaurantReservationArrival },
  { cancelRestaurantReservationNotComing },
  { createReservation: createPublicReservation },
] = await Promise.all([
  import("../src/constants/notifications.js"),
  import("../src/services/notificationEventRegistry.js"),
  import("../src/services/reservationNotificationService.js"),
  import("../src/services/reservationArrivalTokenService.js"),
  import("../src/services/reservationNotComingTokenService.js"),
  import("../src/services/reservationArrivalService.js"),
  import("../src/services/reservationNotComingService.js"),
  import("../src/controllers/publicController.js"),
]);

const TOKEN_ENV = {
  RESERVATION_ARRIVAL_TOKEN_SECRET:
    "test_secret_key_with_at_least_32_characters_long_for_hmac_sha256",
  RESERVATION_CANCELLATION_TOKEN_SECRET:
    "test_secret_key_with_at_least_32_characters_long_for_hmac_sha256",
  SESSION_SECRET:
    "test_secret_key_with_at_least_32_characters_long_for_hmac_sha256",
};

function restaurantBusiness() {
  return {
    _id: "business-1",
    businessId: "business-1",
    businessType: "restaurant",
    modules: ["foodService"],
    status: "active",
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function createReservationStore(initialReservation) {
  let current = { ...initialReservation };
  for (const field of [
    "arrivalTokenExpiresAt",
    "cancellationTokenExpiresAt",
  ]) {
    if (initialReservation[field]) current[field] = new Date(initialReservation[field]);
  }

  function matches(filter) {
    return Object.entries(filter).every(([field, expected]) => {
      if (field === "$or") return true;
      if (expected && typeof expected === "object" && "$gt" in expected) {
        return current[field] && new Date(current[field]) > new Date(expected.$gt);
      }
      if (expected === null) return current[field] == null;
      return current[field] === expected;
    });
  }

  return {
    get current() { return current; },
    model: {
      findOne(filter) {
        const value = matches(filter) ? current : null;
        return {
          select: async () => value,
          then: (resolve) => Promise.resolve(value).then(resolve),
        };
      },
      async findOneAndUpdate(filter, update) {
        if (!matches(filter)) return null;
        current = { ...current, ...(update.$set || {}) };
        return current;
      },
    },
  };
}

function businessModel() {
  return { findOne: () => ({ lean: async () => restaurantBusiness() }) };
}

test("reservation notification adapter produces safe canonical content and stable identity", async () => {
  const captured = [];
  const createEvent = async (event) => {
    captured.push({ event, prepared: prepareNotificationEvent(event) });
    return { created: true };
  };

  await notifyGuestReservationArrived({
    reservation: {
      _id: "reservation-1",
      businessId: "business-1",
      customerName: "Sarah Johnson",
      email: "sarah@example.com",
      guestCount: 4,
      startTime: "19:30",
      servicePointLabel: "Table 12",
      arrivalTokenUsedAt: new Date("2026-09-08T17:25:00.000Z"),
      arrivalTokenHash: "secret-token-hash",
    },
  }, { createEvent });

  await notifyExternalReservationCreated({
    reservation: {
      _id: "reservation-2",
      businessId: "business-1",
      customerName: "Hotel Guest",
      guestCount: 2,
      checkInDate: "2026-09-10",
      servicePointLabel: "Room 304",
      createdAt: new Date("2026-09-08T18:00:00.000Z"),
    },
  }, { createEvent });

  assert.equal(captured[0].prepared.title, "Sarah Johnson has arrived");
  assert.equal(captured[0].prepared.message, "Reservation for 4 · 7:30 PM · Table 12");
  assert.deepEqual(captured[0].prepared.metadata, {
    partySize: 4,
    reservationTime: "7:30 PM",
    servicePointDisplayName: "Table 12",
  });
  assert.equal(captured[0].event.entityId, "reservation-1");
  assert.equal(
    captured[0].event.idempotencyKey,
    `${NOTIFICATION_TYPES.RESERVATION_GUEST_ARRIVED}:reservation-1:guest-arrived-v1`,
  );
  assert.equal("email" in captured[0].prepared.metadata, false);
  assert.equal("arrivalTokenHash" in captured[0].prepared.metadata, false);

  assert.equal(formatNotificationReservationTime({ checkInDate: "2026-09-10" }), "Check-in 10 Sep 2026");
  assert.equal(captured[1].prepared.title, "New external reservation");
  assert.equal(captured[1].prepared.message, "Reservation for 2 · Check-in 10 Sep 2026 · Room 304");
});

test("a successful first guest arrival notifies once and duplicate clicks stay silent", async () => {
  const now = new Date("2026-09-08T17:25:00.000Z");
  const reservation = {
    _id: "reservation-arrival-1",
    businessId: "business-1",
    customerName: "Sarah Johnson",
    email: "sarah@example.com",
    guestCount: 4,
    date: "2026-09-08",
    startTime: "19:30",
    endTime: "20:30",
    servicePointLabel: "Table 12",
    status: "confirmed",
    arrivalReminderVersion: "arrival-version-1",
    arrivalTokenExpiresAt: new Date("2026-09-08T20:30:00.000Z"),
    arrivalTokenUsedAt: null,
  };
  const token = createReservationArrivalToken(reservation, { env: TOKEN_ENV });
  reservation.arrivalTokenHash = hashReservationArrivalToken(token);
  const store = createReservationStore(reservation);
  const notifications = [];
  let realtimeCount = 0;

  const first = await checkInRestaurantReservationArrival({
    token,
    now,
    env: TOKEN_ENV,
    reservationModel: store.model,
    businessModel: businessModel(),
    publish: async () => { realtimeCount += 1; },
    notify: async (input) => { notifications.push(input); },
  });
  const duplicate = await checkInRestaurantReservationArrival({
    token,
    now: new Date("2026-09-08T17:26:00.000Z"),
    env: TOKEN_ENV,
    reservationModel: store.model,
    businessModel: businessModel(),
    publish: async () => { realtimeCount += 1; },
    notify: async (input) => { notifications.push(input); },
  });

  assert.equal(first.outcome, "checked_in");
  assert.equal(duplicate.outcome, "already_checked_in");
  assert.equal(store.current.status, "arrived");
  assert.equal(store.current.arrivalSource, "email");
  assert.equal(realtimeCount, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].reservation.status, "arrived");
});

test("a successful guest cancellation notifies once and duplicate clicks stay silent", async () => {
  const now = new Date("2026-09-08T17:20:00.000Z");
  const reservation = {
    _id: "reservation-cancel-1",
    businessId: "business-1",
    customerName: "Daniel Kim",
    email: "daniel@example.com",
    guestCount: 2,
    date: "2026-09-08",
    startTime: "19:30",
    endTime: "20:30",
    status: "confirmed",
    arrivalReminderVersion: "cancel-version-1",
    cancellationTokenExpiresAt: new Date("2026-09-08T20:30:00.000Z"),
    cancellationTokenUsedAt: null,
  };
  const token = createReservationNotComingToken(reservation, { env: TOKEN_ENV });
  reservation.cancellationTokenHash = hashReservationNotComingToken(token);
  const store = createReservationStore(reservation);
  const notifications = [];

  const first = await cancelRestaurantReservationNotComing({
    token,
    now,
    env: TOKEN_ENV,
    reservationModel: store.model,
    businessModel: businessModel(),
    publish: async () => {},
    notify: async (input) => { notifications.push(input); },
  });
  const duplicate = await cancelRestaurantReservationNotComing({
    token,
    now: new Date("2026-09-08T17:21:00.000Z"),
    env: TOKEN_ENV,
    reservationModel: store.model,
    businessModel: businessModel(),
    publish: async () => {},
    notify: async (input) => { notifications.push(input); },
  });

  assert.equal(first.outcome, "cancelled");
  assert.equal(duplicate.outcome, "already_cancelled");
  assert.equal(store.current.cancellationReason, "guest_not_coming");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].reservation.status, "cancelled");
});

test("the public reservation endpoint emits external-created after persistence", async () => {
  const created = {
    _id: "reservation-public-1",
    businessId: "business-1",
    customerName: "External Guest",
    guestCount: 3,
    date: "2026-09-10",
    startTime: "18:00",
    createdAt: new Date("2026-09-08T18:00:00.000Z"),
  };
  let creationInput;
  const notifications = [];
  const response = createResponse();

  await createPublicReservation({
    body: {
      isHotelBooking: false,
      businessSlug: "test-bistro",
      customerName: "External Guest",
      phone: "+15550000000",
      email: "external@example.com",
      guestCount: 3,
      date: "2026-09-10",
      startTime: "18:00",
      endTime: "19:00",
    },
  }, response, {
    createReservationRequest: async (input) => {
      creationInput = input;
      return {
        message: "Reservation request received.",
        reservationId: created._id,
        reservation: created,
      };
    },
    notifyExternalReservation: async (input) => { notifications.push(input); },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(creationInput.source, "online");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].reservation._id, created._id);
  assert.equal("reservation" in response.body, false);
});

test("notification failure never rolls back a successful public reservation", async (t) => {
  t.mock.method(console, "error", () => {});
  const response = createResponse();
  await createPublicReservation({ body: {} }, response, {
    createReservationRequest: async () => ({
      message: "Reservation request received.",
      reservationId: "reservation-public-2",
      reservation: {
        _id: "reservation-public-2",
        businessId: "business-1",
      },
    }),
    notifyExternalReservation: async () => {
      throw new Error("temporary notification failure");
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.reservationId, "reservation-public-2");
});
