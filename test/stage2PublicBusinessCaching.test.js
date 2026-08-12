import assert from "node:assert/strict"
import test from "node:test"

import Business from "../src/models/Business.js"
import ServicePoint from "../src/models/ServicePoint.js"
import { getBusinessBySlug } from "../src/controllers/publicController.js"
import {
    updateSettings,
} from "../src/controllers/businessController.js"
import {
    updateServicePoint,
} from "../src/controllers/servicePointController.js"
import {
    cacheKeys,
    createResponseCache,
    responseCache,
} from "../src/services/responseCacheService.js"

class MemoryRedis {
    constructor() {
        this.isReady = true
        this.values = new Map()
        this.ttls = new Map()
        this.calls = { get: 0, set: 0, del: 0 }
    }

    async get(key) {
        this.calls.get += 1
        return this.values.has(key) ? this.values.get(key) : null
    }

    async set(key, value, options) {
        this.calls.set += 1
        this.values.set(key, value)
        this.ttls.set(key, options?.EX)
        return "OK"
    }

    async del(keys) {
        this.calls.del += 1
        let deleted = 0
        for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (this.values.delete(key)) deleted += 1
        }
        return deleted
    }
}

const CACHE_METHODS = ["get", "set", "del", "delMany"]

function installCache(client) {
    const implementation = createResponseCache({
        client,
        logger: { debug() {}, warn() {} },
        commandTimeoutMs: 20,
    })
    const originals = Object.fromEntries(
        CACHE_METHODS.map(method => [method, responseCache[method]])
    )
    for (const method of CACHE_METHODS) {
        responseCache[method] = implementation[method].bind(implementation)
    }
    return () => {
        for (const method of CACHE_METHODS) responseCache[method] = originals[method]
    }
}

function mockReqRes({ user, body = {}, params = {}, query = {} } = {}) {
    const req = {
        session: user ? { user } : {},
        body,
        params,
        query,
    }
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code
            return this
        },
        json(payload) {
            this.body = payload
            return this
        },
    }
    return { req, res }
}

function queryFor(value) {
    const resolve = () => structuredClone(value)
    const query = {
        select() { return query },
        async lean() { return resolve() },
        then(onFulfilled, onRejected) {
            return Promise.resolve(resolve()).then(onFulfilled, onRejected)
        },
    }
    return query
}

function makeBusiness(overrides = {}) {
    return {
        businessId: "biz_alpha",
        slug: "alpha-hotel",
        name: "Alpha Hotel",
        displayName: "Alpha Hotel & Spa",
        address: "1 Harbour Street",
        phoneNumber: "+35620000000",
        country: "Malta",
        countryCode: "mt",
        currency: "EUR",
        timezone: "Europe/Malta",
        logoUrl: "https://images.example/alpha-logo.webp",
        branding: {
            enabled: true,
            coverImageUrl: "https://images.example/alpha-cover.webp",
            primaryColor: "#112233",
        },
        operatingHours: {
            Monday: { enabled: true, openTime: "08:00", closeTime: "22:00" },
        },
        settings: { reservationsEnabled: true, tipsEnabled: true },
        hotelSettings: { checkInTime: "15:00", checkOutTime: "11:00" },
        businessType: "hotel",
        modules: ["lodging", "foodService"],
        status: "active",
        ownerEmail: "private-owner@example.com",
        defaultPaymentMethodId: "pm_private",
        stripeAccountId: "acct_private",
        ...overrides,
    }
}

function makeServicePoint(overrides = {}) {
    return {
        _id: "sp_object_alpha",
        servicePointId: "sp_alpha",
        label: "Harbour Suite",
        servicePointType: "room",
        roomType: "Suite",
        capacity: 4,
        pricePerNight: 28900,
        fullDescription: "A quiet suite overlooking the harbour.",
        amenities: ["Wi-Fi", "Air conditioning", "Breakfast"],
        images: ["https://images.example/suite-1.webp"],
        beds: 2,
        bedType: "King",
        bedConfiguration: [{ bedType: "King", count: 1 }, { bedType: "Sofa bed", count: 1 }],
        viewType: "Harbour",
        maxGuests: 4,
        code: "PRIVATE-DOOR-CODE",
        businessId: "biz_alpha",
        ...overrides,
    }
}

