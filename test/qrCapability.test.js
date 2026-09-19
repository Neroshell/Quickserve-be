import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

process.env.REDIS_URL = ""
process.env.BULLMQ_EMAILS_ENABLED = "false"
process.env.QR_CAPABILITY_SIGNING_SECRET = "qr-capability-test-secret-that-is-long-enough"

const [
    capabilityService,
    { startGuestSession },
    servicePointController,
    { default: Business },
    { default: ServicePoint },
    { default: GuestSession },
    { default: CustomerJourney },
] = await Promise.all([
    import("../src/services/servicePointQrCapabilityService.js"),
    import("../src/routes/guest-session-route.js"),
    import("../src/controllers/servicePointController.js"),
    import("../src/models/Business.js"),
    import("../src/models/ServicePoint.js"),
    import("../src/models/GuestSession.js"),
    import("../src/models/CustomerJourney.js"),
])

const {
    createServicePointQrCapability,
    isServicePointQrCapabilityWellFormed,
    servicePointQrCapabilityMatches,
} = capabilityService
const {
    getServicePointQrCapability,
    rotateServicePointQrCapability,
} = servicePointController

const {
    createBusinessFixture,
    createResponse,
    createServicePointFixture,
    mockQuery,
} = await import("./helpers/restaurantFlowFixtures.js")

function capabilityFor({
    businessId = "business-a",
    servicePointId = "sp_table_a",
    version = 1,
} = {}) {
    return createServicePointQrCapability({ businessId, servicePointId, version })
}

function startRequest(overrides = {}) {
    return {
        body: {
            businessId: "business-a",
            servicePointId: "sp_table_a",
            sessionId: "device-a",
            qrCapability: capabilityFor(),
            ...overrides,
        },
        app: { locals: {} },
    }
}

test("QR capabilities are opaque, non-forgeable, and exactly tenant/ServicePoint/version scoped", () => {
    const capability = capabilityFor()
    assert.equal(isServicePointQrCapabilityWellFormed(capability), true)
    assert.match(capability, /^qsp1\.[A-Za-z0-9_-]{43}$/)
    assert.equal(capability.includes("business-a"), false)
    assert.equal(capability.includes("sp_table_a"), false)

    assert.equal(servicePointQrCapabilityMatches(capability, {
        businessId: "business-a",
        servicePointId: "sp_table_a",
        version: 1,
    }), true)
    assert.equal(servicePointQrCapabilityMatches(capability, {
        businessId: "business-a",
        servicePointId: "sp_table_b",
        version: 1,
    }), false)
    assert.equal(servicePointQrCapabilityMatches(capability, {
        businessId: "business-b",
        servicePointId: "sp_table_a",
        version: 1,
    }), false)
    assert.equal(servicePointQrCapabilityMatches(capability, {
        businessId: "business-a",
        servicePointId: "sp_table_a",
        version: 2,
    }), false)
    assert.equal(servicePointQrCapabilityMatches("malformed", {
        businessId: "business-a",
        servicePointId: "sp_table_a",
        version: 1,
    }), false)
    assert.equal(servicePointQrCapabilityMatches(`${capability.slice(0, -1)}x`, {
        businessId: "business-a",
        servicePointId: "sp_table_a",
        version: 1,
    }), false)
    assert.throws(
        () => createServicePointQrCapability({
            businessId: "business-a",
            servicePointId: "sp_table_a",
            version: 1,
        }, { env: {} }),
        { code: "SERVICE_POINT_QR_CAPABILITY_SECRET_MISSING" }
    )
})

