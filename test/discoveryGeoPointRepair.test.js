import assert from "node:assert/strict"
import test from "node:test"

import Business from "../src/models/Business.js"
import {
    classifyDiscoveryGeoPoint,
    DISCOVERY_GEO_POINT_REPAIR_PIPELINE,
    repairCandidateFilter,
} from "../scripts/lib/discoveryGeoPointRepair.js"

function business(overrides = {}) {
    return {
        _id: "business-object-id",
        businessId: "business-id",
        addressPlaceId: "google-place-id",
        latitude: 35.9520048,
        longitude: 14.4178167,
        ...overrides,
    }
}

test("missing GeoJSON with verified valid coordinates is a repair candidate", () => {
    const result = classifyDiscoveryGeoPoint(business())
    assert.deepEqual(result, {
        geoJsonStatus: "missing_or_malformed_point",
        action: "repair_candidate",
        expectedPoint: {
            type: "Point",
            coordinates: [14.4178167, 35.9520048],
        },
    })
})

test("a correct existing Point is never overwritten", () => {
    const result = classifyDiscoveryGeoPoint(business({
        discoveryGeoPoint: { type: "Point", coordinates: [14.4178167, 35.9520048] },
    }))
    assert.deepEqual(result, { geoJsonStatus: "valid", action: "none", expectedPoint: null })
})

test("a valid but inconsistent Point is held for manual review", () => {
    const result = classifyDiscoveryGeoPoint(business({
        discoveryGeoPoint: { type: "Point", coordinates: [14.48, 35.89] },
    }))
    assert.deepEqual(result, {
        geoJsonStatus: "valid_but_mismatched",
        action: "manual_review",
        expectedPoint: null,
    })
})

test("unverified, invalid, and placeholder coordinates are excluded from automatic repair", () => {
    assert.equal(
        classifyDiscoveryGeoPoint(business({ addressPlaceId: "" })).action,
        "manual_review",
    )
    assert.equal(
        classifyDiscoveryGeoPoint(business({ latitude: null, longitude: null })).action,
        "manual_review",
    )
    const zeroCoordinates = business({
        latitude: 0,
        longitude: 0,
        discoveryGeoPoint: { type: "Point", coordinates: [0, 0] },
    })
    assert.equal(classifyDiscoveryGeoPoint(zeroCoordinates).action, "manual_review")
})

test("repair update is fenced to the exact coordinates and old Point snapshot", () => {
    const source = business({ discoveryGeoPoint: null })
    assert.deepEqual(repairCandidateFilter(source), {
        _id: "business-object-id",
        latitude: 35.9520048,
        longitude: 14.4178167,
        discoveryGeoPoint: null,
    })
    assert.deepEqual(DISCOVERY_GEO_POINT_REPAIR_PIPELINE, [{
        $set: {
            discoveryGeoPoint: {
                type: "Point",
                coordinates: ["$longitude", "$latitude"],
            },
        },
    }])
})

test("the canonical Business document hook keeps coordinates and GeoJSON together", async () => {
    const record = new Business({
        businessId: "geo-point-hook-test",
        name: "Geo Point Hook Test",
        displayName: "Geo Point Hook Test",
        slug: "geo-point-hook-test",
        businessType: "restaurant",
        modules: ["foodService"],
        latitude: 35.9520048,
        longitude: 14.4178167,
    })

    await record.validate()
    assert.deepEqual(record.discoveryGeoPoint.toObject(), {
        type: "Point",
        coordinates: [14.4178167, 35.9520048],
    })

    record.latitude = null
    record.longitude = null
    await record.validate()
    assert.equal(record.discoveryGeoPoint, undefined)
})