function installPublicRepositories({ businesses, servicePoints, counters, onUpdate } = {}) {
    Business.findOne = filter => {
        if (filter.slug && filter.countryCode) {
            return {
                async lean() {
                    counters.businessReads += 1
                    const business = businesses.find(candidate =>
                        candidate.slug === filter.slug && candidate.countryCode === filter.countryCode
                    )
                    return business ? structuredClone(business) : null
                },
            }
        }

        const business = businesses.find(candidate => candidate.businessId === filter.businessId)
        return queryFor(business || null)
    }

    ServicePoint.find = filter => ({
        select(projection) {
            const selected = new Set(projection.split(/\s+/).filter(Boolean))
            return {
                async lean() {
                    counters.servicePointReads += 1
                    return servicePoints
                        .filter(servicePoint =>
                            servicePoint.businessId === filter.businessId &&
                            servicePoint.isActive !== false &&
                            servicePoint.reservable !== false
                        )
                        .map(servicePoint => Object.fromEntries(
                            Object.entries(servicePoint).filter(([field]) =>
                                field === "_id" || selected.has(field)
                            )
                        ))
                },
            }
        },
    })

    ServicePoint.findOneAndUpdate = async (filter, update) => {
        const servicePoint = servicePoints.find(candidate =>
            candidate.servicePointId === filter.servicePointId &&
            candidate.businessId === filter.businessId
        )
        if (!servicePoint) return null
        Object.assign(servicePoint, update.$set)
        onUpdate?.({ filter, update })
        return structuredClone(servicePoint)
    }
}

test("public business MISS/HIT avoids both MongoDB reads and refreshes after a tenant-scoped ServicePoint mutation", async t => {
    const client = new MemoryRedis()
    const restoreCache = installCache(client)
    t.after(restoreCache)

    const originals = {
        businessFindOne: Business.findOne,
        servicePointFind: ServicePoint.find,
        servicePointFindOneAndUpdate: ServicePoint.findOneAndUpdate,
    }
    t.after(() => {
        Business.findOne = originals.businessFindOne
        ServicePoint.find = originals.servicePointFind
        ServicePoint.findOneAndUpdate = originals.servicePointFindOneAndUpdate
    })

    const businesses = [makeBusiness()]
    const servicePoints = [makeServicePoint()]
    const counters = { businessReads: 0, servicePointReads: 0 }
    let mutationFilter
    installPublicRepositories({
        businesses,
        servicePoints,
        counters,
        onUpdate: ({ filter }) => { mutationFilter = structuredClone(filter) },
    })

    const first = mockReqRes({ params: { countryCode: "MT", slug: "Alpha-Hotel" } })
    await getBusinessBySlug(first.req, first.res)
    assert.equal(first.res.statusCode, 200)
    assert.equal(counters.businessReads, 1)
    assert.equal(counters.servicePointReads, 1)
    assert.equal(first.res.body.servicePoints[0].label, "Harbour Suite")
    for (const privateField of ["ownerEmail", "defaultPaymentMethodId", "stripeAccountId", "status", "countryCode"]) {
        assert.equal(privateField in first.res.body, false, `${privateField} must not enter the cached DTO`)
    }
    for (const privateField of ["code", "businessId"]) {
        assert.equal(privateField in first.res.body.servicePoints[0], false, `${privateField} must not enter a cached ServicePoint`)
    }

    const key = cacheKeys.publicBusiness("mt", "alpha-hotel")
    assert.equal(key, "quickserve:v1:public-business:mt:alpha-hotel")
    assert.equal(client.ttls.get(key), 600)
    const missPayload = JSON.parse(JSON.stringify(first.res.body))

    const second = mockReqRes({ params: { countryCode: "mt", slug: "alpha-hotel" } })
    await getBusinessBySlug(second.req, second.res)
    assert.deepEqual(second.res.body, missPayload)
    assert.equal(counters.businessReads, 1)
    assert.equal(counters.servicePointReads, 1)

    const mutation = mockReqRes({
        user: { businessId: "biz_alpha", role: "manager" },
        params: { servicePointId: "sp_alpha" },
        body: { businessId: "biz_other", label: "Fresh Harbour Suite" },
    })
    await updateServicePoint(mutation.req, mutation.res)
    assert.equal(mutation.res.statusCode, 200)
    assert.deepEqual(mutationFilter, { servicePointId: "sp_alpha", businessId: "biz_alpha" })
    assert.equal(client.values.has(key), false)

    const fresh = mockReqRes({ params: { countryCode: "mt", slug: "alpha-hotel" } })
    await getBusinessBySlug(fresh.req, fresh.res)
    assert.equal(fresh.res.body.servicePoints[0].label, "Fresh Harbour Suite")
    assert.equal(counters.businessReads, 2)
    assert.equal(counters.servicePointReads, 2)

    const finalHit = mockReqRes({ params: { countryCode: "MT", slug: "ALPHA-HOTEL" } })
    await getBusinessBySlug(finalHit.req, finalHit.res)
    assert.deepEqual(finalHit.res.body, fresh.res.body)
    assert.equal(counters.businessReads, 2)
    assert.equal(counters.servicePointReads, 2)
})