test("GuestSession issuance denies public IDs, malformed/cross-scope/revoked capabilities, and inactive or missing points", async (t) => {
    const businesses = new Map([
        ["business-a", createBusinessFixture()],
        ["business-b", createBusinessFixture({ businessId: "business-b" })],
    ])
    const servicePoints = new Map([
        ["business-a:sp_table_a", createServicePointFixture({ qrCapabilityVersion: 1 })],
        ["business-a:sp_table_b", createServicePointFixture({
            servicePointId: "sp_table_b",
            label: "Table 8",
            code: "T8",
            qrCapabilityVersion: 1,
        })],
        ["business-b:sp_table_a", createServicePointFixture({
            businessId: "business-b",
            qrCapabilityVersion: 1,
        })],
    ])
    const created = []

    t.mock.method(Business, "findOne", (filter) =>
        mockQuery(businesses.get(filter.businessId) || null))
    t.mock.method(ServicePoint, "findOne", (filter) =>
        mockQuery(servicePoints.get(`${filter.businessId}:${filter.servicePointId}`) || null))
    t.mock.method(GuestSession, "create", async (fields) => {
        created.push(fields)
        return fields
    })
    t.mock.method(CustomerJourney, "findOne", async () => ({
        journeyId: `jrn_${"a".repeat(32)}`,
        async save() { return this },
    }))

    const deniedRequests = [
        startRequest({ qrCapability: undefined }),
        startRequest({ qrCapability: "malformed" }),
        startRequest({ servicePointId: "sp_table_b" }),
        startRequest({
            businessId: "business-b",
            qrCapability: capabilityFor(),
        }),
        startRequest({
            qrCapability: capabilityFor({ version: 2 }),
        }),
        startRequest({ servicePointId: "sp_missing" }),
    ]

    for (const request of deniedRequests) {
        const response = createResponse()
        await startGuestSession(request, response)
        assert.equal(response.statusCode, 403)
        assert.deepEqual(response.body, {
            error: "This QR code is invalid or no longer active.",
        })
    }

    servicePoints.get("business-a:sp_table_a").isActive = false
    const inactiveResponse = createResponse()
    await startGuestSession(startRequest(), inactiveResponse)
    assert.equal(inactiveResponse.statusCode, 403)
    servicePoints.get("business-a:sp_table_a").isActive = true

    const missingDeviceResponse = createResponse()
    await startGuestSession(startRequest({ sessionId: "" }), missingDeviceResponse)
    assert.equal(missingDeviceResponse.statusCode, 400)
    assert.equal(created.length, 0)
})

test("valid restaurant QR issues an expiring tenant-, ServicePoint-, and device-bound GuestSession", async (t) => {
    const business = createBusinessFixture()
    const servicePoint = createServicePointFixture({ qrCapabilityVersion: 1 })
    let persisted = null
    t.mock.method(Business, "findOne", () => mockQuery(business))
    t.mock.method(ServicePoint, "findOne", () => mockQuery(servicePoint))
    t.mock.method(GuestSession, "create", async (fields) => {
        persisted = fields
        return fields
    })
    t.mock.method(CustomerJourney, "findOne", async () => ({
        journeyId: `jrn_${"b".repeat(32)}`,
        async save() { return this },
    }))

    const before = Date.now()
    const response = createResponse()
    await startGuestSession(startRequest(), response)

    assert.equal(response.statusCode, 200)
    assert.equal(persisted.businessId, "business-a")
    assert.equal(persisted.servicePointId, "sp_table_a")
    assert.equal(persisted.boundSessionId, "device-a")
    assert.equal(persisted.issuanceMethod, "qr_capability")
    assert.equal(persisted.qrCapabilityVersion, 1)
    assert.equal("qrCapability" in persisted, false)
    assert.ok(persisted.expiresAt.getTime() >= before + (119 * 60 * 1000))
    assert.equal(response.body.token, persisted.token)
    assert.equal(response.body.label, "Table 7")
})

