import assert from "node:assert/strict"
import test from "node:test"

import Business from "../src/models/Business.js"
import MenuItem from "../src/models/menuItem.js"
import Order from "../src/models/order.js"
import Plan from "../src/models/Plan.js"
import ServicePoint from "../src/models/ServicePoint.js"
import Staff from "../src/models/Staff.js"
import {
    dismissSetupGuide,
    getSetupProgress,
} from "../src/controllers/setupProgressController.js"
import {
    getMenuItems,
    toggleMenuItemAvailability,
} from "../src/controllers/menuController.js"
import { getPublicBusinessConfig } from "../src/controllers/publicController.js"
import { updateOperatingHours } from "../src/controllers/businessController.js"
import {
    getBillingActionPeriodKey,
    processBillingLifecycleAction,
} from "../src/services/billingLifecycleService.js"
import { BILLING_JOB_NAMES } from "../src/queues/queueNames.js"
import {
    cacheKeys,
    createResponseCache,
    responseCache,
} from "../src/services/responseCacheService.js"

class MemoryRedis {
    constructor({ ready = true } = {}) {
        this.isReady = ready
        this.values = new Map()
        this.calls = { get: 0, set: 0, del: 0 }
    }

    async get(key) {
        this.calls.get += 1
        return this.values.has(key) ? this.values.get(key) : null
    }

