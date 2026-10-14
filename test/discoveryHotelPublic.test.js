import assert from "node:assert/strict";
import test from "node:test";

process.env.REDIS_URL = "";
process.env.BULLMQ_EMAILS_ENABLED = "false";
process.env.BULLMQ_RESERVATION_SCHEDULERS_ENABLED = "false";

const [
  { default: Business },
  { default: ServicePoint },
  { default: Reservation },
  { default: Plan },
  { getDiscoveryHotelRooms, getDiscoveryHotelAvailability },
] = await Promise.all([
  import("../src/models/Business.js"),
  import("../src/models/ServicePoint.js"),
  import("../src/models/Reservation.js"),
  import("../src/models/Plan.js"),
  import("../src/controllers/discoveryHotelController.js"),
]);

const query = (value) => ({
  sort() { return this; },
  select() { return this; },
  lean: async () => structuredClone(value),
});

function business(id, countryCode = "mt", published = true) {
  return {
    businessId: id, slug: "same-hotel", countryCode, country: "Malta",
    name: "Hotel", displayName: "Hotel", businessType: "hotel",
    addressPlaceId: "ChIJVerifiedHotelTest", latitude: 35.8992, longitude: 14.5141,
    status: "active", address: "1 Main Street", timezone: "UTC",
    currency: "EUR", modules: ["lodging"], settings: { reservationsEnabled: true },
    propertyProfile: {
      city: "Valletta", discoveryPublished: published,
      photos: [{ url: "https://example.com/cover.jpg" }],
    },
  };
}
function room(id, tenant, extra = {}) {
  return {
    servicePointId: id, businessId: tenant, servicePointType: "room",
    isActive: true, reservable: true, label: id, capacity: 2,
    pricePerNight: 100, roomType: "Deluxe", amenities: ["WiFi"],
    images: ["https://example.com/room.jpg"], ...extra,
  };
}
function response() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(value) { this.body = value; return this; },
  };
}
function request(countryCode = "mt", queryParams = {}) {
  return {
    params: { countryCode, slug: "same-hotel" },
    query: queryParams,
  };
}
function mockBusiness(t, hotels) {
  t.mock.method(Business, "findOne", (filter) => query(
    hotels.find((hotel) =>
      hotel.slug === filter.slug &&
      hotel.countryCode === filter.countryCode &&
      (!filter.status?.$in || filter.status.$in.includes(hotel.status))
    ) || null,
  ));
}

test("Discovery catalog resolves the exact country tenant and whitelists room fields", async (t) => {
  mockBusiness(t, [business("hotel-mt"), business("hotel-gb", "gb")]);
  const seen = [];
  t.mock.method(ServicePoint, "find", (filter) => {
    seen.push(filter);
    const all = [
      room("mt-room", "hotel-mt", { internalNote: "private", images: ["javascript:alert(1)", "https://example.com/a.jpg"] }),
      room("gb-room", "hotel-gb"),
      room("mt-table", "hotel-mt", { servicePointType: "table" }),
      room("mt-inactive", "hotel-mt", { isActive: false }),
      room("mt-closed", "hotel-mt", { reservable: false }),
    ];
    return query(all.filter((point) =>
      point.businessId === filter.businessId &&
      point.servicePointType === filter.servicePointType &&
      point.isActive !== false && point.reservable !== false));
  });
  const mt = response();
  await getDiscoveryHotelRooms(request("mt"), mt);
  assert.equal(mt.statusCode, 200);
  assert.equal(mt.body.currency, "EUR");
  assert.deepEqual(mt.body.rooms.map((r) => r.servicePointId), ["mt-room"]);
  assert.deepEqual(mt.body.rooms[0].images, ["https://example.com/a.jpg"]);
  assert.equal("internalNote" in mt.body.rooms[0], false);
  assert.equal("pricePerNight" in mt.body.rooms[0], false);
  assert.equal("businessId" in mt.body.rooms[0], false);
  assert.equal(mt.headers["Cache-Control"], "private, no-store, max-age=0");
  const gb = response();
  await getDiscoveryHotelRooms(request("gb"), gb);
  assert.deepEqual(gb.body.rooms.map((r) => r.servicePointId), ["gb-room"]);
  assert.deepEqual(seen.map((filter) => filter.businessId), ["hotel-mt", "hotel-gb"]);
});

test("Discovery catalog rejects unpublished and non-hotel businesses", async (t) => {
  mockBusiness(t, [
    business("unpublished", "mt", false),
    { ...business("restaurant", "gb"), businessType: "restaurant", modules: ["foodService"] },
  ]);
  t.mock.method(ServicePoint, "find", () => { throw new Error("Should not query rooms"); });
  for (const countryCode of ["mt", "gb", "us"]) {
    const res = response();
    await getDiscoveryHotelRooms(request(countryCode), res);
    assert.equal(res.statusCode, 404);
  }
});

test("Discovery availability rejects invalid dates without querying reservations", async (t) => {
  mockBusiness(t, [business("hotel-mt")]);
  t.mock.method(ServicePoint, "find", () => { throw new Error("Should not query rooms"); });
  t.mock.method(Reservation, "find", () => { throw new Error("Should not query reservations"); });
  for (const params of [
    { checkInDate: "2020-01-01", checkOutDate: "2020-01-02", guestCount: "2" },
    { checkInDate: "2099-02-30", checkOutDate: "2099-03-01", guestCount: "2" },
    { checkInDate: "2099-01-03", checkOutDate: "2099-01-02", guestCount: "2" },
  ]) {
    const res = response();
    await getDiscoveryHotelAvailability(request("mt", params), res);
    assert.equal(res.statusCode, 400);
  }
});

test("Discovery availability uses canonical quote and excludes booked, oversized and unpriced rooms", async (t) => {
  mockBusiness(t, [business("hotel-mt")]);
  // The canonical pricing calculator reads the applicable commission plan.
  // Stub only the external plan lookup, not the pricing calculation itself.
  t.mock.method(Plan, "findOne", (filter) => {
    assert.equal(filter.slug, "basic");
    return query({ slug: "basic", commissionPercentage: 3 });
  });
  t.mock.method(ServicePoint, "find", (filter) => {
    assert.equal(filter.businessId, "hotel-mt");
    return query([
      room("available", "hotel-mt"),
      room("booked", "hotel-mt"),
      room("too-small", "hotel-mt", { capacity: 1 }),
      room("unpriced", "hotel-mt", { pricePerNight: null }),
    ]);
  });
  t.mock.method(Reservation, "find", (filter) => {
    assert.equal(filter.businessId, "hotel-mt");
    return { select() { return this; }, lean: async () => [{ servicePointId: "booked" }] };
  });
  const res = response();
  await getDiscoveryHotelAvailability(request("mt", {
    checkInDate: "2099-01-01", checkOutDate: "2099-01-03", guestCount: "2",
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rooms.map((r) => r.servicePointId), ["available"]);
  assert.equal(res.body.rooms[0].pricingSummary.nights, 2);
  assert.ok(res.body.rooms[0].pricingSummary.total > 0);
  assert.equal("businessId" in res.body.rooms[0], false);
});