test("public business cache isolates equal slugs by country and rejects unsafe cached shapes", async t => {
    const client = new MemoryRedis()
    const restoreCache = installCache(client)
    t.after(restoreCache)

    const originals = { businessFindOne: Business.findOne, servicePointFind: ServicePoint.find }
    t.after(() => {
        Business.findOne = originals.businessFindOne
        ServicePoint.find = originals.servicePointFind
    })

    const businesses = [
        makeBusiness({ businessId: "biz_mt", slug: "central", countryCode: "mt", displayName: "Central Malta" }),
        makeBusiness({ businessId: "biz_de", slug: "central", country: "Germany", countryCode: "de", displayName: "Central Berlin" }),
    ]
    const servicePoints = [
        makeServicePoint({ businessId: "biz_mt", servicePointId: "sp_mt", label: "Malta Suite" }),
        makeServicePoint({ businessId: "biz_de", servicePointId: "sp_de", label: "Berlin Suite" }),
    ]
    const counters = { businessReads: 0, servicePointReads: 0 }
    installPublicRepositories({ businesses, servicePoints, counters })

    const unsafeKey = cacheKeys.publicBusiness("mt", "central")
    client.values.set(unsafeKey, JSON.stringify({
        ...makeBusiness({ businessId: "biz_mt", slug: "central" }),
        servicePoints: [],
        ownerEmail: "must-not-be-served@example.com",
    }))

    const malta = mockReqRes({ params: { countryCode: " MT ", slug: " CENTRAL " } })
    await getBusinessBySlug(malta.req, malta.res)
    assert.equal(malta.res.body.displayName, "Central Malta")
    assert.equal("ownerEmail" in malta.res.body, false)
    assert.equal(counters.businessReads, 1, "unsafe cache entry must be treated as a miss")

    const germany = mockReqRes({ params: { countryCode: "de", slug: "central" } })
    await getBusinessBySlug(germany.req, germany.res)
    assert.equal(germany.res.body.displayName, "Central Berlin")
    assert.equal(counters.businessReads, 2)
    assert.notEqual(
        cacheKeys.publicBusiness("mt", "central"),
        cacheKeys.publicBusiness("de", "central"),
    )

    const maltaHit = mockReqRes({ params: { countryCode: "mt", slug: "central" } })
    const germanyHit = mockReqRes({ params: { countryCode: "DE", slug: "CENTRAL" } })
    await getBusinessBySlug(maltaHit.req, maltaHit.res)
    await getBusinessBySlug(germanyHit.req, germanyHit.res)
    assert.equal(maltaHit.res.body.businessId, "biz_mt")
    assert.equal(germanyHit.res.body.businessId, "biz_de")
    assert.equal(counters.businessReads, 2)
    assert.equal(counters.servicePointReads, 2)
})

test("slug and country mutation invalidates both old and new country-scoped keys", async t => {
    const client = new MemoryRedis()
    const restoreCache = installCache(client)
    t.after(restoreCache)

    const originals = { businessFindOne: Business.findOne, businessFindOneAndUpdate: Business.findOneAndUpdate }
    t.after(() => {
        Business.findOne = originals.businessFindOne
        Business.findOneAndUpdate = originals.businessFindOneAndUpdate
    })

    const business = makeBusiness({ businessType: "restaurant", modules: ["foodService"] })
    Business.findOne = filter => {
        if (filter.slug && filter.businessId?.$ne) return queryFor(null)
        return queryFor(business)
    }
    Business.findOneAndUpdate = (filter, update) => ({
        async select() {
            assert.deepEqual(filter, { businessId: "biz_alpha" })
            Object.assign(business, update.$set)
            return structuredClone(business)
        },
    })

    const oldKey = cacheKeys.publicBusiness("mt", "alpha-hotel")
    const newKey = cacheKeys.publicBusiness("de", "alpha-renamed")
    client.values.set(oldKey, JSON.stringify({ stale: "old" }))
    client.values.set(newKey, JSON.stringify({ stale: "new" }))

    const mutation = mockReqRes({
        user: { businessId: "biz_alpha", role: "owner" },
        body: { slug: "alpha-renamed", country: "Germany" },
    })
    await updateSettings(mutation.req, mutation.res)
    assert.equal(mutation.res.statusCode, 200)
    assert.equal(business.slug, "alpha-renamed")
    assert.equal(business.countryCode, "de")
    assert.equal(client.values.has(oldKey), false)
    assert.equal(client.values.has(newKey), false)
})