    async set(key, value) {
        this.calls.set += 1
        this.values.set(key, value)
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

function selectableLean(valueFactory) {
    return {
        select() { return this },
        async lean() { return valueFactory() },
    }
}

function completeRestaurantBusiness(overrides = {}) {
    return {
        businessId: "biz_alpha",
        businessType: "restaurant",
        modules: ["foodService"],
        stripeOnboardingComplete: true,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
        defaultPaymentMethodId: "pm_test",
        setupProgress: { setupGuideDismissed: false },
        ...overrides,
    }
}

test("setup progress miss/hit avoids six DB reads, stays authorized, invalidates, and repopulates fresh", async t => {
    const client = new MemoryRedis()
    const restoreCache = installCache(client)
    t.after(restoreCache)

    const originals = {
        businessFindOne: Business.findOne,
        businessUpdateOne: Business.updateOne,
        menuCount: MenuItem.countDocuments,
        orderCount: Order.countDocuments,
        servicePointCount: ServicePoint.countDocuments,
        staffCount: Staff.countDocuments,
    }
    t.after(() => {
        Business.findOne = originals.businessFindOne
        Business.updateOne = originals.businessUpdateOne
        MenuItem.countDocuments = originals.menuCount
        Order.countDocuments = originals.orderCount
        ServicePoint.countDocuments = originals.servicePointCount
        Staff.countDocuments = originals.staffCount
    })

    const business = completeRestaurantBusiness()
    let databaseReads = 0
    Business.findOne = filter => {
        assert.deepEqual(filter, { businessId: "biz_alpha" })
        return selectableLean(() => {
            databaseReads += 1
            return structuredClone(business)
        })
    }
    const count = async filter => {
        assert.equal(filter.businessId, "biz_alpha")
        databaseReads += 1
        return 1
    }
    MenuItem.countDocuments = count
    Order.countDocuments = count
    ServicePoint.countDocuments = count
    Staff.countDocuments = count
    Business.updateOne = async (filter, update) => {
        assert.deepEqual(filter, { businessId: "biz_alpha" })
        assert.equal(update.$set["setupProgress.setupGuideDismissed"], true)
        business.setupProgress.setupGuideDismissed = true
        return { matchedCount: 1, modifiedCount: 1 }
    }

    const first = mockReqRes({ user: { businessId: "biz_alpha", role: "owner" } })
    await getSetupProgress(first.req, first.res)
    assert.equal(first.res.statusCode, 200)
    assert.equal(databaseReads, 6)
    const missPayload = structuredClone(first.res.body)

    const second = mockReqRes({ user: { businessId: "biz_alpha", role: "owner" } })
    await getSetupProgress(second.req, second.res)
    assert.deepEqual(second.res.body, missPayload)
    assert.equal(databaseReads, 6, "cache hit must avoid every setup-progress query")

    const cacheGetsBeforeUnauthorized = client.calls.get
    const unauthorized = mockReqRes()
    await getSetupProgress(unauthorized.req, unauthorized.res)
    assert.equal(unauthorized.res.statusCode, 401)
    assert.equal(client.calls.get, cacheGetsBeforeUnauthorized, "authorization must run before cache lookup")

    const dismiss = mockReqRes({ user: { businessId: "biz_alpha", role: "owner" } })
    await dismissSetupGuide(dismiss.req, dismiss.res)
    assert.equal(dismiss.res.statusCode, 200)
    assert.equal(dismiss.res.body.setupProgress.dismissed, true)
    assert.equal(client.values.has(cacheKeys.setupProgress("biz_alpha")), false)

    const fresh = mockReqRes({ user: { businessId: "biz_alpha", role: "owner" } })
    await getSetupProgress(fresh.req, fresh.res)
    assert.equal(fresh.res.body.dismissed, true)
    assert.equal(databaseReads, 24, "dismiss plus the next miss must use fresh MongoDB state")

    const finalHit = mockReqRes({ user: { businessId: "biz_alpha", role: "owner" } })
    await getSetupProgress(finalHit.req, finalHit.res)
    assert.deepEqual(finalHit.res.body, fresh.res.body)
    assert.equal(databaseReads, 24, "final fresh cache hit must avoid every setup-progress query")
})

test("public config caches only the safe DTO, isolates tenants, and refreshes after settings writes", async t => {
    const client = new MemoryRedis()
    const restoreCache = installCache(client)
    t.after(restoreCache)

    const originals = {
        businessFindOne: Business.findOne,
        businessFindOneAndUpdate: Business.findOneAndUpdate,
        planFindOne: Plan.findOne,
    }
    t.after(() => {
        Business.findOne = originals.businessFindOne
        Business.findOneAndUpdate = originals.businessFindOneAndUpdate
        Plan.findOne = originals.planFindOne
    })

    const businesses = new Map([
        ["biz_alpha", {
            businessId: "biz_alpha",
            restaurantId: "legacy-alpha",
            status: "active",
            currentPlan: "growth",
            name: "Alpha",
            displayName: "Alpha Dining",
            slug: "alpha",
            logoUrl: "https://images.example/alpha.png",
            phoneNumber: "+100000000",
            address: "1 Main Street",
            country: "Malta",
            currency: "eur",
            timezone: "Europe/Malta",
            language: "en",
            businessType: "restaurant",
            taxRate: 18,
            passPlatformFeeToCustomer: false,
            platformFeeMode: "business_absorbs",
            customerPlatformFeePercent: 0,
            platformFeeLabel: "Service fee",
            billingStatus: "active",
            defaultPaymentMethodId: "pm_private",
            offlineServiceRestricted: false,
            stripeSecret: "must-never-leak",
            ownerEmail: "owner-private@example.com",
            operatingHours: { Monday: { enabled: true, openTime: "09:00", closeTime: "17:00" } },
            orderingPreferences: { dineInEnabled: true },
            paymentPreferences: { acceptCash: true },
            settings: { tipsEnabled: true },
            menuCategories: ["mains"],
            branding: { primaryColor: "#112233", removeQuickServeBranding: true },
        }],
        ["biz_beta", {
            businessId: "biz_beta",
            status: "active",
            currentPlan: "basic",
            name: "Beta",
            displayName: "Beta Hotel",
            slug: "beta",
            businessType: "hotel",
            billingStatus: "incomplete",
            operatingHours: {},
        }],
    ])

    let businessReads = 0
    let planReads = 0
    Business.findOne = filter => ({
        async lean() {
            businessReads += 1
            const requested = filter.$or[0].businessId
            const business = businesses.get(requested) ||
                [...businesses.values()].find(candidate => candidate.restaurantId === requested)
            return business ? structuredClone(business) : null
        },
    })
    Plan.findOne = filter => ({
        async lean() {
            planReads += 1
            return { slug: filter.slug, offlineCommissionRate: filter.slug === "growth" ? 1.5 : 2.5 }
        },
    })
    Business.findOneAndUpdate = (filter, update) => ({
        async select() {
            const business = businesses.get(filter.businessId)
            business.operatingHours = structuredClone(update.$set.operatingHours)
            return structuredClone(business)
        },
    })

    const first = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getPublicBusinessConfig(first.req, first.res)
    assert.equal(first.res.statusCode, 200)
    assert.equal(businessReads, 1)
    assert.equal(planReads, 1)
    assert.equal(first.res.body.platformFeeRate, 1.5)
    assert.equal(first.res.body.offlinePaymentsAvailable, true)
    for (const privateField of ["ownerEmail", "defaultPaymentMethodId", "stripeSecret", "billingStatus"]) {
        assert.equal(privateField in first.res.body, false, `${privateField} must not enter the public cache`)
    }
    const missPayload = structuredClone(first.res.body)

    const second = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getPublicBusinessConfig(second.req, second.res)
    assert.deepEqual(second.res.body, missPayload)
    assert.equal(businessReads, 1)
    assert.equal(planReads, 1)

    const newHours = { Monday: { enabled: true, openTime: "10:00", closeTime: "20:00" } }
    const update = mockReqRes({
        user: { businessId: "biz_alpha", role: "owner" },
        body: { operatingHours: newHours },
    })
    await updateOperatingHours(update.req, update.res)
    assert.equal(update.res.statusCode, 200)
    assert.equal(client.values.has(cacheKeys.publicBusinessConfig("biz_alpha")), false)

    const fresh = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getPublicBusinessConfig(fresh.req, fresh.res)
    assert.deepEqual(fresh.res.body.operatingHours, newHours)
    assert.equal(businessReads, 2)
    assert.equal(planReads, 2)

    const finalHit = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getPublicBusinessConfig(finalHit.req, finalHit.res)
    assert.deepEqual(finalHit.res.body, fresh.res.body)
    assert.equal(businessReads, 2, "final fresh cache hit must avoid Business.findOne")
    assert.equal(planReads, 2, "final fresh cache hit must avoid Plan.findOne")

    const beta = mockReqRes({ query: { businessId: "biz_beta" } })
    await getPublicBusinessConfig(beta.req, beta.res)
    assert.equal(beta.res.body.businessId, "biz_beta")
    assert.notDeepEqual(beta.res.body, fresh.res.body)
    assert.equal(client.values.has(cacheKeys.publicBusinessConfig("biz_alpha")), true)
    assert.equal(client.values.has(cacheKeys.publicBusinessConfig("biz_beta")), true)

    const readsBeforeLegacy = businessReads
    const legacyOne = mockReqRes({ query: { restaurantId: "legacy-alpha" } })
    const legacyTwo = mockReqRes({ query: { restaurantId: "legacy-alpha" } })
    await getPublicBusinessConfig(legacyOne.req, legacyOne.res)
    await getPublicBusinessConfig(legacyTwo.req, legacyTwo.res)
    assert.equal(businessReads, readsBeforeLegacy + 2, "legacy aliases must bypass cache lookup")
    assert.deepEqual(legacyOne.res.body, legacyTwo.res.body)

    const missingId = mockReqRes()
    await getPublicBusinessConfig(missingId.req, missingId.res)
    assert.equal(missingId.res.statusCode, 400)
})

test("menu cache separates public and owner views, avoids DB reads, and refreshes both variants after mutation", async t => {
    const client = new MemoryRedis()
    const restoreCache = installCache(client)
    t.after(restoreCache)

    const originals = {
        find: MenuItem.find,
        findOneAndUpdate: MenuItem.findOneAndUpdate,
    }
    t.after(() => {
        MenuItem.find = originals.find
        MenuItem.findOneAndUpdate = originals.findOneAndUpdate
    })

    const itemsByBusiness = new Map([
        ["biz_alpha", [
            { _id: "item_a1", businessId: "biz_alpha", name: "Soup", isAvailable: true, createdAt: 2 },
            { _id: "item_a2", businessId: "biz_alpha", name: "Hidden special", isAvailable: false, createdAt: 1 },
        ]],
        ["biz_beta", [
            { _id: "item_b1", businessId: "biz_beta", name: "Beta breakfast", isAvailable: true, createdAt: 1 },
        ]],
    ])

    let menuReads = 0
    const filters = []
    MenuItem.find = filter => {
        filters.push(structuredClone(filter))
        return {
            async sort() {
                menuReads += 1
                const items = itemsByBusiness.get(filter.businessId) || []
                return structuredClone(
                    filter.isAvailable === true
                        ? items.filter(item => item.isAvailable === true)
                        : items
                )
            },
        }
    }
    MenuItem.findOneAndUpdate = async (filter, update) => {
        assert.equal(filter.businessId, "biz_alpha", "session tenant must override request tenant")
        const item = itemsByBusiness.get(filter.businessId)
            .find(candidate => candidate._id === filter._id)
        if (!item) return null
        Object.assign(item, update.$set)
        return structuredClone(item)
    }

    const publicMiss = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getMenuItems(publicMiss.req, publicMiss.res)
    assert.deepEqual(publicMiss.res.body.map(item => item.name), ["Soup"])
    assert.equal(menuReads, 1)
    const publicMissPayload = structuredClone(publicMiss.res.body)

    const ownerMiss = mockReqRes({
        user: { businessId: "biz_alpha", role: "owner" },
        query: { businessId: "biz_beta" },
    })
    await getMenuItems(ownerMiss.req, ownerMiss.res)
    assert.deepEqual(ownerMiss.res.body.map(item => item.name), ["Soup", "Hidden special"])
    assert.equal(menuReads, 2)
    assert.deepEqual(filters[0], { businessId: "biz_alpha", isAvailable: true })
    assert.deepEqual(filters[1], { businessId: "biz_alpha" })

    const publicHit = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getMenuItems(publicHit.req, publicHit.res)
    assert.deepEqual(publicHit.res.body, publicMissPayload)
    assert.equal(menuReads, 2, "public cache hit must avoid MenuItem.find")

    const toggle = mockReqRes({
        user: { businessId: "biz_alpha", role: "manager" },
        query: { businessId: "biz_beta" },
        params: { id: "item_a2" },
        body: { businessId: "biz_beta", isAvailable: true },
    })
    await toggleMenuItemAvailability(toggle.req, toggle.res)
    assert.equal(toggle.res.statusCode, 200)
    assert.equal(client.values.has(cacheKeys.menuItems("biz_alpha")), false)
    assert.equal(client.values.has(cacheKeys.menuItems("biz_alpha", { owner: true })), false)

    const publicFresh = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getMenuItems(publicFresh.req, publicFresh.res)
    assert.deepEqual(publicFresh.res.body.map(item => item.name), ["Soup", "Hidden special"])
    assert.equal(menuReads, 3)

    const publicFinalHit = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getMenuItems(publicFinalHit.req, publicFinalHit.res)
    assert.deepEqual(publicFinalHit.res.body, publicFresh.res.body)
    assert.equal(menuReads, 3, "final fresh public cache hit must avoid MenuItem.find")

    const beta = mockReqRes({ query: { businessId: "biz_beta" } })
    await getMenuItems(beta.req, beta.res)
    assert.deepEqual(beta.res.body.map(item => item.name), ["Beta breakfast"])
    assert.equal(menuReads, 4)
    assert.equal(client.values.has(cacheKeys.menuItems("biz_alpha")), true)
    assert.equal(client.values.has(cacheKeys.menuItems("biz_beta")), true)
})

test("all three endpoints and a mutation fall back to MongoDB when Redis is unavailable", async t => {
    const client = new MemoryRedis({ ready: false })
    const restoreCache = installCache(client)
    t.after(restoreCache)

    const originals = {
        businessFindOne: Business.findOne,
        menuFind: MenuItem.find,
        menuFindOneAndUpdate: MenuItem.findOneAndUpdate,
        menuCount: MenuItem.countDocuments,
        orderCount: Order.countDocuments,
        planFindOne: Plan.findOne,
        servicePointCount: ServicePoint.countDocuments,
        staffCount: Staff.countDocuments,
    }
    t.after(() => {
        Business.findOne = originals.businessFindOne
        MenuItem.find = originals.menuFind
        MenuItem.findOneAndUpdate = originals.menuFindOneAndUpdate
        MenuItem.countDocuments = originals.menuCount
        Order.countDocuments = originals.orderCount
        Plan.findOne = originals.planFindOne
        ServicePoint.countDocuments = originals.servicePointCount
        Staff.countDocuments = originals.staffCount
    })

    let databaseReads = 0
    Business.findOne = filter => ({
        select() { return this },
        async lean() {
            databaseReads += 1
            if (filter.$or) {
                return {
                    businessId: "biz_alpha",
                    status: "active",
                    currentPlan: "basic",
                    name: "Alpha",
                    businessType: "restaurant",
                    operatingHours: {},
                }
            }
            return completeRestaurantBusiness({
                stripeOnboardingComplete: false,
                stripeChargesEnabled: false,
                stripePayoutsEnabled: false,
                defaultPaymentMethodId: null,
            })
        },
    })
    Plan.findOne = () => ({
        async lean() {
            databaseReads += 1
            return { slug: "basic", offlineCommissionRate: 2.5 }
        },
    })
    const count = async () => {
        databaseReads += 1
        return 0
    }
    MenuItem.countDocuments = count
    Order.countDocuments = count
    ServicePoint.countDocuments = count
    Staff.countDocuments = count
    MenuItem.find = filter => ({
        async sort() {
            databaseReads += 1
            return [{ _id: "item_a1", businessId: filter.businessId, name: "Soup", isAvailable: true }]
        },
    })
    MenuItem.findOneAndUpdate = async filter => ({
        _id: filter._id,
        businessId: filter.businessId,
        name: "Soup",
        isAvailable: true,
    })

    const setup = mockReqRes({ user: { businessId: "biz_alpha", role: "owner" } })
    const publicConfig = mockReqRes({ query: { businessId: "biz_alpha" } })
    const menu = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getSetupProgress(setup.req, setup.res)
    await getPublicBusinessConfig(publicConfig.req, publicConfig.res)
    await getMenuItems(menu.req, menu.res)

    assert.equal(setup.res.statusCode, 200)
    assert.equal(publicConfig.res.statusCode, 200)
    assert.equal(menu.res.statusCode, 200)
    assert.ok(databaseReads >= 9, "MongoDB loaders must still run while Redis is down")

    client.isReady = true
    client.get = async () => { throw Object.assign(new Error("get down"), { code: "ECONNREFUSED" }) }
    client.set = async () => { throw Object.assign(new Error("set down"), { code: "ECONNREFUSED" }) }
    client.del = async () => { throw Object.assign(new Error("del down"), { code: "ECONNREFUSED" }) }

    const setupAfterErrors = mockReqRes({ user: { businessId: "biz_alpha", role: "owner" } })
    const publicAfterErrors = mockReqRes({ query: { businessId: "biz_alpha" } })
    const menuAfterErrors = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getSetupProgress(setupAfterErrors.req, setupAfterErrors.res)
    await getPublicBusinessConfig(publicAfterErrors.req, publicAfterErrors.res)
    await getMenuItems(menuAfterErrors.req, menuAfterErrors.res)
    assert.equal(setupAfterErrors.res.statusCode, 200)
    assert.equal(publicAfterErrors.res.statusCode, 200)
    assert.equal(menuAfterErrors.res.statusCode, 200)
    assert.ok(databaseReads >= 18, "GET/SET failures must still execute MongoDB loaders")

    const mutation = mockReqRes({
        user: { businessId: "biz_alpha", role: "manager" },
        params: { id: "item_a1" },
        body: { isAvailable: true },
    })
    await toggleMenuItemAvailability(mutation.req, mutation.res)
    assert.equal(mutation.res.statusCode, 200, "DEL failure must not fail a successful write")
})

test("background billing restoration invalidates public config and repopulates fresh state", async t => {
    const client = new MemoryRedis()
    const restoreCache = installCache(client)
    t.after(restoreCache)

    const originals = { businessFindOne: Business.findOne, planFindOne: Plan.findOne }
    t.after(() => {
        Business.findOne = originals.businessFindOne
        Plan.findOne = originals.planFindOne
    })

    const restrictedAt = new Date("2026-08-11T12:00:00.000Z")
    const business = {
        businessId: "biz_alpha",
        status: "active",
        currentPlan: "basic",
        name: "Alpha",
        businessType: "restaurant",
        billingStatus: "active",
        defaultPaymentMethodId: "pm_private",
        offlineServiceRestricted: true,
        offlineServiceRestrictedAt: restrictedAt,
        stripeSubscriptionId: "sub_alpha",
        billingLifecycleClaims: { restoreService: {} },
    }
    let businessReads = 0
    let planReads = 0
    Business.findOne = () => ({
        async lean() {
            businessReads += 1
            return structuredClone(business)
        },
    })
    Plan.findOne = () => ({
        async lean() {
            planReads += 1
            return { slug: "basic", offlineCommissionRate: 2.5 }
        },
    })

    function setPath(target, path, value) {
        const parts = path.split(".")
        const last = parts.pop()
        let current = target
        for (const part of parts) current = current[part] ||= {}
        current[last] = value
    }
    function applySet(update) {
        for (const [path, value] of Object.entries(update.$set || {})) {
            setPath(business, path, value)
        }
    }
    const businessModel = {
        findOne() {
            return { lean: async () => structuredClone(business) }
        },
        findOneAndUpdate(filter, update) {
            applySet(update)
            return { lean: async () => structuredClone(business) }
        },
        async updateOne(filter, update) {
            applySet(update)
            return { matchedCount: 1, modifiedCount: 1 }
        },
    }

    const first = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getPublicBusinessConfig(first.req, first.res)
    assert.equal(first.res.body.offlinePaymentsAvailable, false)

    const cached = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getPublicBusinessConfig(cached.req, cached.res)
    assert.equal(cached.res.body.offlinePaymentsAvailable, false)
    assert.equal(businessReads, 1)
    assert.equal(planReads, 1)

    const jobName = BILLING_JOB_NAMES.RESTORE_SERVICE
    const periodKey = getBillingActionPeriodKey(jobName, business)
    const result = await processBillingLifecycleAction({
        jobName,
        businessId: business.businessId,
        periodKey,
        businessModel,
        sendNotification: async () => assert.fail("business has no notification recipient"),
    })
    assert.equal(result.success, true)
    assert.equal(business.offlineServiceRestricted, false)
    assert.equal(client.values.has(cacheKeys.publicBusinessConfig("biz_alpha")), false)

    const fresh = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getPublicBusinessConfig(fresh.req, fresh.res)
    assert.equal(fresh.res.body.offlinePaymentsAvailable, true)
    assert.equal(businessReads, 2)
    assert.equal(planReads, 2)

    const finalHit = mockReqRes({ query: { businessId: "biz_alpha" } })
    await getPublicBusinessConfig(finalHit.req, finalHit.res)
    assert.equal(finalHit.res.body.businessId, fresh.res.body.businessId)
    assert.equal(
        finalHit.res.body.offlinePaymentsAvailable,
        fresh.res.body.offlinePaymentsAvailable,
    )
    assert.equal(businessReads, 2)
    assert.equal(planReads, 2)
})
