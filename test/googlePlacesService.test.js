import assert from "node:assert/strict"
import test from "node:test"

import { PlacesServiceError, resolveGooglePlace, searchGooglePlaces } from "../src/services/googlePlacesService.js"

const originalApiKey = process.env.GOOGLE_PLACES_API_KEY

test.before(() => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key"
})

test.after(() => {
    if (originalApiKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY
    else process.env.GOOGLE_PLACES_API_KEY = originalApiKey
})

test("restricts autocomplete requests to the selected country", async () => {
    let requestBody
    const suggestions = await searchGooglePlaces({
        input: "Valletta",
        countryCode: "mt",
        sessionToken: "12345678-1234-1234-1234-123456789012",
        fetchImpl: async (_url, options) => {
            requestBody = JSON.parse(options.body)
            return new Response(JSON.stringify({
                suggestions: [{
                    placePrediction: {
                        placeId: "ChIJValidPlace123",
                        text: { text: "1 Republic Street, Valletta, Malta" },
                        structuredFormat: {
                            mainText: { text: "1 Republic Street" },
                            secondaryText: { text: "Valletta, Malta" }
                        }
                    }
                }]
            }))
        }
    })

    assert.deepEqual(requestBody.includedRegionCodes, ["mt"])
    assert.equal(suggestions[0].placeId, "ChIJValidPlace123")
})

test("returns the formatted address and coordinates for a place in the selected country", async () => {
    const selectedAddress = await resolveGooglePlace({
        placeId: "ChIJValidPlace123",
        countryCode: "MT",
        sessionToken: "12345678-1234-1234-1234-123456789012",
        fetchImpl: async () => new Response(JSON.stringify({
            id: "ChIJValidPlace123",
            formattedAddress: "1 Republic Street, Valletta, Malta",
            location: { latitude: 35.8992, longitude: 14.5141 },
            addressComponents: [{ shortText: "MT", types: ["country"] }]
        }))
    })

    assert.deepEqual(selectedAddress, {
        address: "1 Republic Street, Valletta, Malta",
        latitude: 35.8992,
        longitude: 14.5141,
        addressPlaceId: "ChIJValidPlace123"
    })
})

test("rejects a selected place outside the onboarding country", async () => {
    await assert.rejects(
        resolveGooglePlace({
            placeId: "ChIJValidPlace123",
            countryCode: "MT",
            sessionToken: "12345678-1234-1234-1234-123456789012",
            fetchImpl: async () => new Response(JSON.stringify({
                id: "ChIJValidPlace123",
                formattedAddress: "1 Main Street, London, UK",
                location: { latitude: 51.5, longitude: -0.12 },
                addressComponents: [{ shortText: "GB", types: ["country"] }]
            }))
        }),
        (error) => error instanceof PlacesServiceError && error.status === 400
    )
})
