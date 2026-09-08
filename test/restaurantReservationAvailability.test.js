import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mongoose from "mongoose";

process.env.REDIS_URL = "";
process.env.BULLMQ_EMAILS_ENABLED = "false";
process.env.RESEND_API_KEY = "re_test_restaurant_availability";

const [
  {
    RESTAURANT_AVAILABILITY_POLICIES,
    buildRestaurantConflictQuery,
    getRestaurantAvailability,
    isRestaurantServicePointEligible,
    validateRestaurantReservationWindow,
  },
  { createRestaurantReservation },
  { getOwnerRestaurantAvailability },
  { getPublicRestaurantAvailability },
  { default: Business },
  { default: Reservation },
  { default: ServicePoint },
] = await Promise.all([
  import("../src/services/restaurantReservationAvailabilityService.js"),
  import("../src/services/reservationCreationService.js"),
  import("../src/controllers/reservationController.js"),
  import("../src/controllers/publicController.js"),
  import("../src/models/Business.js"),
  import("../src/models/Reservation.js"),
  import("../src/models/ServicePoint.js"),
]);

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function mockQuery(value) {
  return {
    select() { return this; },
    session() { return this; },
    lean: async () => value,
  };
}

function createBusiness(overrides = {}) {
  const operatingHours = Object.fromEntries([
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  ].map((day) => [day, { enabled: true, openTime: "10:00", closeTime: "14:00" }]));
  return {
    businessId: "business-a",
    slug: "test-bistro",
    status: "active",
    businessType: "restaurant",
    modules: ["foodService"],
    timezone: "UTC",
    settings: { reservationsEnabled: true },
    operatingHours,
    ...overrides,
  };
}

function createPoint(overrides = {}) {
  return {
    businessId: "business-a",
    servicePointId: "table-a",
    label: "Table A",
    servicePointType: "table",
    capacity: 4,
    isActive: true,
    reservable: true,
    ...overrides,
  };
}

function mockAvailabilityDatabase(t, { business, points, reservations = [], capture = {} }) {
  t.mock.method(Business, "findOne", (query) => {
    capture.businessQuery = query;
    return mockQuery(business);
  });
  t.mock.method(ServicePoint, "find", (query) => {
    capture.servicePointQuery = query;
    return mockQuery(points);
  });
  t.mock.method(Reservation, "find", (query) => {
    capture.reservationQuery = query;
    return mockQuery(reservations);
  });
}

test("business timezone, operating days, hours, duration and future-time rules are canonical", () => {
  const business = createBusiness({
    timezone: "America/New_York",
    operatingHours: {
      Tuesday: { enabled: true, openTime: "09:00", closeTime: "22:00" },
      Wednesday: { enabled: false, openTime: "09:00", closeTime: "22:00" },
    },
  });
  const now = "2026-09-08T13:00:00Z"; // 09:00 in New York

  const valid = validateRestaurantReservationWindow({
    business,
    date: "2026-09-08",
    startTime: "09:30",
    endTime: "10:30",
    durationMinutes: 60,
    now,
  });
  assert.equal(valid.timezone, "America/New_York");
  assert.equal(valid.reservationStart.offset, -240);

  assert.throws(() => validateRestaurantReservationWindow({
    business,
    date: "2026-09-09",
    startTime: "10:00",
    endTime: "11:00",
    now,
  }), /business hours/i);
  assert.throws(() => validateRestaurantReservationWindow({
    business,
    date: "2026-09-15",
    startTime: "08:30",
    endTime: "09:30",
    now,
  }), /business hours/i);
  assert.throws(() => validateRestaurantReservationWindow({
    business,
    date: "2026-09-15",
    startTime: "21:30",
    endTime: "22:30",
    now,
  }), /business hours/i);
  assert.throws(() => validateRestaurantReservationWindow({
    business,
    date: "2026-09-08",
    startTime: "08:00",
    endTime: "09:00",
    now,
  }), /business hours|past/i);
  assert.throws(() => validateRestaurantReservationWindow({
    business,
    date: "2026-09-08",
    startTime: "09:30",
    endTime: "10:00",
    durationMinutes: 60,
    now,
  }), /does not match/i);
});

test("ServicePoint policy rejects inactive, room and public non-reservable resources", () => {
  const publicPolicy = RESTAURANT_AVAILABILITY_POLICIES.public;
  const walkInPolicy = RESTAURANT_AVAILABILITY_POLICIES.ownerWalkIn;
  assert.equal(isRestaurantServicePointEligible(createPoint(), publicPolicy), true);
  assert.equal(isRestaurantServicePointEligible(createPoint({ isActive: false }), publicPolicy), false);
  assert.equal(isRestaurantServicePointEligible(createPoint({ servicePointType: "room" }), publicPolicy), false);
  assert.equal(isRestaurantServicePointEligible(createPoint({ reservable: false }), publicPolicy), false);
  assert.equal(isRestaurantServicePointEligible(createPoint({ reservable: false }), walkInPolicy), true);
});

