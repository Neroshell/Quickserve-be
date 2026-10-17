import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"

import Business from "../src/models/Business.js"
import { searchDiscoveryPlaces } from "../src/controllers/discoveryController.js"

const mongoUri = process.env.INVENTORY_TEST_MONGODB_URI
const ST_PAULS_BAY_GEOMETRY = {
    type: "Polygon",
    coordinates: [[[14.4, 35.93], [14.44, 35.93], [14.44, 35.97], [14.4, 35.97], [14.4, 35.93]]],
}

function responseRecorder() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this },
        set(headers) { Object.assign(this.headers, headers); return this },
        json(payload) { this.body = payload; return this },
    }
}

function publishedBusiness({
    businessId,
    businessType,
    latitude,
    longitude,
    city,
    countryCode = "mt",
    country = "Malta",
    status = "active",
    discoveryPublished = true,
}) {
    return {
        businessId,
        name: businessId,
        displayName: businessId,
        slug: businessId,
        businessType,
        modules: businessType === "hotel" ? ["lodging"] : ["foodService"],
        status,
        country,
        countryCode,
        address: `${businessId} address`,
        addressPlaceId: `place_${businessId}`,
        latitude,
        longitude,
        propertyProfile: {
            city,
            discoveryPublished,
            photos: [{
                url: `https://images.example/${businessId}.webp`,
                publicId: `public_${businessId}`,
            }],
        },
    }
}

async function selectedDestinationSearch(query) {
    const res = responseRecorder()
    await searchDiscoveryPlaces({ query }, res, {
        businessModel: Business,
        resolveDestination: async () => ({
            countryCode: "mt",
            city: "St. Paul's Bay",
            geometry: ST_PAULS_BAY_GEOMETRY,
        }),
    })
    return res
}

function ids(response) {
    return response.body.results.map((item) => item.id)
}

