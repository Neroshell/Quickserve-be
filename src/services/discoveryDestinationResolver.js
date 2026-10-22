const PLACE_ID_PATTERN = /^[\w-]{5,255}$/
const inFlightDestinationResolutions = new Map()

export class DiscoveryDestinationResolutionError extends Error {
    constructor(message, { code, statusCode }) {
        super(message)
        this.name = "DiscoveryDestinationResolutionError"
        this.code = code
        this.statusCode = statusCode
    }
}

function resolutionError(message, code, statusCode) {
    return new DiscoveryDestinationResolutionError(message, { code, statusCode })
}

function configuredGooglePlacesKey() {
    return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || null
}

function validatePlaceId(placeId) {
    if (typeof placeId !== "string" || !PLACE_ID_PATTERN.test(placeId)) {
        throw resolutionError("Choose a valid destination.", "DISCOVERY_DESTINATION_INVALID", 400)
    }
    return placeId
}

function addressPart(parts, type) {
    return parts.find((item) => Array.isArray(item?.types) && item.types.includes(type)) || null
}

function coordinate(value, { name, min, max }) {
    if (!Number.isFinite(value) || value < min || value > max) {
        throw resolutionError(
            "This destination has unsupported map bounds.",
            "DISCOVERY_DESTINATION_BOUNDS_INVALID",
            422,
        )
    }
    return value
}

/**
 * Converts the Google Places viewport into the closed GeoJSON ring required
 * by MongoDB's 2dsphere-compatible $geoWithin/$geometry query.
 *
 * A single planar Polygon cannot represent an antimeridian-crossing viewport
 * safely, and a longitude rectangle at either pole is degenerate. Reject those
 * place responses instead of broadening the visitor's search.
 */
export function buildDiscoveryViewportPolygon(viewport) {
    const low = viewport?.low
    const high = viewport?.high
    const south = coordinate(low?.latitude, { name: "south latitude", min: -90, max: 90 })
    const west = coordinate(low?.longitude, { name: "west longitude", min: -180, max: 180 })
    const north = coordinate(high?.latitude, { name: "north latitude", min: -90, max: 90 })
    const east = coordinate(high?.longitude, { name: "east longitude", min: -180, max: 180 })

    if (south >= north || south <= -90 || north >= 90) {
        throw resolutionError(
            "This destination has unsupported map bounds.",
            "DISCOVERY_DESTINATION_BOUNDS_DEGENERATE",
            422,
        )
    }
    if (west >= east) {
        throw resolutionError(
            "This destination crosses an unsupported map boundary.",
            "DISCOVERY_DESTINATION_BOUNDS_ANTIMERIDIAN",
            422,
        )
    }

    return {
        type: "Polygon",
        coordinates: [[
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
        ]],
    }
}

function destinationFromPlace(place) {
    const types = Array.isArray(place?.types) ? place.types : []
    const parts = Array.isArray(place?.addressComponents) ? place.addressComponents : []
    const countryCode = addressPart(parts, "country")?.shortText?.toLowerCase()
    if (!/^[a-z]{2}$/.test(countryCode || "")) {
        throw resolutionError(
            "This destination does not have a supported country.",
            "DISCOVERY_DESTINATION_COUNTRY_MISSING",
            422,
        )
    }
    if (types.includes("country")) {
        return { countryCode, city: null, geometry: null }
    }
    if (!types.includes("locality") && !types.includes("postal_town")) {
        throw resolutionError(
            "This destination is not supported for location search.",
            "DISCOVERY_DESTINATION_SCOPE_UNSUPPORTED",
            422,
        )
    }

    const city = addressPart(parts, "locality")?.longText || addressPart(parts, "postal_town")?.longText
    if (typeof city !== "string" || !city.trim() || city.length > 120) {
        throw resolutionError(
            "This destination is not supported for location search.",
            "DISCOVERY_DESTINATION_CITY_MISSING",
            422,
        )
    }

    return {
        countryCode,
        city: city.trim(),
        geometry: buildDiscoveryViewportPolygon(place.viewport),
    }
}

async function resolveDestinationFromGoogle(placeId, { fetchImpl, key }) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4_000)
    try {
        let response
        try {
            response = await fetchImpl(
                `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
                {
                    signal: controller.signal,
                    headers: {
                        "X-Goog-Api-Key": key,
                        "X-Goog-FieldMask": "id,types,addressComponents,viewport",
                    },
                },
            )
        } catch {
            throw resolutionError(
                "Destination search is temporarily unavailable. Please try again shortly.",
                "DISCOVERY_DESTINATION_PROVIDER_UNAVAILABLE",
                503,
            )
        }

        if (!response?.ok) {
            if (response?.status === 400 || response?.status === 404) {
                throw resolutionError(
                    "This destination is no longer available. Please choose another.",
                    "DISCOVERY_DESTINATION_PROVIDER_INVALID",
                    422,
                )
            }
            if (response?.status === 429) {
                throw resolutionError(
                    "Destination search is temporarily unavailable. Please try again shortly.",
                    "DISCOVERY_DESTINATION_PROVIDER_QUOTA",
                    503,
                )
            }
            throw resolutionError(
                "Destination search is temporarily unavailable. Please try again shortly.",
                "DISCOVERY_DESTINATION_PROVIDER_UNAVAILABLE",
                503,
            )
        }

        let place
        try {
            place = await response.json()
        } catch {
            throw resolutionError(
                "Destination search is temporarily unavailable. Please try again shortly.",
                "DISCOVERY_DESTINATION_PROVIDER_MALFORMED",
                503,
            )
        }
        return destinationFromPlace(place)
    } finally {
        clearTimeout(timeout)
    }
}

/**
 * Resolves one selected Google place ID to the canonical public geographic
 * scope. The map holds only concurrent requests and is cleared as soon as the
 * provider request settles, avoiding both duplicate homepage lookups and any
 * durable storage of Google Place data.
 */
export function resolveDiscoveryDestination(placeId, {
    fetchImpl = globalThis.fetch,
    key = configuredGooglePlacesKey(),
} = {}) {
    const normalizedPlaceId = validatePlaceId(placeId)
    if (typeof key !== "string" || !key.trim()) {
        throw resolutionError(
            "Destination search is not configured.",
            "DISCOVERY_DESTINATION_CONFIGURATION",
            503,
        )
    }
    if (typeof fetchImpl !== "function") {
        throw resolutionError(
            "Destination search is temporarily unavailable. Please try again shortly.",
            "DISCOVERY_DESTINATION_PROVIDER_UNAVAILABLE",
            503,
        )
    }

    const existing = inFlightDestinationResolutions.get(normalizedPlaceId)
    if (existing) return existing

    const pending = resolveDestinationFromGoogle(normalizedPlaceId, {
        fetchImpl,
        key: key.trim(),
    }).finally(() => {
        inFlightDestinationResolutions.delete(normalizedPlaceId)
    })
    inFlightDestinationResolutions.set(normalizedPlaceId, pending)
    return pending
}