for (const status of ["confirmed", "arrived", "seated"]) {
  test(`${status} overlaps block the selected ServicePoint`, async (t) => {
    const business = createBusiness();
    const point = createPoint();
    mockAvailabilityDatabase(t, {
      business,
      points: [point],
      reservations: [{
        businessId: business.businessId,
        servicePointId: point.servicePointId,
        date: "2026-09-08",
        startTime: "10:00",
        endTime: "11:00",
        status,
      }],
    });

    const result = await getRestaurantAvailability({
      businessId: business.businessId,
      business,
      date: "2026-09-08",
      month: "2026-09",
      partySize: 2,
      durationMinutes: 60,
      servicePointId: point.servicePointId,
      policy: RESTAURANT_AVAILABILITY_POLICIES.public,
      now: "2026-09-08T09:00:00Z",
    });

    assert.equal(result.availableStartTimes.includes("10:00"), false);
    assert.equal(result.availableStartTimes.includes("11:00"), true);
  });
}

test("cancelled reservations are non-blocking", async (t) => {
  const business = createBusiness();
  const point = createPoint();
  mockAvailabilityDatabase(t, {
    business,
    points: [point],
    reservations: [{
      businessId: business.businessId,
      servicePointId: point.servicePointId,
      date: "2026-09-08",
      startTime: "10:00",
      endTime: "11:00",
      status: "cancelled",
    }],
  });

  const result = await getRestaurantAvailability({
    businessId: business.businessId,
    business,
    date: "2026-09-08",
    partySize: 2,
    durationMinutes: 60,
    servicePointId: point.servicePointId,
    policy: RESTAURANT_AVAILABILITY_POLICIES.public,
    now: "2026-09-08T09:00:00Z",
  });
  assert.equal(result.availableStartTimes.includes("10:00"), true);
});

test("no-preference, multiple tables and valid end times use the same overlap set", async (t) => {
  const business = createBusiness();
  const tableA = createPoint({ servicePointId: "table-a", label: "Table A", capacity: 4 });
  const tableB = createPoint({ servicePointId: "table-b", label: "Table B", capacity: 6 });
  const reservations = [
    { businessId: "business-a", servicePointId: "table-a", date: "2026-09-08", startTime: "10:00", endTime: "11:00", status: "confirmed" },
    { businessId: "business-a", servicePointId: "table-b", date: "2026-09-08", startTime: "11:00", endTime: "12:00", status: "arrived" },
    { businessId: "business-a", servicePointId: "table-a", date: "2026-09-08", startTime: "12:00", endTime: "13:00", status: "seated" },
    { businessId: "other-business", servicePointId: "table-b", date: "2026-09-08", startTime: "10:00", endTime: "14:00", status: "confirmed" },
  ];
  const capture = {};
  mockAvailabilityDatabase(t, {
    business,
    points: [
      tableA,
      tableB,
      createPoint({ businessId: "other-business", servicePointId: "foreign-table", capacity: 50 }),
      createPoint({ servicePointId: "room-a", servicePointType: "room", capacity: 50 }),
      createPoint({ servicePointId: "inactive-a", isActive: false, capacity: 50 }),
    ],
    reservations,
    capture,
  });

  const result = await getRestaurantAvailability({
    businessId: business.businessId,
    business,
    date: "2026-09-08",
    month: "2026-09",
    partySize: 4,
    durationMinutes: 60,
    startTime: "10:00",
    policy: RESTAURANT_AVAILABILITY_POLICIES.public,
    now: "2026-09-08T09:00:00Z",
  });

  assert.equal(result.noPreferenceAvailable, true);
  assert.deepEqual(result.validEndTimes, ["10:30", "11:00"]);
  assert.deepEqual(result.servicePoints.map((point) => point.servicePointId), ["table-b"]);
  assert.equal(result.availableStartTimes.includes("10:00"), true);
  assert.equal(result.availableDates.includes("2026-09-08"), true);
  assert.equal(capture.servicePointQuery.businessId, "business-a");
  assert.equal(capture.reservationQuery.businessId, "business-a");
  assert.deepEqual(capture.reservationQuery.status.$in, ["confirmed", "arrived", "seated"]);
});