test("authorized rotation is tenant-scoped and concurrent rotations leave one canonical generation", async (t) => {
    let storedVersion
    const point = createServicePointFixture()

    t.mock.method(ServicePoint, "findOne", (filter) => {
        if (filter.businessId !== point.businessId || filter.servicePointId !== point.servicePointId) {
            return mockQuery(null)
        }
        return mockQuery({ ...point, qrCapabilityVersion: storedVersion })
    })
    t.mock.method(ServicePoint, "findOneAndUpdate", async (filter, pipeline, options) => {
        if (filter.businessId !== point.businessId || filter.servicePointId !== point.servicePointId) {
            return null
        }
        assert.deepEqual(pipeline[0].$set.qrCapabilityVersion, {
            $add: [{ $ifNull: ["$qrCapabilityVersion", 1] }, 1],
        })
        assert.equal(options.updatePipeline, true)
        storedVersion = (storedVersion ?? 1) + 1
        return { ...point, qrCapabilityVersion: storedVersion }
    })

    const session = { user: { businessId: "business-a" } }
    const currentResponse = createResponse()
    await getServicePointQrCapability({
        session,
        params: { servicePointId: "sp_table_a" },
    }, currentResponse)
    assert.equal(currentResponse.body.version, 1)

    const rotations = [createResponse(), createResponse()]
    await Promise.all(rotations.map((response) =>
        rotateServicePointQrCapability({
            session,
            params: { servicePointId: "sp_table_a" },
        }, response)))

    assert.equal(storedVersion, 3)
    assert.deepEqual(rotations.map((response) => response.body.version).sort(), [2, 3])
    const canonicalMatches = rotations.filter((response) =>
        servicePointQrCapabilityMatches(response.body.capability, {
            businessId: "business-a",
            servicePointId: "sp_table_a",
            version: storedVersion,
        }))
    assert.equal(canonicalMatches.length, 1)
    assert.equal(servicePointQrCapabilityMatches(currentResponse.body.capability, {
        businessId: "business-a",
        servicePointId: "sp_table_a",
        version: storedVersion,
    }), false)

    const crossTenantResponse = createResponse()
    await rotateServicePointQrCapability({
        session: { user: { businessId: "business-b" } },
        params: { servicePointId: "sp_table_a" },
    }, crossTenantResponse)
    assert.equal(crossTenantResponse.statusCode, 404)

    const unauthenticatedResponse = createResponse()
    await rotateServicePointQrCapability({
        session: {},
        params: { servicePointId: "sp_table_a" },
    }, unauthenticatedResponse)
    assert.equal(unauthenticatedResponse.statusCode, 401)
})

test("QR secrets stay out of schemas, public DTOs, logs, legacy issuance, and view-only authorization", async () => {
    assert.equal(ServicePoint.schema.path("qrCapabilityVersion").options.select, false)
    assert.equal(GuestSession.schema.path("qrCapabilityVersion").options.min, 1)
    assert.ok(GuestSession.schema.indexes().some(([fields, options]) =>
        fields.expiresAt === 1 && options.expireAfterSeconds === 0))

    const [publicController, servicePointControllerSource, ownerRoutes, qrRoute] =
        await Promise.all([
            readFile(new URL("../src/controllers/publicController.js", import.meta.url), "utf8"),
            readFile(new URL("../src/controllers/servicePointController.js", import.meta.url), "utf8"),
            readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8"),
            readFile(new URL("../src/routes/qr-route.js", import.meta.url), "utf8"),
        ])

    assert.doesNotMatch(publicController, /PUBLIC_SERVICE_POINT_FIELDS[\s\S]*qrCapability/)
    assert.match(servicePointControllerSource, /delete value\.qrCapabilityVersion/)
    assert.match(ownerRoutes, /qr-capability",\s*requirePermission\(PERMISSIONS\.SERVICE_POINTS_MANAGE\)/)
    assert.match(ownerRoutes, /qr-capability\/rotate",\s*requirePermission\(PERMISSIONS\.SERVICE_POINTS_MANAGE\)/)
    assert.doesNotMatch(qrRoute, /models\/GuestSession|GuestSession\.create|qrCapability\s*[=:]/)
})
