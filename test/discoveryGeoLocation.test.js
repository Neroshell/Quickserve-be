import assert from "node:assert/strict";
import test from "node:test";

const { default: Business } = await import("../src/models/Business.js");

function sampleBusiness(coordinates) {
  const business = new Business({
    businessId: "geo-test",
    name: "Geographic Test",
    displayName: "Geographic Test",
    slug: "geographic-test",
    countryCode: "mt",
    businessType: "restaurant",
    modules: ["foodService"],
    ...coordinates,
  });
  return business;
}

test("Business derives a GeoJSON Point in longitude-latitude order", async () => {
  const business = sampleBusiness({ latitude: 35.8992, longitude: 14.5141 });
  await business.validate();
  assert.deepEqual(business.toObject().discoveryGeoPoint, {
    type: "Point",
    coordinates: [14.5141, 35.8992],
  });
});

test("Business does not fabricate coordinates for missing location", async () => {
  const business = sampleBusiness({});
  await business.validate();
  assert.equal(business.discoveryGeoPoint, undefined);
});

test("Business removes stale geospatial point when coordinates are cleared through document validation", async () => {
  const business = sampleBusiness({ latitude: 35.8992, longitude: 14.5141 });
  await business.validate();
  business.latitude = null;
  business.longitude = null;
  await business.validate();
  assert.equal(business.discoveryGeoPoint, undefined);
});

test("Business geospatial field has a 2dsphere index", () => {
  assert.ok(Business.schema.indexes().some(([keys]) => keys.discoveryGeoPoint === "2dsphere"));
});