test("ServicePoint options update for the selected date even before a start is chosen", async (t) => {
  const business = createBusiness();
  const tableA = createPoint({ servicePointId: "table-a" });
  const tableB = createPoint({ servicePointId: "table-b" });
  mockAvailabilityDatabase(t, {
    business,
    points: [tableA, tableB],
    reservations: [{
      businessId: business.businessId,
      servicePointId: tableA.servicePointId,
      date: "2026-09-08",
      startTime: "10:00",
      endTime: "14:00",
      status: "confirmed",
    }],
  });

  const result = await getRestaurantAvailability({
    businessId: business.businessId,
    business,
    date: "2026-09-08",
    partySize: 2,
    durationMinutes: 60,
    servicePointId: tableA.servicePointId,
    policy: RESTAURANT_AVAILABILITY_POLICIES.owner,
    now: "2026-09-08T09:00:00Z",
  });

  assert.equal(result.selectedServicePointAvailable, false);
  assert.deepEqual(result.servicePoints.map((point) => point.servicePointId), ["table-b"]);
});

test("party capacity can produce an explicit no-valid-ServicePoint result", async (t) => {
  const business = createBusiness();
  mockAvailabilityDatabase(t, {
    business,
    points: [createPoint({ capacity: 2 }), createPoint({ servicePointId: "table-b", capacity: 4 })],
  });

  const result = await getRestaurantAvailability({
    businessId: business.businessId,
    business,
    date: "2026-09-08",
    partySize: 5,
    durationMinutes: 60,
    policy: RESTAURANT_AVAILABILITY_POLICIES.public,
    now: "2026-09-08T09:00:00Z",
  });
  assert.equal(result.reason, "no_service_point_can_fit_party");
  assert.equal(result.noPreferenceAvailable, false);
  assert.deepEqual(result.availableStartTimes, []);
  assert.deepEqual(result.servicePoints, []);
});

test("public and owner policies differ explicitly when online reservations are disabled", async (t) => {
  const business = createBusiness({ settings: { reservationsEnabled: false } });
  mockAvailabilityDatabase(t, { business, points: [createPoint()] });

  await assert.rejects(
    getRestaurantAvailability({
      businessId: business.businessId,
      business,
      date: "2026-09-08",
      partySize: 2,
      policy: RESTAURANT_AVAILABILITY_POLICIES.public,
      now: "2026-09-08T09:00:00Z",
    }),
    (error) => error.statusCode === 403,
  );

  const ownerResult = await getRestaurantAvailability({
    businessId: business.businessId,
    business,
    date: "2026-09-08",
    partySize: 2,
    policy: RESTAURANT_AVAILABILITY_POLICIES.owner,
    now: "2026-09-08T09:00:00Z",
  });
  assert.ok(ownerResult.availableStartTimes.length > 0);
});

