import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

process.env.REDIS_URL = "";
process.env.BULLMQ_EMAILS_ENABLED = "false";
process.env.BULLMQ_RESERVATION_SCHEDULERS_ENABLED = "false";

const [
  { createReservation, getPublicRestaurantAvailability },
  { getAvailableStayServicePoints },
  {
    PUBLIC_SERVABLE_BUSINESS_STATUSES,
    resolvePublicBusiness,
  },
  { createReservationService },
  { default: Business },
  { default: Reservation },
  { default: ServicePoint },
  { default: Plan },
] = await Promise.all([
  import("../src/controllers/publicController.js"),
  import("../src/controllers/reservationController.js"),
  import("../src/services/publicBusinessResolverService.js"),
  import("../src/services/reservationCreationService.js"),
  import("../src/models/Business.js"),
  import("../src/models/Reservation.js"),
  import("../src/models/ServicePoint.js"),
  import("../src/models/Plan.js"),
]);

function queryFor(value) {
  return {
    limit() { return this; },
    select() { return this; },
    session() { return this; },
    lean: async () => structuredClone(value),
    then(resolve, reject) {
      return Promise.resolve(structuredClone(value)).then(resolve, reject);
    },
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

function operatingHours() {
  return Object.fromEntries([
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  ].map((day) => [day, {
    enabled: true,
    openTime: "09:00",
    closeTime: "22:00",
  }]));
}

function business({
  businessId,
  countryCode,
  slug,
  businessType = "restaurant",
}) {
  return {
    businessId,
    countryCode,
    slug,
    status: "active",
    name: `${businessId} name`,
    displayName: businessId,
    businessType,
    modules: businessType === "hotel" ? ["lodging"] : ["foodService"],
    timezone: "UTC",
    currency: "EUR",
    settings: { reservationsEnabled: true },
    hotelSettings: { onlineBookingConfirmationMode: "confirmation_required" },
    operatingHours: operatingHours(),
  };
}

function matches(candidate, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (expected?.$in) return expected.$in.includes(candidate[field]);
    return candidate[field] === expected;
  });
}

function businessModelFor(businesses) {
  return {
    findOne(filter) {
      return queryFor(businesses.find((candidate) => matches(candidate, filter)) || null);
    },
    find(filter) {
      return queryFor(businesses.filter((candidate) => matches(candidate, filter)));
    },
  };
}

test("canonical resolver isolates equal slugs by country and fails closed for legacy ambiguity", async () => {
  const businesses = [
    business({ businessId: "restaurant-mt", countryCode: "mt", slug: "same-place" }),
    business({ businessId: "restaurant-gb", countryCode: "gb", slug: "same-place" }),
  ];
  const businessModel = businessModelFor(businesses);

  const malta = await resolvePublicBusiness({
    businessSlug: " SAME-PLACE ",
    countryCode: " MT ",
    statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
    businessModel,
  });
  const britain = await resolvePublicBusiness({
    businessSlug: "same-place",
    countryCode: "gb",
    statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
    businessModel,
  });
  const wrongCountry = await resolvePublicBusiness({
    businessSlug: "same-place",
    countryCode: "de",
    statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
    businessModel,
  });

  assert.equal(malta.business.businessId, "restaurant-mt");
  assert.equal(britain.business.businessId, "restaurant-gb");
  assert.equal(wrongCountry.business, null);
  await assert.rejects(
    resolvePublicBusiness({
      businessSlug: "same-place",
      statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
      businessModel,
    }),
    (error) => error.statusCode === 409 &&
      error.code === "AMBIGUOUS_PUBLIC_BUSINESS_SLUG",
  );

  const unique = await resolvePublicBusiness({
    businessSlug: "same-place",
    statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
    businessModel: businessModelFor([businesses[0]]),
  });
  assert.equal(unique.business.businessId, "restaurant-mt");
  assert.equal(unique.legacy, true);

  await assert.rejects(
    resolvePublicBusiness({
      businessSlug: "same-place",
      statuses: PUBLIC_SERVABLE_BUSINESS_STATUSES,
      businessModel: businessModelFor([
        businesses[0],
        { ...businesses[1], status: "disabled" },
      ]),
    }),
    (error) => error.code === "AMBIGUOUS_PUBLIC_BUSINESS_SLUG",
  );
});

