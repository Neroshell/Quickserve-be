import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import Staff from "../src/models/Staff.js"
import Business from "../src/models/Business.js"
import {
    normalizePermissions,
    PERMISSIONS,
    PERMISSION_VALUES,
} from "../src/constants/permissions.js"
import {
    requirePermission,
    requirePermissionForAuthenticatedManager,
    requireManagementArea,
    requirePrimaryOwner,
} from "../src/middleware/authMiddleware.js"
import { MANAGEMENT_ACCESS_AREAS } from "../src/constants/managementAccess.js"
import { requireEntitlement } from "../src/middleware/subscriptionMiddleware.js"
import {
    broadcastLocal,
    publishManagerAccessRevocation,
    sseHandler,
} from "../src/utils/sseManager.js"

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

function managerSession(overrides = {}) {
    return {
        session: {
            user: {
                role: "manager",
                businessId: "biz_alpha",
                staffObjectId: "507f1f77bcf86cd799439011",
                staffId: "MGR-1000",
                email: "manager@example.com",
                ...overrides,
            },
        },
    }
}

function managerRecord(overrides = {}) {
    return {
        _id: "507f1f77bcf86cd799439011",
        role: "manager",
        businessId: "biz_alpha",
        staffId: "MGR-1000",
        accountStatus: "active",
        permissions: [],
        ...overrides,
    }
}

