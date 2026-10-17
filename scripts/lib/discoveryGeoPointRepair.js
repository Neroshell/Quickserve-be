function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value)
}

export function hasValidCoordinates(business) {
    return isFiniteNumber(business?.latitude)
        && isFiniteNumber(business?.longitude)
        && business.latitude >= -90
        && business.latitude <= 90
        && business.longitude >= -180
        && business.longitude <= 180
}

export function hasValidDiscoveryGeoPoint(value) {
    return Boolean(
        value
        && value.type === "Point"
        && Array.isArray(value.coordinates)
        && value.coordinates.length === 2
        && isFiniteNumber(value.coordinates[0])
        && isFiniteNumber(value.coordinates[1])
        && value.coordinates[0] >= -180
        && value.coordinates[0] <= 180
        && value.coordinates[1] >= -90
        && value.coordinates[1] <= 90,
    )
}

export function expectedDiscoveryGeoPoint(business) {
    if (!hasValidCoordinates(business)) return null
    return {
        type: "Point",
        coordinates: [business.longitude, business.latitude],
    }
}

export function discoveryGeoPointMatchesCoordinates(business) {
    const expected = expectedDiscoveryGeoPoint(business)
    const actual = business?.discoveryGeoPoint
    return Boolean(
        expected
        && hasValidDiscoveryGeoPoint(actual)
        && actual.coordinates[0] === expected.coordinates[0]
        && actual.coordinates[1] === expected.coordinates[1],
    )
}

function hasVerifiedLocationReference(business) {
    return typeof business?.addressPlaceId === "string" && business.addressPlaceId.trim().length > 0
}

/**
 * Classify one raw `businesses` document without changing it. A record is only
 * a repair candidate when its stored coordinates are valid, Google-verified,
 * and its GeoJSON Point is absent or malformed. A valid but mismatched point is
 * deliberately manual-review-only: the repair must never replace a valid point
 * on an assumption about which location is authoritative.
 */
export function classifyDiscoveryGeoPoint(business) {
    const coordinatesValid = hasValidCoordinates(business)
    const pointValid = hasValidDiscoveryGeoPoint(business?.discoveryGeoPoint)
    const pointMatches = discoveryGeoPointMatchesCoordinates(business)
    const expectedPoint = expectedDiscoveryGeoPoint(business)
    const zeroCoordinates = coordinatesValid && business.latitude === 0 && business.longitude === 0

    if (!coordinatesValid) {
        return {
            geoJsonStatus: pointValid ? "coordinates_missing_or_invalid" : "coordinates_and_point_missing_or_invalid",
            action: "manual_review",
            expectedPoint: null,
        }
    }
    if (zeroCoordinates) {
        return { geoJsonStatus: "suspicious_zero_coordinates", action: "manual_review", expectedPoint: null }
    }
    if (pointMatches) {
        return { geoJsonStatus: "valid", action: "none", expectedPoint: null }
    }
    if (pointValid) {
        return { geoJsonStatus: "valid_but_mismatched", action: "manual_review", expectedPoint: null }
    }
    if (!hasVerifiedLocationReference(business)) {
        return { geoJsonStatus: "missing_point_unverified_coordinates", action: "manual_review", expectedPoint: null }
    }
    return {
        geoJsonStatus: "missing_or_malformed_point",
        action: "repair_candidate",
        expectedPoint,
    }
}

/**
 * Protects against a concurrent location change. The update can only match the
 * exact coordinates and GeoJSON value seen during the final revalidation.
 */
export function repairCandidateFilter(business) {
    const geoPointSnapshot = Object.hasOwn(business, "discoveryGeoPoint")
        ? business.discoveryGeoPoint
        : undefined
    return {
        _id: business._id,
        latitude: business.latitude,
        longitude: business.longitude,
        discoveryGeoPoint: geoPointSnapshot === undefined ? { $exists: false } : geoPointSnapshot,
    }
}

/**
 * Aggregation pipeline so the Point is calculated from each document's own
 * current longitude and latitude, never from a shared or hard-coded location.
 */
export const DISCOVERY_GEO_POINT_REPAIR_PIPELINE = [
    {
        $set: {
            discoveryGeoPoint: {
                type: "Point",
                coordinates: ["$longitude", "$latitude"],
            },
        },
    },
]