test("public creation derives canonical tenant from country and ignores client businessId", async () => {
  const restaurants = [
    business({ businessId: "restaurant-mt", countryCode: "mt", slug: "same-table" }),
    business({ businessId: "restaurant-gb", countryCode: "gb", slug: "same-table" }),
  ];
  const hotels = [
    business({ businessId: "hotel-mt", countryCode: "mt", slug: "same-hotel", businessType: "hotel" }),
    business({ businessId: "hotel-gb", countryCode: "gb", slug: "same-hotel", businessType: "hotel" }),
  ];
  const model = businessModelFor([...restaurants, ...hotels]);
  const captures = [];
  const resolveBusinessRequest = (input) => resolvePublicBusiness({
    ...input,
    businessModel: model,
  });
  const createReservationRequest = async (input) => {
    captures.push(input);
    return {
      message: "created",
      reservationId: `reservation-${captures.length}`,
      reservation: { businessId: input.business.businessId },
    };
  };

  for (const countryCode of ["mt", "gb"]) {
    const res = createResponse();
    await createReservation({
      headers: { "idempotency-key": `restaurant-${countryCode}` },
      get(name) { return this.headers[name.toLowerCase()]; },
      body: {
        countryCode,
        businessSlug: "same-table",
        businessId: countryCode === "mt" ? "restaurant-gb" : "restaurant-mt",
        customerName: "Restaurant Guest",
        phone: "+15550000000",
        email: "restaurant@example.test",
        guestCount: 2,
        date: "2099-09-22",
        startTime: "10:00",
        endTime: "11:00",
      },
    }, res, {
      createReservationRequest,
      notifyExternalReservation: async () => {},
      resolveBusinessRequest,
    });
    assert.equal(res.statusCode, 201);
  }

  for (const countryCode of ["mt", "gb"]) {
    const res = createResponse();
    await createReservation({
      body: {
        isHotelBooking: true,
        countryCode,
        businessSlug: "same-hotel",
        businessId: countryCode === "mt" ? "hotel-gb" : "hotel-mt",
        customerName: "Hotel Guest",
        phone: "+15550000000",
        email: "hotel@example.test",
        guestCount: 2,
        checkInDate: "2099-09-22",
        checkOutDate: "2099-09-23",
        servicePointId: `room-${countryCode}`,
      },
    }, res, {
      createReservationRequest,
      notifyExternalReservation: async () => {},
      resolveBusinessRequest,
    });
    assert.equal(res.statusCode, 201);
  }

  assert.deepEqual(
    captures.map((capture) => capture.business.businessId),
    ["restaurant-mt", "restaurant-gb", "hotel-mt", "hotel-gb"],
  );
  assert.deepEqual(
    captures.map((capture) => capture.countryCode),
    ["mt", "gb", "mt", "gb"],
  );
  assert.equal(captures.some((capture) => capture.businessId), false);
});

test("same-slug restaurant creation persists inside the selected country tenant", async (t) => {
  const businesses = [
    business({ businessId: "restaurant-mt", countryCode: "mt", slug: "same-table" }),
    business({ businessId: "restaurant-gb", countryCode: "gb", slug: "same-table" }),
  ];
  const points = [
    {
      businessId: "restaurant-mt",
      servicePointId: "table-mt",
      label: "Malta Table",
      servicePointType: "table",
      capacity: 4,
      isActive: true,
      reservable: true,
    },
    {
      businessId: "restaurant-gb",
      servicePointId: "table-gb",
      label: "Britain Table",
      servicePointType: "table",
      capacity: 4,
      isActive: true,
      reservable: true,
    },
  ];
  const candidateScopes = [];
  const lockScopes = [];
  const saved = [];

  t.mock.method(Business, "findOne", (filter) =>
    queryFor(businesses.find((candidate) => matches(candidate, filter)) || null));
  t.mock.method(ServicePoint, "find", (filter) => {
    candidateScopes.push(filter.businessId);
    return queryFor(points.filter((point) =>
      point.businessId === filter.businessId &&
      (!filter.servicePointId || point.servicePointId === filter.servicePointId)));
  });
  t.mock.method(ServicePoint, "findOneAndUpdate", (filter) => {
    lockScopes.push(filter.businessId);
    return queryFor(points.find((point) =>
      point.businessId === filter.businessId &&
      point.servicePointId === filter.servicePointId) || null);
  });
  t.mock.method(Reservation, "find", () => queryFor([]));
  t.mock.method(Reservation, "findOne", () => queryFor(null));
  t.mock.method(Reservation.prototype, "save", async function () {
    saved.push({
      businessId: this.businessId,
      servicePointId: this.servicePointId,
    });
  });
  t.mock.method(mongoose, "startSession", async () => ({
    async withTransaction(work) { return work(); },
    async endSession() {},
  }));

  for (const countryCode of ["mt", "gb"]) {
    const res = createResponse();
    await createReservation({
      headers: { "idempotency-key": `same-table-${countryCode}` },
      get(name) { return this.headers[name.toLowerCase()]; },
      body: {
        countryCode,
        businessSlug: "same-table",
        businessId: countryCode === "mt" ? "restaurant-gb" : "restaurant-mt",
        customerName: `${countryCode} guest`,
        phone: "+15550000000",
        email: `${countryCode}@example.test`,
        guestCount: 2,
        date: "2099-09-22",
        startTime: "10:00",
        endTime: "11:00",
        durationMinutes: 60,
        servicePointId: `table-${countryCode}`,
      },
    }, res, {
      createReservationRequest: (input) => createReservationService({
        ...input,
        notificationMode: "none",
      }),
      notifyExternalReservation: async () => {},
    });
    assert.equal(res.statusCode, 201);
  }

  assert.deepEqual(saved, [
    { businessId: "restaurant-mt", servicePointId: "table-mt" },
    { businessId: "restaurant-gb", servicePointId: "table-gb" },
  ]);
  assert.deepEqual(candidateScopes, ["restaurant-mt", "restaurant-gb"]);
  assert.deepEqual(lockScopes, ["restaurant-mt", "restaurant-gb"]);
});

