import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import bcrypt from "bcrypt"

import Staff from "../src/models/Staff.js"
import Business from "../src/models/Business.js"
import { PERMISSIONS } from "../src/constants/permissions.js"
import {
    MANAGEMENT_ACCESS_AREAS,
    MANAGEMENT_ACCESS_AREA_VALUES,
    getEffectiveManagementAreas,
    normalizeCoOwnerRestrictions,
    resolveManagementAccess,
} from "../src/constants/managementAccess.js"
import {
    requireManagementArea,
    requirePermission,
    requirePermissionForAuthenticatedManager,
    requirePrimaryOwner,
} from "../src/middleware/authMiddleware.js"

// emailService loads local .env during module evaluation. Keep this unit test
// on the in-process realtime fallback instead of opening a real Redis socket.
process.env.REDIS_URL = ""
const { updateCoOwnerAccess } = await import("../src/controllers/teamController.js")
const { loginUser } = await import("../src/controllers/authController.js")

function createResponse() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code
            return this
        },
        json(body) {
            this.body = body
            return this
        },
    }
}

async function runMiddleware(middleware, req) {
    const res = createResponse()
    let nextCalled = false
    await middleware(req, res, () => {
        nextCalled = true
    })
    return { res, nextCalled, req }
}

function coOwnerSession(overrides = {}) {
    return {
        session: {
            user: {
                role: "co_owner",
                businessId: "biz_alpha",
                staffObjectId: "507f1f77bcf86cd799439011",
                staffId: "COW-1000",
                email: "alex@example.com",
                ...overrides,
            },
        },
    }
}

function coOwnerRecord(overrides = {}) {
    return {
        _id: "507f1f77bcf86cd799439011",
        role: "co_owner",
        businessId: "biz_alpha",
        staffId: "COW-1000",
        email: "alex@example.com",
        name: "Alex CoOwner",
        accountStatus: "active",
        coOwnerRestrictions: [],
        ...overrides,
    }
}

function mockCoOwnerLookup(t, getRecord) {
    const filters = []
    t.mock.method(Staff, "findOne", (filter) => {
        filters.push(filter)
        return {
            select() {
                return {
                    lean: async () => getRecord(filter),
                }
            },
        }
    })
    return filters
}

test("an active co-owner can complete the existing staff login flow", async (t) => {
    const staff = {
        ...coOwnerRecord(),
        passwordHash: "stored-password-hash",
        presenceStatus: "offline",
        status: "offline",
        save: async () => {},
    }
    t.mock.method(Business, "findOne", async () => null)
    t.mock.method(Staff, "findOne", async () => staff)
    t.mock.method(bcrypt, "compare", async () => true)

    const req = {
        body: { email: "alex@example.com", password: "Password1" },
        session: {
            regenerate(callback) { callback() },
            save(callback) { callback() },
        },
    }
    const res = createResponse()

    await loginUser(req, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.role, "co_owner")
    assert.equal(req.session.user.role, "co_owner")
    assert.equal(req.session.user.businessId, "biz_alpha")
})

test("co-owner access catalog uses stable high-level areas", () => {
    assert.deepEqual(MANAGEMENT_ACCESS_AREA_VALUES, [
        "dashboard",
        "orders",
        "reservations",
        "transactions",
        "menu",
        "service_points",
        "staff_management",
        "analytics",
        "feedback",
        "crm",
        "ai_analyst",
        "business_settings",
        "branding",
        "payments_billing",
    ])
    assert.deepEqual(normalizeCoOwnerRestrictions(["menu", "menu", "payments_billing"]), [
        "menu",
        "payments_billing",
    ])
    assert.throws(() => normalizeCoOwnerRestrictions(["owner.transfer"]), /Invalid management access area/)
})

test("legacy Co-Owners default to every normal access area", () => {
    assert.deepEqual(
        getEffectiveManagementAreas({ role: "co_owner" }),
        MANAGEMENT_ACCESS_AREA_VALUES,
    )
    assert.equal(resolveManagementAccess(
        { role: "co_owner" },
        { area: MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING },
    ), true)
})