function mockManagerLookup(t, getRecord) {
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

test("permission catalog contains only the approved Manager permissions", () => {
    assert.deepEqual(PERMISSION_VALUES, [
        "dashboard.view",
        "orders.view",
        "orders.manage",
        "transactions.view",
        "reservations.view",
        "reservations.manage",
        "menu.view",
        "menu.manage",
        "servicePoints.view",
        "servicePoints.manage",
        "staff.view",
        "staff.manage",
        "analytics.view",
        "feedback.view",
        "crm.view",
        "aiAnalyst.view",
        "settings.operational.manage",
    ])
    assert.ok(!PERMISSION_VALUES.some((key) => /billing|stripe|subscription|owner|module/i.test(key)))
})

test("manage permissions normalize their view dependencies", () => {
    assert.deepEqual(
        normalizePermissions([
            PERMISSIONS.ORDERS_MANAGE,
            PERMISSIONS.RESERVATIONS_MANAGE,
            PERMISSIONS.MENU_MANAGE,
            PERMISSIONS.SERVICE_POINTS_MANAGE,
            PERMISSIONS.STAFF_MANAGE,
        ]),
        [
            PERMISSIONS.ORDERS_VIEW,
            PERMISSIONS.ORDERS_MANAGE,
            PERMISSIONS.RESERVATIONS_VIEW,
            PERMISSIONS.RESERVATIONS_MANAGE,
            PERMISSIONS.MENU_VIEW,
            PERMISSIONS.MENU_MANAGE,
            PERMISSIONS.SERVICE_POINTS_VIEW,
            PERMISSIONS.SERVICE_POINTS_MANAGE,
            PERMISSIONS.STAFF_VIEW,
            PERMISSIONS.STAFF_MANAGE,
        ],
    )
    assert.throws(() => normalizePermissions(["billing.manage"]), /Invalid permission/)
})

test("Staff schema accepts existing non-Managers and rejects unknown permission keys", () => {
    const waiter = new Staff({
        businessId: "biz_alpha",
        staffId: "WTR-1000",
        role: "waiter",
        name: "Waiter",
        email: "waiter@example.com",
    })
    assert.equal(waiter.validateSync(), undefined)
    assert.deepEqual(waiter.permissions, [])

    const invalidManager = new Staff({
        businessId: "biz_alpha",
        staffId: "MGR-1000",
        role: "manager",
        name: "Manager",
        email: "manager@example.com",
        permissions: ["stripe.manage"],
    })
    assert.match(invalidManager.validateSync()?.message || "", /permissions/)
})

test("unauthenticated permission request returns 401", async () => {
    const { res, nextCalled } = await runMiddleware(
        requirePermission(PERMISSIONS.ORDERS_VIEW),
        {},
    )
    assert.equal(nextCalled, false)
    assert.equal(res.statusCode, 401)
})

test("Manager without permission is denied", async (t) => {
    mockManagerLookup(t, () => managerRecord())
    const { res, nextCalled } = await runMiddleware(
        requirePermission(PERMISSIONS.ORDERS_VIEW),
        managerSession(),
    )
    assert.equal(nextCalled, false)
    assert.equal(res.statusCode, 403)
})

test("Manager with view permission can read but cannot mutate", async (t) => {
    mockManagerLookup(t, () => managerRecord({ permissions: [PERMISSIONS.ORDERS_VIEW] }))

    const read = await runMiddleware(requirePermission(PERMISSIONS.ORDERS_VIEW), managerSession())
    const mutation = await runMiddleware(requirePermission(PERMISSIONS.ORDERS_MANAGE), managerSession())

    assert.equal(read.nextCalled, true)
    assert.equal(mutation.nextCalled, false)
    assert.equal(mutation.res.statusCode, 403)
})

test("Manager with manage permission can pass the corresponding mutation guard", async (t) => {
    mockManagerLookup(t, () => managerRecord({
        permissions: normalizePermissions([PERMISSIONS.ORDERS_MANAGE]),
    }))
    const { nextCalled, res } = await runMiddleware(
        requirePermission(PERMISSIONS.ORDERS_MANAGE),
        managerSession(),
    )
    assert.equal(nextCalled, true)
    assert.equal(res.statusCode, 200)
})

test("disabled and cross-tenant Manager records are denied", async (t) => {
    let record = managerRecord({ accountStatus: "disabled", permissions: [PERMISSIONS.MENU_VIEW] })
    mockManagerLookup(t, () => record)

    const disabled = await runMiddleware(requirePermission(PERMISSIONS.MENU_VIEW), managerSession())
    assert.equal(disabled.res.statusCode, 403)

    record = managerRecord({ businessId: "biz_other", permissions: [PERMISSIONS.MENU_VIEW] })
    const crossTenant = await runMiddleware(requirePermission(PERMISSIONS.MENU_VIEW), managerSession())
    assert.equal(crossTenant.res.statusCode, 403)
})

test("Manager lookup is scoped by the authenticated session businessId", async (t) => {
    const filters = mockManagerLookup(t, () => managerRecord({ permissions: [PERMISSIONS.CRM_VIEW] }))
    const result = await runMiddleware(requirePermission(PERMISSIONS.CRM_VIEW), managerSession())
    assert.equal(result.nextCalled, true)
    assert.equal(filters.length, 1)
    assert.equal(filters[0].businessId, "biz_alpha")
    assert.equal(filters[0]._id, "507f1f77bcf86cd799439011")
})

test("permission removal takes effect on the next request with the same session", async (t) => {
    let permissions = [PERMISSIONS.MENU_VIEW]
    mockManagerLookup(t, () => managerRecord({ permissions }))
    const session = managerSession().session

    const beforeRemoval = await runMiddleware(requirePermission(PERMISSIONS.MENU_VIEW), { session })
    permissions = []
    const afterRemoval = await runMiddleware(requirePermission(PERMISSIONS.MENU_VIEW), { session })

    assert.equal(beforeRemoval.nextCalled, true)
    assert.equal(afterRemoval.nextCalled, false)
    assert.equal(afterRemoval.res.statusCode, 403)
})

test("Manager access revocation disconnects an active SSE stream", async (t) => {
    mockManagerLookup(t, () => managerRecord({ permissions: [PERMISSIONS.ORDERS_VIEW] }))

    let closeHandler = null
    const req = {
        ...managerSession(),
        query: {
            role: "owner",
            businessId: "biz_alpha",
            permission: PERMISSIONS.ORDERS_VIEW,
        },
        on(event, handler) {
            if (event === "close") closeHandler = handler
        },
    }
    const res = {
        ended: false,
        setHeader() {},
        flushHeaders() {},
        write() {},
        end() {
            this.ended = true
        },
        status() {
            return this
        },
    }

    await sseHandler(req, res)
    assert.equal(res.ended, false)

    await publishManagerAccessRevocation({
        businessId: "biz_alpha",
        staffObjectId: "507f1f77bcf86cd799439011",
        staffId: "MGR-1000",
    })
    assert.equal(res.ended, true)
    closeHandler?.()
})

test("Manager SSE delivery fails closed after permission removal or account disable", async (t) => {
    let record = managerRecord({ permissions: [PERMISSIONS.ORDERS_VIEW] })
    mockManagerLookup(t, () => record?.accountStatus === "active" ? record : null)

    let closeHandler = null
    const writes = []
    const req = {
        ...managerSession(),
        query: {
            role: "owner",
            businessId: "biz_alpha",
            permission: PERMISSIONS.ORDERS_VIEW,
        },
        on(event, handler) {
            if (event === "close") closeHandler = handler
        },
    }
    const res = {
        ended: false,
        setHeader() {},
        flushHeaders() {},
        write(data) {
            writes.push(data)
        },
        end() {
            this.ended = true
        },
        status() {
            return this
        },
    }

    await sseHandler(req, res)
    const writesBeforeRevocation = writes.length
    record = managerRecord({
        accountStatus: "disabled",
        permissions: [PERMISSIONS.ORDERS_VIEW],
    })

    await broadcastLocal({
        event: "order_updated",
        businessId: "biz_alpha",
        targets: ["owner"],
        payload: { order: { orderId: "ORD-1" } },
    })

    try {
        assert.equal(res.ended, true)
        assert.equal(writes.length, writesBeforeRevocation)
    } finally {
        closeHandler?.()
    }
})

test("Primary Owner permission bypass does not query Staff", async (t) => {
    let lookupCount = 0
    t.mock.method(Staff, "findOne", () => {
        lookupCount += 1
        throw new Error("Owner bypass must not query Staff")
    })

    const result = await runMiddleware(
        requirePermission(PERMISSIONS.ANALYTICS_VIEW),
        { session: { user: { role: "owner", businessId: "biz_alpha" } } },
    )
    assert.equal(result.nextCalled, true)
    assert.equal(lookupCount, 0)
})

test("Manager cannot pass primary-owner billing, Stripe, or team guards", async () => {
    for (const endpoint of ["billing", "Stripe", "team"]) {
        const result = await runMiddleware(requirePrimaryOwner, managerSession())
        assert.equal(result.nextCalled, false, endpoint)
        assert.equal(result.res.statusCode, 403, endpoint)
    }
    const owner = await runMiddleware(
        requirePrimaryOwner,
        { session: { user: { role: "owner", businessId: "biz_alpha" } } },
    )
    assert.equal(owner.nextCalled, true)
})

test("Manager cannot enter Owner/Co-Owner permission administration", async (t) => {
    const guard = requireManagementArea(MANAGEMENT_ACCESS_AREAS.STAFF_MANAGEMENT)
    mockManagerLookup(t, () => ({
        ...managerRecord(),
        role: "co_owner",
        staffId: "COW-1000",
        email: "coowner@example.com",
        coOwnerRestrictions: [],
    }))
    const manager = await runMiddleware(guard, managerSession())
    const coOwner = await runMiddleware(guard, {
        session: { user: {
            role: "co_owner",
            businessId: "biz_alpha",
            staffObjectId: "507f1f77bcf86cd799439011",
            staffId: "COW-1000",
            email: "coowner@example.com",
        } },
    })
    assert.equal(manager.res.statusCode, 403)
    assert.equal(coOwner.nextCalled, true)
})

test("public menu remains public, but an authenticated Manager needs menu.view", async (t) => {
    const publicRead = await runMiddleware(
        requirePermissionForAuthenticatedManager(PERMISSIONS.MENU_VIEW),
        {},
    )
    assert.equal(publicRead.nextCalled, true)

    mockManagerLookup(t, () => managerRecord())
    const managerRead = await runMiddleware(
        requirePermissionForAuthenticatedManager(PERMISSIONS.MENU_VIEW),
        managerSession(),
    )
    assert.equal(managerRead.res.statusCode, 403)
})

test("CRM and operational settings use distinct permissions", async (t) => {
    mockManagerLookup(t, () => managerRecord({ permissions: [PERMISSIONS.CRM_VIEW] }))
    const crm = await runMiddleware(requirePermission(PERMISSIONS.CRM_VIEW), managerSession())
    const settings = await runMiddleware(
        requirePermission(PERMISSIONS.SETTINGS_OPERATIONAL_MANAGE),
        managerSession(),
    )
    assert.equal(crm.nextCalled, true)
    assert.equal(settings.res.statusCode, 403)
})

test("plan entitlement still denies a permitted Manager", async (t) => {
    mockManagerLookup(t, () => managerRecord({ permissions: [PERMISSIONS.ANALYTICS_VIEW] }))
    t.mock.method(Business, "findOne", () => ({
        lean: async () => ({
            businessId: "biz_alpha",
            currentPlan: "basic",
            businessType: "restaurant",
            modules: ["foodService"],
        }),
    }))

    const req = managerSession()
    const permission = await runMiddleware(requirePermission(PERMISSIONS.ANALYTICS_VIEW), req)
    assert.equal(permission.nextCalled, true)

    const entitlement = await runMiddleware(requireEntitlement("advancedAnalytics"), req)
    assert.equal(entitlement.nextCalled, false)
    assert.equal(entitlement.res.statusCode, 403)
    assert.equal(entitlement.res.body.error, "ENTITLEMENT_REQUIRED")
})

test("owner-only and permission route declarations remain explicit", async () => {
    const ownerRoutes = await readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8")
    const menuRoutes = await readFile(new URL("../src/routes/menu-route.js", import.meta.url), "utf8")
    const businessRoutes = await readFile(new URL("../src/routes/business-route.js", import.meta.url), "utf8")
    const waitstaffRoutes = await readFile(new URL("../src/routes/waitstaff-route.js", import.meta.url), "utf8")
    const orderRoutes = await readFile(new URL("../src/routes/order-route.js", import.meta.url), "utf8")
    const server = await readFile(new URL("../server.js", import.meta.url), "utf8")
    const authController = await readFile(new URL("../src/controllers/authController.js", import.meta.url), "utf8")
    const staffController = await readFile(new URL("../src/controllers/staffController.js", import.meta.url), "utf8")

    assert.match(ownerRoutes, /MANAGEMENT_ACCESS_AREAS\.PAYMENTS_AND_BILLING/)
    assert.match(ownerRoutes, /router\.post\("\/stripe\/connect-account", requirePrimaryOwner/)
    assert.match(ownerRoutes, /router\.get\("\/team", requirePrimaryOwner/)
    assert.match(ownerRoutes, /"\/staff\/:staffId\/permissions",\s*requireManagementArea\(MANAGEMENT_ACCESS_AREAS\.STAFF_MANAGEMENT\)/)
    assert.match(menuRoutes, /requirePermission\(PERMISSIONS\.MENU_MANAGE\)/)
    assert.match(businessRoutes, /requireManagementArea\(\s*MANAGEMENT_ACCESS_AREAS\.BUSINESS_SETTINGS,\s*PERMISSIONS\.SETTINGS_OPERATIONAL_MANAGE/)
    assert.match(waitstaffRoutes, /"\/calls",\s*requirePermissionForAuthenticatedManager\(PERMISSIONS\.ORDERS_VIEW\)/)
    assert.match(waitstaffRoutes, /"\/calls",\s*requirePermissionForAuthenticatedManager\(PERMISSIONS\.ORDERS_MANAGE\)/)
    assert.match(orderRoutes, /"\/:orderId\/reorder",\s*requirePermissionForAuthenticatedManager\(PERMISSIONS\.ORDERS_VIEW\)/)
    assert.match(server, /requirePermission\(PERMISSIONS\.CRM_VIEW\)/)
    assert.match(authController, /role === "co_owner" \? \{\s*coOwnerRestrictions: staff\.coOwnerRestrictions \|\| \[\]/)
    assert.match(authController, /if \(sessionUser\.role === "manager"\) \{\s*const manager = await resolveCurrentManager\(req\)/)
    assert.match(authController, /Staff\.findOne\(\{ email, businessId, accountStatus: "active" \}\)/)
    assert.match(staffController, /requesterRole === "manager" && !OPERATIONAL_ROLES\.includes\(role\)/)
    assert.match(staffController, /Staff\.findOne\(\{ businessId, staffId, role: "manager" \}\)/)
    assert.match(staffController, /normalizePermissions\(req\.body\?\.permissions\)/)
})