test("same-slug hotel creation locks and persists the room inside the selected country tenant", async (t) => {
  const businesses = [
    business({ businessId: "hotel-mt", countryCode: "mt", slug: "same-hotel", businessType: "hotel" }),
    business({ businessId: "hotel-gb", countryCode: "gb", slug: "same-hotel", businessType: "hotel" }),
  ].map((item) => ({
    ...item,
    hotelSettings: { onlineBookingConfirmationMode: "instant" },
  }));
  const rooms = [
    {
      businessId: "hotel-mt",
      servicePointId: "room-mt",
      label: "Malta Room",
      servicePointType: "room",
      capacity: 2,
      pricePerNight: 100,
      isActive: true,
      reservable: true,
    },
    {
      businessId: "hotel-gb",
      servicePointId: "room-gb",
      label: "Britain Room",
      servicePointType: "room",
      capacity: 2,
      pricePerNight: 100,
      isActive: true,
      reservable: true,
    },
  ];
  const lockScopes = [];
  const saved = [];

  t.mock.method(Business, "findOne", (filter) =>
    queryFor(businesses.find((candidate) => matches(candidate, filter)) || null));
  t.mock.method(ServicePoint, "findOneAndUpdate", (filter) => {
    lockScopes.push(filter.businessId);
    return queryFor(rooms.find((room) =>
      room.businessId === filter.businessId &&
      room.servicePointId === filter.servicePointId) || null);
  });
  t.mock.method(Reservation, "findOne", () => queryFor(null));
  t.mock.method(Plan, "findOne", () => queryFor(null));
  t.mock.method(Reservation.prototype, "save", async function () {
    saved.push({
      businessId: this.businessId,
      servicePointId: this.servicePointId,
    });
  });
  t.mock.method(mongoose, "startSession", async () => ({
    async withTransaction(work) { return work(); },
    async endSession() {},
  }));

  for (const countryCode of ["mt", "gb"]) {
    const res = createResponse();
    await createReservation({
      body: {
        isHotelBooking: true,
        countryCode,
        businessSlug: "same-hotel",
        businessId: countryCode === "mt" ? "hotel-gb" : "hotel-mt",
        customerName: `${countryCode} hotel guest`,
        phone: "+15550000000",
        email: `${countryCode}-hotel@example.test`,
        guestCount: 2,
        checkInDate: "2099-09-22",
        checkOutDate: "2099-09-23",
        servicePointId: `room-${countryCode}`,
      },
    }, res, {
      createReservationRequest: createReservationService,
      notifyExternalReservation: async () => {},
    });
    assert.equal(res.statusCode, 201);
  }

  assert.deepEqual(saved, [
    { businessId: "hotel-mt", servicePointId: "room-mt" },
    { businessId: "hotel-gb", servicePointId: "room-gb" },
  ]);
  assert.deepEqual(lockScopes, ["hotel-mt", "hotel-gb"]);
});

