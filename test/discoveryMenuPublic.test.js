import assert from "node:assert/strict";
import test from "node:test";

process.env.REDIS_URL = "";
process.env.BULLMQ_EMAILS_ENABLED = "false";
process.env.BULLMQ_RESERVATION_SCHEDULERS_ENABLED = "false";

const [
  { default: Business },
  { default: MenuItem },
  { default: MenuInventoryRecipe },
  { getDiscoveryMenu },
] = await Promise.all([
  import("../src/models/Business.js"),
  import("../src/models/menuItem.js"),
  import("../src/models/MenuInventoryRecipe.js"),
  import("../src/controllers/discoveryMenuController.js"),
]);

const query = (value) => ({
  sort() { return this; },
  select() { return this; },
  lean: async () => structuredClone(value),
});

function business(id, countryCode = "mt", published = true, type = "restaurant") {
  return {
    businessId: id, slug: "shared-cafe", countryCode, country: "Malta",
    name: "Cafe", address: "1 Main Street", businessType: type, status: "active",
    currency: "EUR", modules: ["foodService"],
    settings: { reservationsEnabled: true },
    propertyProfile: {
      city: "Valletta", discoveryPublished: published,
      photos: [{ url: "https://example.com/cover.jpg" }],
    },
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
function request(countryCode = "mt") {
  return { params: { countryCode, slug: "shared-cafe" } };
}
function mockBusinesses(t, businesses) {
  t.mock.method(Business, "findOne", (filter) => query(
    businesses.find((item) =>
      item.slug === filter.slug &&
      item.countryCode === filter.countryCode &&
      (!filter.status?.$in || filter.status.$in.includes(item.status))
    ) || null,
  ));
}

test("Discovery menu isolates country tenants and exposes only available safe item fields", async (t) => {
  mockBusinesses(t, [business("cafe-mt"), business("cafe-gb", "gb")]);
  const tenantQueries = [];
  t.mock.method(MenuItem, "find", (filter) => {
    tenantQueries.push(filter);
    const items = [
      { _id: "mt-1", businessId: "cafe-mt", name: "Coffee", category: "Drinks", type: "drink", price: 3, isAvailable: true, imageUrl: "javascript:alert(1)", privateNote: "secret" },
      { _id: "mt-2", businessId: "cafe-mt", name: "Sold out", category: "Drinks", price: 5, isAvailable: false },
      { _id: "gb-1", businessId: "cafe-gb", name: "Tea", category: "Drinks", price: 4, isAvailable: true },
    ];
    return query(items.filter((item) => item.businessId === filter.businessId));
  });
  t.mock.method(MenuInventoryRecipe, "find", (filter) => {
    assert.ok(["cafe-mt", "cafe-gb"].includes(filter.businessId));
    return query([]);
  });
  const mt = response();
  await getDiscoveryMenu(request("mt"), mt);
  assert.equal(mt.statusCode, 200);
  assert.deepEqual(mt.body.items.map((item) => item.name), ["Coffee"]);
  assert.equal(mt.body.items[0].imageUrl, null);
  assert.equal("privateNote" in mt.body.items[0], false);
  assert.equal("businessId" in mt.body.items[0], false);
  assert.equal(mt.headers["Cache-Control"], "private, no-store, max-age=0");
  const gb = response();
  await getDiscoveryMenu(request("gb"), gb);
  assert.deepEqual(gb.body.items.map((item) => item.name), ["Tea"]);
  assert.deepEqual(tenantQueries.map((filter) => filter.businessId), ["cafe-mt", "cafe-gb"]);
  assert.ok(tenantQueries.every((filter) => filter.archivedAt === null));
});

test("Discovery menu rejects unpublished, non-food-service and unknown businesses", async (t) => {
  mockBusinesses(t, [
    business("hidden", "mt", false),
    { ...business("hotel", "gb", true, "hotel"), modules: ["lodging"] },
  ]);
  t.mock.method(MenuItem, "find", () => { throw new Error("Menu must not be queried"); });
  for (const countryCode of ["mt", "gb", "us"]) {
    const res = response();
    await getDiscoveryMenu(request(countryCode), res);
    assert.equal(res.statusCode, 404);
  }
});
