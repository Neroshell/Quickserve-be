import assert from "node:assert/strict";
import test from "node:test";
import { getDiscoveryDestinationSuggestions } from "../src/controllers/discoveryDestinationController.js";

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("Discovery autocomplete reuses canonical Google Places credential and cities filter", async t => {
  const originalPlaces = process.env.GOOGLE_PLACES_API_KEY;
  const originalMaps = process.env.GOOGLE_MAPS_API_KEY;
  t.after(() => {
    if (originalPlaces === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = originalPlaces;
    if (originalMaps === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalMaps;
  });
  process.env.GOOGLE_PLACES_API_KEY = "canonical-test-key";
  process.env.GOOGLE_MAPS_API_KEY = "fallback-test-key";
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://places.googleapis.com/v1/places:autocomplete");
    assert.equal(init.headers["X-Goog-Api-Key"], "canonical-test-key");
    assert.deepEqual(JSON.parse(init.body), {
      input: "madrid",
      includedPrimaryTypes: ["(cities)"],
      languageCode: "en",
    });
    return { ok: true, json: async () => ({
      suggestions: [{
        placePrediction: {
          placeId: "ChIJValidMadrid",
          text: { text: "Madrid, Spain" },
          structuredFormat: {
            mainText: { text: "Madrid" }, secondaryText: { text: "Spain" },
          },
        },
      }],
    }) };
  });
  const res = response();
  await getDiscoveryDestinationSuggestions({ query: { input: "madrid" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.suggestions, [{
    placeId: "ChIJValidMadrid", label: "Madrid, Spain", name: "Madrid", subtitle: "Spain",
  }]);
});

test("Discovery autocomplete returns a generic 502 without revealing provider diagnostics", async t => {
  const original = process.env.GOOGLE_PLACES_API_KEY;
  t.after(() => {
    if (original === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = original;
  });
  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false, status: 403,
    json: async () => ({ error: { status: "PERMISSION_DENIED", code: 403, message: "secret provider detail" } }),
  }));
  t.mock.method(console, "error", () => {});
  const res = response();
  await getDiscoveryDestinationSuggestions({ query: { input: "madrid" } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "Destination suggestions are temporarily unavailable.");
  assert.equal(JSON.stringify(res.body).includes("secret provider detail"), false);
});