test("Staff schema stores restrictions only for the individual Co-Owner", () => {
    const legacy = new Staff({
        businessId: "biz_alpha",
        staffId: "COW-1000",
        role: "co_owner",
        name: "Alex",
        email: "alex@example.com",
    })
    assert.equal(legacy.validateSync(), undefined)
    assert.deepEqual(legacy.coOwnerRestrictions, [])

    const invalid = new Staff({
        businessId: "biz_alpha",
        staffId: "COW-1001",
        role: "co_owner",
        name: "Sarah",
        email: "sarah@example.com",
        coOwnerRestrictions: ["billing.manage"],
    })
    assert.match(invalid.validateSync()?.message || "", /coOwnerRestrictions/)
})

test("default Co-Owner can use Settings, Menu, uploads, and Payments & Billing guards", async (t) => {
    mockCoOwnerLookup(t, () => coOwnerRecord())
    const guards = [
        requirePermission(PERMISSIONS.SETTINGS_OPERATIONAL_MANAGE),
        requirePermission(PERMISSIONS.MENU_MANAGE),
        requireManagementArea(MANAGEMENT_ACCESS_AREAS.BRANDING),
        requireManagementArea(MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING),
    ]

    for (const guard of guards) {
        const result = await runMiddleware(guard, coOwnerSession())
        assert.equal(result.nextCalled, true)
        assert.equal(result.res.statusCode, 200)
    }
})

test("a revoked Co-Owner area returns 403 without invalidating authentication", async (t) => {
    mockCoOwnerLookup(t, () => coOwnerRecord({
        coOwnerRestrictions: [
            MANAGEMENT_ACCESS_AREAS.BUSINESS_SETTINGS,
            MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING,
        ],
    }))

    const settings = await runMiddleware(
        requirePermission(PERMISSIONS.SETTINGS_OPERATIONAL_MANAGE),
        coOwnerSession(),
    )
    const billing = await runMiddleware(
        requireManagementArea(MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING),
        coOwnerSession(),
    )
    const menu = await runMiddleware(
        requirePermission(PERMISSIONS.MENU_MANAGE),
        coOwnerSession(),
    )

    assert.equal(settings.res.statusCode, 403)
    assert.equal(billing.res.statusCode, 403)
    assert.equal(menu.nextCalled, true)
    assert.ok(settings.req.session.user)
    assert.ok(billing.req.session.user)
})

test("public operational routes remain public but enforce an authenticated Co-Owner restriction", async (t) => {
    const publicRequest = await runMiddleware(
        requirePermissionForAuthenticatedManager(PERMISSIONS.MENU_VIEW),
        {},
    )
    assert.equal(publicRequest.nextCalled, true)

    mockCoOwnerLookup(t, () => coOwnerRecord({
        coOwnerRestrictions: [MANAGEMENT_ACCESS_AREAS.MENU],
    }))
    const restricted = await runMiddleware(
        requirePermissionForAuthenticatedManager(PERMISSIONS.MENU_VIEW),
        coOwnerSession(),
    )
    assert.equal(restricted.res.statusCode, 403)
})

test("restrictions are independent across multiple Co-Owners", async (t) => {
    mockCoOwnerLookup(t, (filter) => String(filter._id || "") === "507f1f77bcf86cd799439012"
        ? coOwnerRecord({
            _id: "507f1f77bcf86cd799439012",
            staffId: "COW-2000",
            email: "sarah@example.com",
            coOwnerRestrictions: [MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING],
        })
        : coOwnerRecord())

    const alex = await runMiddleware(
        requireManagementArea(MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING),
        coOwnerSession(),
    )
    const sarah = await runMiddleware(
        requireManagementArea(MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING),
        coOwnerSession({
            staffObjectId: "507f1f77bcf86cd799439012",
            staffId: "COW-2000",
            email: "sarah@example.com",
        }),
    )

    assert.equal(alex.nextCalled, true)
    assert.equal(sarah.res.statusCode, 403)
})

test("Primary Owner cannot be restricted and Co-Owner cannot call primary-owner guards", async () => {
    const owner = await runMiddleware(
        requireManagementArea(MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING),
        { session: { user: { role: "owner", businessId: "biz_alpha" } } },
    )
    const coOwner = await runMiddleware(requirePrimaryOwner, coOwnerSession())
    assert.equal(owner.nextCalled, true)
    assert.equal(coOwner.res.statusCode, 403)
})

