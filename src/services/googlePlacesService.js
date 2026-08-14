const PLACES_API_BASE_URL = "https://places.googleapis.com/v1"
const AUTOCOMPLETE_FIELD_MASK = [
    "suggestions.placePrediction.placeId",
    "suggestions.placePrediction.text.text",
    "suggestions.placePrediction.structuredFormat.mainText.text",
    "suggestions.placePrediction.structuredFormat.secondaryText.text"
].join(",")
const DETAILS_FIELD_MASK = "id,formattedAddress,location,addressComponents"

export class PlacesServiceError extends Error {
    constructor(message, status = 502) {
        super(message)
        this.name = "PlacesServiceError"
        this.status = status
    }
}

function getApiKey() {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim()
    if (!apiKey) {
        throw new PlacesServiceError("Address search is temporarily unavailable", 503)
    }
    return apiKey
}

function normalizeCountryCode(countryCode) {
    const normalized = typeof countryCode === "string" ? countryCode.trim().toUpperCase() : ""
    if (!/^[A-Z]{2}$/.test(normalized)) {
        throw new PlacesServiceError("A valid country is required for address search", 400)
    }
    return normalized
}

function normalizeSessionToken(sessionToken) {
    const normalized = typeof sessionToken === "string" ? sessionToken.trim() : ""
    if (!/^[A-Za-z0-9_-]{1,36}$/.test(normalized)) {
        throw new PlacesServiceError("A valid address search session is required", 400)
    }
    return normalized
}

async function readGoogleResponse(response) {
    let payload = null
    try {
        payload = await response.json()
    } catch {
        // Google can return a non-JSON gateway response. Keep the client error generic.
    }

    if (!response.ok) {
        console.error("Google Places request failed", {
            status: response.status,
            providerStatus: payload?.error?.status
        })
        throw new PlacesServiceError("Address search is temporarily unavailable")
    }

    return payload ?? {}
}

export async function searchGooglePlaces({ input, countryCode, sessionToken, fetchImpl = fetch }) {
    const normalizedInput = typeof input === "string" ? input.trim().slice(0, 160) : ""
    if (normalizedInput.length < 3) return []

    const normalizedCountryCode = normalizeCountryCode(countryCode)
    const normalizedSessionToken = normalizeSessionToken(sessionToken)
    const response = await fetchImpl(`${PLACES_API_BASE_URL}/places:autocomplete`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": getApiKey(),
            "X-Goog-FieldMask": AUTOCOMPLETE_FIELD_MASK
        },
        body: JSON.stringify({
            input: normalizedInput,
            sessionToken: normalizedSessionToken,
            includedRegionCodes: [normalizedCountryCode.toLowerCase()],
            regionCode: normalizedCountryCode.toLowerCase(),
            includeQueryPredictions: false
        })
    })
    const payload = await readGoogleResponse(response)

    return (payload.suggestions ?? [])
        .map(({ placePrediction }) => placePrediction && ({
            placeId: placePrediction.placeId,
            text: placePrediction.text?.text,
            mainText: placePrediction.structuredFormat?.mainText?.text,
            secondaryText: placePrediction.structuredFormat?.secondaryText?.text
        }))
        .filter((prediction) => prediction?.placeId && prediction?.text)
        .slice(0, 5)
}

export async function resolveGooglePlace({ placeId, countryCode, sessionToken, fetchImpl = fetch }) {
    const normalizedPlaceId = typeof placeId === "string" ? placeId.trim() : ""
    if (!/^[A-Za-z0-9_-]{10,256}$/.test(normalizedPlaceId)) {
        throw new PlacesServiceError("Select a valid address from the suggestions", 400)
    }

    const normalizedCountryCode = normalizeCountryCode(countryCode)
    const normalizedSessionToken = normalizeSessionToken(sessionToken)
    const query = new URLSearchParams({
        sessionToken: normalizedSessionToken,
        languageCode: "en"
    })
    const response = await fetchImpl(
        `${PLACES_API_BASE_URL}/places/${encodeURIComponent(normalizedPlaceId)}?${query}`,
        {
            headers: {
                "X-Goog-Api-Key": getApiKey(),
                "X-Goog-FieldMask": DETAILS_FIELD_MASK
            }
        }
    )
    const place = await readGoogleResponse(response)
    const placeCountryCode = place.addressComponents
        ?.find((component) => component.types?.includes("country"))
        ?.shortText
        ?.toUpperCase()

    if (placeCountryCode !== normalizedCountryCode) {
        throw new PlacesServiceError("Select an address in the chosen country", 400)
    }

    const latitude = Number(place.location?.latitude)
    const longitude = Number(place.location?.longitude)
    if (!place.formattedAddress || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new PlacesServiceError("The selected address could not be validated", 400)
    }

    return {
        address: place.formattedAddress.trim(),
        latitude,
        longitude,
        addressPlaceId: place.id || normalizedPlaceId
    }
}
