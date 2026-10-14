import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import Business from "../src/models/Business.js"
import { updateDiscoveryPublication } from "../src/controllers/propertyProfileController.js"
import {
    getDiscoveryPlace,
    parseDiscoverySearchQuery,
    searchDiscoveryPlaces,
} from "../src/controllers/discoveryController.js"
import {
    buildDiscoveryPlaceDto,
    evaluateDiscoveryPublicationEligibility,
    getDiscoveryPublicationState,
} from "../src/services/discoveryPublicationService.js"

function makeBusiness(overrides = {}) {
    return {
        businessId: "biz_discovery_harbour",
        name: "Harbour Hotel",
        displayName: "Harbour Hotel",
        slug: "harbour-hotel",
        businessType: "hotel",
        status: "active",
        country: "Malta",
        countryCode: "mt",
        address: "1 Marina Road",
        phoneNumber: "+35620000000",
        contactEmail: "private@harbour.example",
        stripeAccountId: "acct_private",
        propertyProfile: {
            discoveryPublished: true,
            publishedAt: new Date("2026-10-12T09:00:00.000Z"),
            accommodationType: "hotel",
            description: "A quiet waterfront hotel.",
            tagline: "Stay by the harbour",
            city: "Sliema",
            region: "Central Region",
            photos: [
                { url: "https://images.example/harbour-cover.webp", publicId: "private/cloudinary-id" },
            ],
            facilityIds: ["free_wifi"],
            accessibility: ["wheelchair_access"],
            languages: ["en", "mt"],
            websiteUrl: "https://harbour.example",
            socialLinks: { instagram: "harbour", facebook: "harbour" },
            parking: { available: true, cost: "paid", reservation: "required", location: "onsite", access: "private" },
        },
        markModified() {},
        async save() { return this },
        ...overrides,
    }
}

function mockReqRes({ businessId = "biz_discovery_harbour", body = {}, query = {}, params = {} } = {}) {
    const req = {
        session: businessId ? { user: { businessId, role: "owner" } } : {},
        body,
        query,
        params,
    }
    const res = {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this },
        set(headers) { Object.assign(this.headers, headers); return this },
        json(payload) { this.body = payload; return this },
    }
    return { req, res }
}

function queryResult(value, hooks = {}) {
    return {
        select(valueToSelect) { hooks.select?.(valueToSelect); return this },
        sort(sort) { hooks.sort?.(sort); return this },
        skip(skip) { hooks.skip?.(skip); return this },
        limit(limit) { hooks.limit?.(limit); return this },
        async lean() { return value },
    }
}

function installBusinessFindOne(t, business, onFilter = () => {}) {
    const original = Business.findOne
    Business.findOne = filter => {
        onFilter(filter)
        return { async select() { return business } }
    }
    t.after(() => { Business.findOne = original })
}

test("Discovery eligibility is explicit and published records fail closed after suspension", () => {
    const published = makeBusiness()
    assert.deepEqual(evaluateDiscoveryPublicationEligibility(published), { eligible: true, blockers: [] })
    assert.equal(getDiscoveryPublicationState(published).effectivePublic, true)

    published.status = "suspended"
    const state = getDiscoveryPublicationState(published)
    assert.equal(state.discoveryPublished, true)
    assert.equal(state.effectivePublic, false)
    assert.equal(state.eligibility.blockers[0].code, "business_not_active")
})

test("publication action derives the tenant from session and is idempotent", async t => {
    const business = makeBusiness({
        propertyProfile: { ...makeBusiness().propertyProfile, discoveryPublished: false, publishedAt: null },
    })
    let capturedFilter
    let saveCount = 0
    business.save = async function save() { saveCount += 1; return this }
    installBusinessFindOne(t, business, filter => { capturedFilter = filter })

    const first = mockReqRes({
        body: { businessId: "another_tenant", discoveryPublished: true },
    })
    await updateDiscoveryPublication(first.req, first.res)

    assert.equal(first.res.statusCode, 200)
    assert.deepEqual(capturedFilter, { businessId: "biz_discovery_harbour" })
    assert.equal(business.propertyProfile.discoveryPublished, true)
    assert.ok(business.propertyProfile.publishedAt instanceof Date)
    assert.equal(first.res.body.discoveryPublication.effectivePublic, true)
    assert.equal(saveCount, 1)

    const initialPublishedAt = business.propertyProfile.publishedAt
    const retry = mockReqRes({ body: { discoveryPublished: true } })
    await updateDiscoveryPublication(retry.req, retry.res)
    assert.equal(retry.res.statusCode, 200)
    assert.equal(saveCount, 1)
    assert.equal(business.propertyProfile.publishedAt, initialPublishedAt)
})

test("publication refuses incomplete profiles without changing the requested state", async t => {
    const business = makeBusiness({
        propertyProfile: {
            ...makeBusiness().propertyProfile,
            discoveryPublished: false,
            photos: [],
        },
    })
    let saveCount = 0
    business.save = async function save() { saveCount += 1; return this }
    installBusinessFindOne(t, business)
    const { req, res } = mockReqRes({ body: { discoveryPublished: true } })

    await updateDiscoveryPublication(req, res)

    assert.equal(res.statusCode, 422)
    assert.equal(res.body.discoveryPublication.eligibility.eligible, false)
    assert.equal(res.body.discoveryPublication.eligibility.blockers[0].code, "cover_photo_required")
    assert.equal(business.propertyProfile.discoveryPublished, false)
    assert.equal(saveCount, 0)
})