test("owner availability derives tenant scope from the authenticated session", async (t) => {
  const business = createBusiness();
  const capture = {};
  mockAvailabilityDatabase(t, { business, points: [createPoint()], capture });
  const res = createResponse();

  await getOwnerRestaurantAvailability({
    session: { user: { businessId: "business-a" } },
    query: {
      businessId: "spoofed-business",
      date: "2026-09-08",
      partySize: "2",
      durationMinutes: "60",
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capture.businessQuery, { businessId: "business-a" });
  assert.equal(capture.servicePointQuery.businessId, "business-a");
  assert.equal(capture.reservationQuery.businessId, "business-a");
  assert.equal("businessId" in res.body, false);
  assert.equal("reservations" in res.body, false);
});

test("owner availability requires an authenticated business context", async () => {
  const res = createResponse();
  await getOwnerRestaurantAvailability({ session: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);
});

test("owner and public availability routes keep their authorization and rate-limit wrappers", async () => {
  const [ownerRoute, publicRoute] = await Promise.all([
    readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/public-route.js", import.meta.url), "utf8"),
  ]);
  assert.match(
    ownerRoute,
    /"\/reservations\/restaurant-availability",\s*requirePermission\(PERMISSIONS\.RESERVATIONS_MANAGE\),\s*getOwnerRestaurantAvailability/s,
  );
  assert.match(
    publicRoute,
    /"\/reservations\/restaurant-availability",\s*reservationAvailabilityLimiter,\s*getPublicRestaurantAvailability/s,
  );
});

test("public availability resolves its business identifier and cannot inherit owner overrides", async (t) => {
  const business = createBusiness({ settings: { reservationsEnabled: false } });
  let businessQuery;
  t.mock.method(Business, "findOne", (query) => {
    businessQuery = query;
    return mockQuery(business);
  });
  const res = createResponse();

  await getPublicRestaurantAvailability({
    query: {
      businessSlug: "TEST-BISTRO",
      countryCode: "MT",
      businessId: "spoofed-business",
      date: "2026-09-08",
      partySize: "2",
    },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(businessQuery.slug, "test-bistro");
  assert.equal(businessQuery.countryCode, "mt");
  assert.equal("businessId" in businessQuery, false);
  assert.match(res.body.error, /disabled/i);
});

test("walk-ins preserve active non-reservable ServicePoints and current-time buckets", async (t) => {
  const business = createBusiness({
    operatingHours: Object.fromEntries([
      "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    ].map((day) => [day, { enabled: true, openTime: "09:00", closeTime: "22:00" }])),
  });
  const nonReservable = createPoint({ reservable: false });
  mockAvailabilityDatabase(t, { business, points: [nonReservable] });

  const walkIn = await getRestaurantAvailability({
    businessId: business.businessId,
    business,
    date: "2026-09-08",
    partySize: 2,
    durationMinutes: 60,
    policy: RESTAURANT_AVAILABILITY_POLICIES.ownerWalkIn,
    now: "2026-09-08T10:07:00Z",
  });
  assert.equal(walkIn.availableStartTimes.includes("10:05"), true);
  assert.deepEqual(walkIn.servicePoints.map((point) => point.servicePointId), ["table-a"]);
});

test("conflict queries are tenant scoped and use half-open overlap semantics", () => {
  assert.deepEqual(buildRestaurantConflictQuery({
    businessId: "business-a",
    servicePointId: "table-a",
    date: "2026-09-08",
    startTime: "10:00",
    endTime: "11:00",
  }), {
    businessId: "business-a",
    servicePointId: "table-a",
    date: "2026-09-08",
    status: { $in: ["confirmed", "arrived", "seated"] },
    startTime: { $lt: "11:00" },
    endTime: { $gt: "10:00" },
  });
});

test("final owner creation loses a stale-availability race with 409 and no double booking", async (t) => {
  const date = "2099-07-07";
  const business = createBusiness({
    operatingHours: {
      Tuesday: { enabled: true, openTime: "09:00", closeTime: "22:00" },
    },
  });
  const point = createPoint();
  let reservationFindCalls = 0;
  let saveCalls = 0;
  let lockCalls = 0;

  t.mock.method(Business, "findOne", () => mockQuery(business));
  t.mock.method(ServicePoint, "find", () => mockQuery([point]));
  t.mock.method(ServicePoint, "findOneAndUpdate", (filter, update, options) => {
    lockCalls += 1;
    assert.equal(filter.businessId, business.businessId);
    assert.equal(filter.servicePointId, point.servicePointId);
    assert.deepEqual(update, { $currentDate: { updatedAt: true } });
    assert.equal(options.new, true);
    return mockQuery(point);
  });
  t.mock.method(Reservation, "find", () => {
    reservationFindCalls += 1;
    return mockQuery([]);
  });
  t.mock.method(Reservation, "findOne", () => mockQuery({
    businessId: business.businessId,
    servicePointId: point.servicePointId,
    date,
    startTime: "10:00",
    endTime: "11:00",
    status: "confirmed",
  }));
  t.mock.method(Reservation.prototype, "save", async () => {
    saveCalls += 1;
  });
  t.mock.method(mongoose, "startSession", async () => ({
    async withTransaction(work) { return work(); },
    async endSession() {},
  }));

  const advisory = await getRestaurantAvailability({
    businessId: business.businessId,
    business,
    date,
    partySize: 2,
    durationMinutes: 60,
    servicePointId: point.servicePointId,
    policy: RESTAURANT_AVAILABILITY_POLICIES.owner,
    now: "2099-07-07T09:00:00Z",
  });
  assert.equal(advisory.availableStartTimes.includes("10:00"), true);

  await assert.rejects(
    createRestaurantReservation({
      businessSlug: business.slug,
      business,
      customerName: "Race Loser",
      phone: "+15550000000",
      email: "race@example.com",
      date,
      startTime: "10:00",
      endTime: "11:00",
      durationMinutes: 60,
      guestCount: 2,
      servicePointId: point.servicePointId,
      source: "dashboard",
      initialStatus: "confirmed",
      availabilityPolicy: RESTAURANT_AVAILABILITY_POLICIES.owner,
      notificationMode: "none",
    }),
    (error) => error.statusCode === 409 && /already booked/i.test(error.message),
  );

  assert.equal(reservationFindCalls, 1);
  assert.equal(lockCalls, 1);
  assert.equal(saveCalls, 0);
});