test("management authorization preserves 401 versus 403 semantics", async (t) => {
    const unauthenticated = await runMiddleware(
        requireManagementArea(MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING),
        {},
    )
    mockCoOwnerLookup(t, () => coOwnerRecord({
        coOwnerRestrictions: [MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING],
    }))
    const forbidden = await runMiddleware(
        requireManagementArea(MANAGEMENT_ACCESS_AREAS.PAYMENTS_AND_BILLING),
        coOwnerSession(),
    )
    assert.equal(unauthenticated.res.statusCode, 401)
    assert.equal(forbidden.res.statusCode, 403)
})

test("access updates whitelist keys and scope the target by authenticated businessId", async (t) => {
    let updateFilter
    t.mock.method(Staff, "findOneAndUpdate", (filter, update) => {
        updateFilter = filter
        return {
            select: async () => coOwnerRecord({
                coOwnerRestrictions: update.$set.coOwnerRestrictions,
            }),
        }
    })

    const req = {
        ...coOwnerSession(),
        params: { staffId: "COW-1000" },
        body: { coOwnerRestrictions: [MANAGEMENT_ACCESS_AREAS.BUSINESS_SETTINGS] },
    }
    req.session.user.role = "owner"
    const res = createResponse()
    await updateCoOwnerAccess(req, res)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateFilter, {
        businessId: "biz_alpha",
        staffId: "COW-1000",
        role: "co_owner",
    })
    assert.deepEqual(res.body.coOwnerRestrictions, [MANAGEMENT_ACCESS_AREAS.BUSINESS_SETTINGS])
})

test("access API rejects unknown restriction keys before writing", async (t) => {
    let writes = 0
    t.mock.method(Staff, "findOneAndUpdate", () => {
        writes++
        throw new Error("must not write")
    })

    const req = {
        session: { user: { role: "owner", businessId: "biz_alpha" } },
        params: { staffId: "COW-1000" },
        body: { coOwnerRestrictions: ["owner.transfer"] },
    }
    const res = createResponse()
    await updateCoOwnerAccess(req, res)
    assert.equal(res.statusCode, 400)
    assert.equal(writes, 0)
})

test("route declarations preserve the Billing and ownership boundary matrix", async () => {
    const ownerRoutes = await readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8")
    const businessRoutes = await readFile(new URL("../src/routes/business-route.js", import.meta.url), "utf8")
    const menuRoutes = await readFile(new URL("../src/routes/menu-route.js", import.meta.url), "utf8")
    const uploadRoutes = await readFile(new URL("../src/routes/upload-route.js", import.meta.url), "utf8")
    const orderRoutes = await readFile(new URL("../src/routes/order-route.js", import.meta.url), "utf8")
    const scopedOrderRoutes = await readFile(new URL("../src/routes/business-scoped-route.js", import.meta.url), "utf8")

    for (const path of ["/billing", "/billing/commission", "/billing/invoices", "/stripe/status", "/stripe/payout-summary"]) {
        assert.ok(ownerRoutes.includes(`"${path}"`), path)
    }
    for (const path of [
        "/stripe/connect-account",
        "/stripe/dashboard-link",
        "/billing/setup-intent",
        "/billing/verify-payment-method",
        "/billing/payment-method",
        "/billing/plan",
        "/billing/invoices/:id",
        "/billing/platform-fee-settings",
        "/billing/report-usage",
    ]) {
        const declaration = ownerRoutes.slice(ownerRoutes.indexOf(`"${path}"`), ownerRoutes.indexOf(`"${path}"`) + 100)
        assert.match(declaration, /requirePrimaryOwner/, path)
    }
    assert.match(ownerRoutes, /"\/team\/co-owner\/:staffId\/access", requirePrimaryOwner/)
    assert.match(businessRoutes, /MANAGEMENT_ACCESS_AREAS\.BUSINESS_SETTINGS/)
    assert.match(menuRoutes, /requirePermission\(PERMISSIONS\.MENU_MANAGE\)/)
    assert.match(uploadRoutes, /MANAGEMENT_ACCESS_AREAS\.BRANDING/)
    assert.match(orderRoutes, /requireRole\("owner", "co_owner", "admin", "manager"\)/)
    assert.match(scopedOrderRoutes, /requireRole\("owner", "co_owner", "admin", "manager", "waiter"/)
})