test("publication action rejects missing session and malformed payloads", async () => {
    const unauthorized = mockReqRes({ businessId: null, body: { discoveryPublished: true } })
    await updateDiscoveryPublication(unauthorized.req, unauthorized.res)
    assert.equal(unauthorized.res.statusCode, 401)

    const malformed = mockReqRes({ body: { discoveryPublished: "true" } })
    await updateDiscoveryPublication(malformed.req, malformed.res)
    assert.equal(malformed.res.statusCode, 400)
})

test("Discovery DTO is a whitelist and excludes internal business and media fields", () => {
    const place = buildDiscoveryPlaceDto(makeBusiness())

    assert.equal(place.name, "Harbour Hotel")
    assert.equal(place.paths.storefront, "/b/mt/harbour-hotel")
    assert.equal(place.paths.reservation, "/reserve/mt/harbour-hotel")
    assert.equal(place.contact.phone, "+35620000000")
    assert.equal(place.contact.website, "https://harbour.example")
    assert.equal(place.operatingStatus.status, "unknown")
    assert.equal("contactEmail" in place, false)
    assert.equal("stripeAccountId" in place, false)
    assert.equal(JSON.stringify(place).includes("private/cloudinary-id"), false)
    assert.equal(JSON.stringify(place).includes("private@harbour.example"), false)
    assert.equal(JSON.stringify(place).includes("operatingHours"), false)
})

test("Discovery DTO excludes unpublished businesses before exposing operating status", () => {
    const unpublished = makeBusiness({
        propertyProfile: {
            ...makeBusiness().propertyProfile,
            discoveryPublished: false,
        },
    })

    assert.equal(buildDiscoveryPlaceDto(unpublished), null)
})

test("Discovery search filters active published records and sends no-store headers", async () => {
    const business = makeBusiness()
    let capturedQuery
    let capturedSort
    let capturedSkip
    let capturedLimit
    const businessModel = {
        find(query) {
            capturedQuery = query
            return queryResult([business], {
                sort: value => { capturedSort = value },
                skip: value => { capturedSkip = value },
                limit: value => { capturedLimit = value },
            })
        },
    }
    const { req, res } = mockReqRes({
        query: { countryCode: "MT", city: "Sliema", category: "stay", page: "2", limit: "10" },
    })

    await searchDiscoveryPlaces(req, res, { businessModel })

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers["Cache-Control"], "private, no-store, max-age=0")
    assert.deepEqual(capturedQuery.status, { $in: ["active"] })
    assert.equal(capturedQuery["propertyProfile.discoveryPublished"], true)
    assert.equal(capturedQuery.countryCode, "mt")
    assert.equal(capturedQuery.businessType, "hotel")
    assert.deepEqual(capturedSort, { displayName: 1, _id: 1 })
    assert.equal(capturedSkip, 10)
    assert.equal(capturedLimit, 11)
    assert.equal(res.body.results.length, 1)
    assert.equal(res.body.results[0].id, "biz_discovery_harbour")
    assert.equal(res.body.results[0].operatingStatus.status, "unknown")
})

test("Discovery search query validation bounds pagination and rejects ambiguous values", () => {
    assert.deepEqual(parseDiscoverySearchQuery({}), {
        countryCode: null,
        city: null,
        category: null,
        businessType: null,
        sort: "name_asc",
        page: 1,
        limit: 20,
    })
    assert.throws(() => parseDiscoverySearchQuery({ limit: "51" }), /between 1 and 50/)
    assert.throws(() => parseDiscoverySearchQuery({ countryCode: ["mt", "us"] }), /provided once/)
})

test("Discovery detail resolves only the canonical country and slug pair", async () => {
    let capturedQuery
    const businessModel = {
        findOne(query) {
            capturedQuery = query
            return queryResult(makeBusiness())
        },
    }
    const { req, res } = mockReqRes({ params: { countryCode: "MT", slug: "harbour-hotel" } })

    await getDiscoveryPlace(req, res, { businessModel })

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers["Cache-Control"], "private, no-store, max-age=0")
    assert.equal(capturedQuery.countryCode, "mt")
    assert.equal(capturedQuery.slug, "harbour-hotel")
    assert.deepEqual(capturedQuery.status, { $in: ["active"] })
    assert.equal(res.body.place.slug, "harbour-hotel")
})

test("Discovery routes use a dedicated public surface and protected publication action", async () => {
    const [businessRoutes, publicRoutes] = await Promise.all([
        readFile(new URL("../src/routes/business-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/routes/public-route.js", import.meta.url), "utf8"),
    ])

    assert.match(
        businessRoutes,
        /router\.patch\("\/property-profile\/discovery-publication", requireAuth, requireBusinessIdentityOwner, updateDiscoveryPublication\)/,
    )
    assert.match(publicRoutes, /router\.get\("\/discovery\/search", discoveryLimiter, searchDiscoveryPlaces\)/)
    assert.match(publicRoutes, /router\.get\("\/discovery\/places\/:countryCode\/:slug", discoveryLimiter, getDiscoveryPlace\)/)
})