test("restaurant availability returns only ServicePoints from the country-resolved tenant", async (t) => {
  const businesses = [
    business({ businessId: "restaurant-mt", countryCode: "mt", slug: "same-table" }),
    business({ businessId: "restaurant-gb", countryCode: "gb", slug: "same-table" }),
  ];
  const points = [
    {
      businessId: "restaurant-mt",
      servicePointId: "table-mt",
      label: "Malta Table",
      servicePointType: "table",
      capacity: 4,
      isActive: true,
      reservable: true,
    },
    {
      businessId: "restaurant-gb",
      servicePointId: "table-gb",
      label: "Britain Table",
      servicePointType: "table",
      capacity: 4,
      isActive: true,
      reservable: true,
    },
  ];
  const servicePointScopes = [];

  t.mock.method(Business, "findOne", (filter) =>
    queryFor(businesses.find((candidate) => matches(candidate, filter)) || null));
  t.mock.method(ServicePoint, "find", (filter) => {
    servicePointScopes.push(filter.businessId);
    return queryFor(points.filter((point) => point.businessId === filter.businessId));
  });
  t.mock.method(Reservation, "find", (filter) => queryFor([]));

  for (const [countryCode, expectedPoint] of [["mt", "table-mt"], ["gb", "table-gb"]]) {
    const res = createResponse();
    await getPublicRestaurantAvailability({
      query: {
        countryCode,
        businessSlug: "same-table",
        businessId: countryCode === "mt" ? "restaurant-gb" : "restaurant-mt",
        date: "2099-09-22",
        month: "2099-09",
        partySize: "2",
        durationMinutes: "60",
        startTime: "10:00",
      },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.body.servicePoints.map((point) => point.servicePointId),
      [expectedPoint],
    );
  }

  const wrong = createResponse();
  await getPublicRestaurantAvailability({
    query: {
      countryCode: "de",
      businessSlug: "same-table",
      date: "2099-09-22",
      partySize: "2",
    },
  }, wrong);
  assert.equal(wrong.statusCode, 404);
  assert.deepEqual(servicePointScopes, ["restaurant-mt", "restaurant-gb"]);
});

test("hotel availability returns only rooms from the country-resolved tenant", async (t) => {
  const businesses = [
    business({ businessId: "hotel-mt", countryCode: "mt", slug: "same-hotel", businessType: "hotel" }),
    business({ businessId: "hotel-gb", countryCode: "gb", slug: "same-hotel", businessType: "hotel" }),
  ];
  const rooms = [
    {
      businessId: "hotel-mt",
      servicePointId: "room-mt",
      label: "Malta Room",
      servicePointType: "room",
      capacity: 2,
      pricePerNight: null,
      isActive: true,
      reservable: true,
    },
    {
      businessId: "hotel-gb",
      servicePointId: "room-gb",
      label: "Britain Room",
      servicePointType: "room",
      capacity: 2,
      pricePerNight: null,
      isActive: true,
      reservable: true,
    },
  ];
  const reservationScopes = [];
  const roomScopes = [];

  t.mock.method(Business, "findOne", (filter) =>
    queryFor(businesses.find((candidate) => matches(candidate, filter)) || null));
  t.mock.method(Reservation, "find", (filter) => {
    reservationScopes.push(filter.businessId);
    return queryFor([]);
  });
  t.mock.method(ServicePoint, "find", (filter) => {
    roomScopes.push(filter.businessId);
    return queryFor(rooms.filter((room) => room.businessId === filter.businessId));
  });

  for (const [countryCode, expectedRoom] of [["mt", "room-mt"], ["gb", "room-gb"]]) {
    const res = createResponse();
    await getAvailableStayServicePoints({
      query: {
        countryCode,
        businessSlug: "same-hotel",
        businessId: countryCode === "mt" ? "hotel-gb" : "hotel-mt",
        checkInDate: "2099-09-22",
        checkOutDate: "2099-09-23",
      },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.body.map((room) => room.servicePointId),
      [expectedRoom],
    );
  }

  const wrong = createResponse();
  await getAvailableStayServicePoints({
    query: {
      countryCode: "de",
      businessSlug: "same-hotel",
      checkInDate: "2099-09-22",
      checkOutDate: "2099-09-23",
    },
  }, wrong);
  assert.equal(wrong.statusCode, 404);
  assert.deepEqual(reservationScopes, ["hotel-mt", "hotel-gb"]);
  assert.deepEqual(roomScopes, ["hotel-mt", "hotel-gb"]);
});