test("public business reads and invalidation fail open for Redis GET, SET, and DEL errors", async t => {
    const client = new MemoryRedis()
    client.get = async () => { throw Object.assign(new Error("get unavailable"), { code: "ECONNREFUSED" }) }
    client.set = async () => { throw Object.assign(new Error("set unavailable"), { code: "ECONNREFUSED" }) }
    client.del = async () => { throw Object.assign(new Error("del unavailable"), { code: "ECONNREFUSED" }) }
    const restoreCache = installCache(client)
    t.after(restoreCache)

    const originals = {
        businessFindOne: Business.findOne,
        servicePointFind: ServicePoint.find,
        servicePointFindOneAndUpdate: ServicePoint.findOneAndUpdate,
    }
    t.after(() => {
        Business.findOne = originals.businessFindOne
        ServicePoint.find = originals.servicePointFind
        ServicePoint.findOneAndUpdate = originals.servicePointFindOneAndUpdate
    })

    const businesses = [makeBusiness()]
    const servicePoints = [makeServicePoint()]
    const counters = { businessReads: 0, servicePointReads: 0 }
    installPublicRepositories({ businesses, servicePoints, counters })

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const read = mockReqRes({ params: { countryCode: "mt", slug: "alpha-hotel" } })
        await getBusinessBySlug(read.req, read.res)
        assert.equal(read.res.statusCode, 200)
    }
    assert.equal(counters.businessReads, 2)
    assert.equal(counters.servicePointReads, 2)

    const mutation = mockReqRes({
        user: { businessId: "biz_alpha", role: "owner" },
        params: { servicePointId: "sp_alpha" },
        body: { label: "Available despite Redis failure" },
    })
    await updateServicePoint(mutation.req, mutation.res)
    assert.equal(mutation.res.statusCode, 200, "DEL failure must not fail the MongoDB mutation")
    assert.equal(servicePoints[0].label, "Available despite Redis failure")
})

test("representative public-business payload sizes stay bounded", () => {
    const typical = {
        ...makeBusiness({ status: undefined, countryCode: undefined }),
        servicePoints: [makeServicePoint(), makeServicePoint({ _id: "sp_object_beta", servicePointId: "sp_beta" })],
    }
    for (const field of ["ownerEmail", "defaultPaymentMethodId", "stripeAccountId", "status", "countryCode"]) {
        delete typical[field]
    }
    typical.servicePoints.forEach(servicePoint => {
        delete servicePoint.code
        delete servicePoint.businessId
    })

    const largestPractical = {
        ...typical,
        servicePoints: Array.from({ length: 60 }, (_, index) => ({
            ...typical.servicePoints[0],
            _id: `sp_object_${index}`,
            servicePointId: `sp_${index}`,
            label: `Guest room ${index + 1}`,
            fullDescription: "A fully described room with guest-facing details. ".repeat(12),
            amenities: Array.from({ length: 20 }, (__, amenityIndex) => `Amenity ${amenityIndex + 1}`),
            images: Array.from({ length: 8 }, (__, imageIndex) =>
                `https://images.example/rooms/${index + 1}/image-${imageIndex + 1}.webp`
            ),
        })),
    }

    const typicalBytes = Buffer.byteLength(JSON.stringify(typical))
    const largestPracticalBytes = Buffer.byteLength(JSON.stringify(largestPractical))
    assert.ok(typicalBytes > 0)
    assert.ok(largestPracticalBytes > typicalBytes)
    assert.ok(largestPracticalBytes < 256 * 1024)
    process.stdout.write(`# Stage 2 payload bytes: typical=${typicalBytes} largest-practical=${largestPracticalBytes}\n`)
})