test("Discovery destination searches use real 2dsphere geometry and preserve publication, category, and country boundaries", {
    skip: mongoUri ? false : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async () => {
    await mongoose.connect(mongoUri, { dbName: `quickserve_discovery_geo_${Date.now()}` })
    try {
        await Business.syncIndexes()
        await Business.create([
            publishedBusiness({
                businessId: "st-pauls-bay-hotel",
                businessType: "hotel",
                latitude: 35.95,
                longitude: 14.42,
                city: "St. Paul's Bay",
            }),
            publishedBusiness({
                businessId: "msida-hotel",
                businessType: "hotel",
                latitude: 35.892,
                longitude: 14.482,
                city: "Msida",
            }),
            publishedBusiness({
                businessId: "st-pauls-bay-restaurant",
                businessType: "restaurant",
                latitude: 35.951,
                longitude: 14.421,
                city: "St. Paul's Bay",
            }),
            publishedBusiness({
                businessId: "st-pauls-bay-bar",
                businessType: "bar_lounge",
                latitude: 35.952,
                longitude: 14.422,
                city: "St. Paul's Bay",
            }),
            publishedBusiness({
                businessId: "unpublished-st-pauls-hotel",
                businessType: "hotel",
                latitude: 35.953,
                longitude: 14.423,
                city: "St. Paul's Bay",
                discoveryPublished: false,
            }),
            publishedBusiness({
                businessId: "suspended-st-pauls-hotel",
                businessType: "hotel",
                latitude: 35.954,
                longitude: 14.424,
                city: "St. Paul's Bay",
                status: "suspended",
            }),
            publishedBusiness({
                businessId: "foreign-st-pauls-hotel",
                businessType: "hotel",
                latitude: 35.955,
                longitude: 14.425,
                city: "St. Paul's Bay",
                countryCode: "es",
                country: "Spain",
            }),
            publishedBusiness({
                businessId: "london-hotel",
                businessType: "hotel",
                latitude: 51.5072,
                longitude: -0.1276,
                city: "London",
                countryCode: "gb",
                country: "United Kingdom",
            }),
            publishedBusiness({
                businessId: "missing-point-hotel",
                businessType: "hotel",
                latitude: null,
                longitude: null,
                city: "St. Paul's Bay",
            }),
        ])

        const storedInsideHotel = await Business.findOne({ businessId: "st-pauls-bay-hotel" })
            .select("discoveryGeoPoint")
            .lean()
        assert.deepEqual(storedInsideHotel.discoveryGeoPoint, {
            type: "Point",
            coordinates: [14.42, 35.95],
        })

        const stay = await selectedDestinationSearch({ placeId: "ChIJStPaulsBay", category: "stay" })
        assert.equal(stay.statusCode, 200)
        assert.deepEqual(ids(stay), ["st-pauls-bay-hotel"])

        const eat = await selectedDestinationSearch({ placeId: "ChIJStPaulsBay", category: "eat" })
        assert.deepEqual(ids(eat), ["st-pauls-bay-restaurant"])

        const drink = await selectedDestinationSearch({ placeId: "ChIJStPaulsBay", category: "drink" })
        assert.deepEqual(ids(drink), ["st-pauls-bay-bar"])

        const countryBrowse = responseRecorder()
        await searchDiscoveryPlaces({ query: { countryCode: "mt", category: "stay" } }, countryBrowse, {
            businessModel: Business,
        })
        assert.equal(countryBrowse.statusCode, 200)
        assert.deepEqual(ids(countryBrowse), ["msida-hotel", "st-pauls-bay-hotel"])

        const countryExplain = await Business.find({
            countryCode: "mt",
            businessType: "hotel",
            status: "active",
            "propertyProfile.discoveryPublished": true,
        }).sort({ displayName: 1, _id: 1 }).explain("executionStats")
        // The raw query includes one legacy record without a GeoJSON point;
        // the public DTO excludes it, as verified by countryBrowse above.
        assert.equal(countryExplain.executionStats.nReturned, 3)
        assert.match(JSON.stringify(countryExplain.queryPlanner.winningPlan), /countryCode_1/)

        const spanishCountryBrowse = responseRecorder()
        await searchDiscoveryPlaces({ query: { countryCode: "es", category: "stay" } }, spanishCountryBrowse, {
            businessModel: Business,
        })
        assert.equal(spanishCountryBrowse.statusCode, 200)
        assert.deepEqual(ids(spanishCountryBrowse), ["foreign-st-pauls-hotel"])

        const ukCountryBrowse = responseRecorder()
        await searchDiscoveryPlaces({ query: { countryCode: "gb", category: "stay" } }, ukCountryBrowse, {
            businessModel: Business,
        })
        assert.equal(ukCountryBrowse.statusCode, 200)
        assert.deepEqual(ids(ukCountryBrowse), ["london-hotel"])

        const nearby = responseRecorder()
        await searchDiscoveryPlaces({
            query: { category: "stay", countryCode: "mt", latitude: "35.95", longitude: "14.42", radiusKm: "3" },
        }, nearby, { businessModel: Business })
        assert.equal(nearby.statusCode, 200)
        assert.deepEqual(ids(nearby), ["st-pauls-bay-hotel"])

        const unsupportedLocationParameter = responseRecorder()
        await searchDiscoveryPlaces({
            query: { category: "stay", placeI: "ChIJStPaulsBay" },
        }, unsupportedLocationParameter, {
            businessModel: Business,
            resolveDestination: async () => {
                throw new Error("Unsupported placeI must not resolve a destination")
            },
        })
        assert.equal(unsupportedLocationParameter.statusCode, 400)
        assert.equal(
            unsupportedLocationParameter.body.error,
            "Unsupported Discovery search parameter: placeI",
        )

        const concurrent = await Promise.all(Array.from(
            { length: 6 },
            () => selectedDestinationSearch({ placeId: "ChIJStPaulsBay", category: "stay" }),
        ))
        concurrent.forEach((response) => assert.deepEqual(ids(response), ["st-pauls-bay-hotel"]))

        const explain = await Business.find({
            countryCode: "mt",
            businessType: "hotel",
            status: "active",
            "propertyProfile.discoveryPublished": true,
            discoveryGeoPoint: { $geoWithin: { $geometry: ST_PAULS_BAY_GEOMETRY } },
        }).explain("executionStats")
        assert.match(JSON.stringify(explain), /discoveryGeoPoint_2dsphere/)
    } finally {
        await mongoose.connection.dropDatabase()
        await mongoose.disconnect()
    }
})
