import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import bcrypt from "bcrypt"

process.env.REDIS_URL = ""

const Staff = (await import("../src/models/Staff.js")).default
const Business = (await import("../src/models/Business.js")).default
const {
    requireAuth,
    requireRole,
} = await import("../src/middleware/authMiddleware.js")
const {
    changePassword,
    loginUser,
    resetPassword,
} = await import("../src/controllers/authController.js")
const {
    broadcastLocal,
    publishStaffAccessRevocation,
    sseHandler,
} = await import("../src/utils/sseManager.js")

const IDS = {
    waiter: "507f1f77bcf86cd799439011",
    kitchen: "507f1f77bcf86cd799439012",
    bartender: "507f1f77bcf86cd799439013",
    manager: "507f1f77bcf86cd799439014",
}

function createResponse() {
    return {
        statusCode: 200,
        body: undefined,
        ended: false,
        clearedCookie: null,
        writes: [],
        status(code) {
            this.statusCode = code
            return this
        },
        json(body) {
            this.body = body
            return this
        },
        end(body) {
            this.ended = true
            this.body = body
            return this
        },
        setHeader() {},
        flushHeaders() {},
        write(value) {
            this.writes.push(value)
            return true
        },
        clearCookie(name) {
            this.clearedCookie = name
        },
    }
}

function staffRecord(role, overrides = {}) {
    return {
        _id: IDS[role] || IDS.waiter,
        businessId: "biz_alpha",
        staffId: `${role.slice(0, 3).toUpperCase()}-1000`,
        role,
        name: `${role} user`,
        email: `${role}@example.test`,
        accountStatus: "active",
        permissions: [],
        coOwnerRestrictions: [],
        authVersion: 0,
        ...overrides,
    }
}

function staffSession(role, overrides = {}) {
    const session = {
        user: {
            type: "staff",
            role,
            businessId: "biz_alpha",
            staffObjectId: IDS[role] || IDS.waiter,
            staffId: `${role.slice(0, 3).toUpperCase()}-1000`,
            email: `${role}@example.test`,
        },
        staffAuthVersion: 0,
        destroyed: false,
        destroy(callback) {
            this.destroyed = true
            callback?.()
        },
        ...overrides,
    }
    return session
}

function selectable(getValue) {
    return {
        select() {
            return this
        },
        async lean() {
            return getValue()
        },
    }
}

function mockCanonicalStaffLookup(t, getRecord, filters = []) {
    t.mock.method(Staff, "findOne", (filter) => {
        filters.push(filter)
        return selectable(() => {
            const record = getRecord(filter)
            if (!record) return null
            if (filter.businessId && filter.businessId !== record.businessId) return null
            if (filter._id && String(filter._id) !== String(record._id)) return null
            if (filter.staffId && filter.staffId !== record.staffId) return null
            if (filter.email && filter.email !== record.email) return null
            if (filter.role && filter.role !== record.role) return null
            if (filter.accountStatus && filter.accountStatus !== record.accountStatus) return null
            return { ...record }
        })
    })
    return filters
}

async function runMiddleware(middleware, req) {
    const res = createResponse()
    let nextCalled = false
    await middleware(req, res, () => {
        nextCalled = true
    })
    return { req, res, nextCalled }
}

async function runProtectedRole(req, role) {
    const auth = await runMiddleware(requireAuth, req)
    if (!auth.nextCalled) return auth
    return runMiddleware(requireRole(role), req)
}

for (const role of ["waiter", "kitchen", "bartender"]) {
    test(`active ${role} session works and the same session fails immediately after disable`, async (t) => {
        let record = staffRecord(role)
        mockCanonicalStaffLookup(t, () => record)
        const session = staffSession(role)

        const active = await runProtectedRole({ session }, role)
        assert.equal(active.nextCalled, true)

        record = { ...record, accountStatus: "disabled", authVersion: 1 }
        const revoked = await runProtectedRole({ session }, role)
        assert.equal(revoked.nextCalled, false)
        assert.equal(revoked.res.statusCode, 401)
        assert.equal(revoked.res.body.code, "SESSION_REVOKED")
        assert.equal(session.destroyed, true)
    })
}

test("a removed Staff record cannot continue using its existing session", async (t) => {
    let record = staffRecord("waiter")
    mockCanonicalStaffLookup(t, () => record)
    const session = staffSession("waiter")
    assert.equal((await runProtectedRole({ session }, "waiter")).nextCalled, true)

    record = null
    const removed = await runProtectedRole({ session }, "waiter")
    assert.equal(removed.res.statusCode, 401)
    assert.equal(removed.res.body.code, "SESSION_REVOKED")
})

for (const [fromRole, toRole] of [
    ["waiter", "kitchen"],
    ["kitchen", "waiter"],
    ["bartender", "manager"],
]) {
    test(`${fromRole} to ${toRole} role change invalidates the old session and the current role works after login`, async (t) => {
        let record = staffRecord(fromRole)
        mockCanonicalStaffLookup(t, () => record)
        const oldSession = staffSession(fromRole)
        assert.equal((await runProtectedRole({ session: oldSession }, fromRole)).nextCalled, true)

        record = {
            ...record,
            _id: IDS[fromRole],
            role: toRole,
            authVersion: 1,
        }
        const stale = await runProtectedRole({ session: oldSession }, fromRole)
        assert.equal(stale.res.statusCode, 401)

        const currentSession = staffSession(toRole, {
            staffAuthVersion: 1,
            user: {
                ...staffSession(toRole).user,
                staffObjectId: IDS[fromRole],
                staffId: record.staffId,
                email: record.email,
            },
        })
        const current = await runProtectedRole({ session: currentSession }, toRole)
        assert.equal(current.nextCalled, true)
    })
}

test("tenant and Staff identity stay pinned to the authenticated session", async (t) => {
    const record = staffRecord("waiter")
    const filters = mockCanonicalStaffLookup(t, () => record)
    const request = {
        session: staffSession("waiter"),
        body: { businessId: "biz_beta", staffId: "WAI-OTHER" },
        params: { businessId: "biz_beta", staffId: "WAI-OTHER" },
        query: { businessId: "biz_beta" },
    }
    const result = await runProtectedRole(request, "waiter")
    assert.equal(result.nextCalled, true)
    assert.equal(filters[0].businessId, "biz_alpha")
    assert.equal(filters[0]._id, IDS.waiter)

    const substituted = staffSession("waiter")
    substituted.user.staffObjectId = IDS.kitchen
    const denied = await runProtectedRole({ session: substituted }, "waiter")
    assert.equal(denied.res.statusCode, 401)
})

function createSseRequest(role, { queryBusinessId = "biz_alpha" } = {}) {
    let closeHandler = null
    const channel = role === "bartender" ? "bar" : role
    return {
        req: {
            session: staffSession(role),
            query: { role: channel, businessId: queryBusinessId },
            on(event, handler) {
                if (event === "close") closeHandler = handler
            },
        },
        close() {
            closeHandler?.()
        },
    }
}

test("operational SSE admission, reconnect, role, and tenant checks use current Staff state", async (t) => {
    let record = staffRecord("waiter")
    mockCanonicalStaffLookup(t, () => record)

    const active = createSseRequest("waiter")
    const activeResponse = createResponse()
    await sseHandler(active.req, activeResponse)
    assert.equal(activeResponse.statusCode, 200)
    assert.equal(activeResponse.ended, false)
    assert.equal(activeResponse.writes.length, 1)

    record = { ...record, accountStatus: "disabled", authVersion: 1 }
    const disabled = createSseRequest("waiter")
    const disabledResponse = createResponse()
    await sseHandler(disabled.req, disabledResponse)
    assert.equal(disabledResponse.statusCode, 401)

    record = { ...record, accountStatus: "active", role: "kitchen" }
    const staleRole = createSseRequest("waiter")
    const staleRoleResponse = createResponse()
    await sseHandler(staleRole.req, staleRoleResponse)
    assert.equal(staleRoleResponse.statusCode, 401)

    record = staffRecord("waiter")
    const crossTenant = createSseRequest("waiter", { queryBusinessId: "biz_beta" })
    const crossTenantResponse = createResponse()
    await sseHandler(crossTenant.req, crossTenantResponse)
    assert.equal(crossTenantResponse.statusCode, 403)
    active.close()
})

test("canonical disable stops delivery to an already-open waiter SSE stream", async (t) => {
    let record = staffRecord("waiter")
    mockCanonicalStaffLookup(t, () => record)
    const stream = createSseRequest("waiter")
    const response = createResponse()
    await sseHandler(stream.req, response)
    const initialWrites = response.writes.length

    record = { ...record, accountStatus: "disabled", authVersion: 1 }
    await broadcastLocal({
        event: "order_updated",
        businessId: "biz_alpha",
        targets: ["waiter"],
        payload: { invalidated: true },
    })
    assert.equal(response.ended, true)
    assert.equal(response.writes.length, initialWrites)
    stream.close()
})

test("cross-instance Staff revocation event closes all matching operational streams", async (t) => {
    const record = staffRecord("bartender")
    mockCanonicalStaffLookup(t, () => record)
    const stream = createSseRequest("bartender")
    const response = createResponse()
    await sseHandler(stream.req, response)
    assert.equal(response.ended, false)

    await publishStaffAccessRevocation({
        businessId: record.businessId,
        staffObjectId: record._id,
        staffId: record.staffId,
    })
    assert.equal(response.ended, true)
    stream.close()
})

test("Staff password change revokes every older auth version and requires reauthentication", async (t) => {
    const record = {
        ...staffRecord("manager"),
        passwordHash: "old-hash",
        async save() {},
    }
    t.mock.method(Staff, "findOne", (filter) => {
        if (filter.accountStatus) return Promise.resolve(record)
        return selectable(() => ({ ...record }))
    })
    t.mock.method(bcrypt, "compare", async () => true)
    t.mock.method(bcrypt, "hash", async () => "new-hash")

    const session = staffSession("manager")
    const req = {
        session,
        body: { currentPassword: "OldPassword1", newPassword: "NewPassword1" },
    }
    assert.equal((await runMiddleware(requireAuth, req)).nextCalled, true)
    const res = createResponse()
    await changePassword(req, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.reauthenticationRequired, true)
    assert.equal(record.passwordHash, "new-hash")
    assert.equal(record.authVersion, 1)
    assert.equal(session.destroyed, true)

    const oldDevice = await runMiddleware(requireAuth, { session: staffSession("manager") })
    assert.equal(oldDevice.res.statusCode, 401)
    const newDevice = await runMiddleware(requireAuth, {
        session: staffSession("manager", { staffAuthVersion: 1 }),
    })
    assert.equal(newDevice.nextCalled, true)
})

test("Staff password reset revokes old sessions; only the new credential logs in", async (t) => {
    const record = {
        ...staffRecord("waiter"),
        passwordHash: "old-hash",
        passwordResetToken: "stored-token",
        passwordResetExpires: new Date(Date.now() + 60_000),
        presenceStatus: "offline",
        status: "offline",
        async save() {},
    }
    t.mock.method(Business, "findOne", async () => null)
    t.mock.method(Business, "findOneAndUpdate", async () => null)
    t.mock.method(Staff, "findOneAndUpdate", async (_filter, update) => {
        Object.assign(record, update.$set)
        record.authVersion += update.$inc.authVersion
        record.passwordResetToken = undefined
        record.passwordResetExpires = undefined
        return record
    })
    t.mock.method(Staff, "findOne", (filter) => {
        if (filter.passwordResetToken || filter.email) return Promise.resolve(record)
        return selectable(() => ({ ...record }))
    })
    t.mock.method(bcrypt, "hash", async () => "new-hash")
    t.mock.method(bcrypt, "compare", async (plain, hash) => (
        plain === "NewPassword1" && hash === "new-hash"
    ))

    const resetResponse = createResponse()
    await resetPassword({ body: { token: "reset-token", password: "NewPassword1" } }, resetResponse)
    assert.equal(resetResponse.statusCode, 200)
    assert.equal(record.passwordHash, "new-hash")
    assert.equal(record.authVersion, 1)

    const stale = await runMiddleware(requireAuth, { session: staffSession("waiter") })
    assert.equal(stale.res.statusCode, 401)

    const oldLoginResponse = createResponse()
    await loginUser({
        body: { email: record.email, password: "OldPassword1" },
        session: staffSession("waiter"),
    }, oldLoginResponse)
    assert.equal(oldLoginResponse.statusCode, 401)

    const newLoginSession = {
        regenerate(callback) { callback() },
        save(callback) { callback() },
    }
    const newLoginResponse = createResponse()
    await loginUser({
        body: { email: record.email, password: "NewPassword1" },
        session: newLoginSession,
    }, newLoginResponse)
    assert.equal(newLoginResponse.statusCode, 200)
    assert.equal(newLoginSession.staffAuthVersion, 1)
})

test("SEC-005 keeps operational roles role-based and wires versioned Staff session authority", async () => {
    const [middlewareSource, modelSource, authRoutes, routeSources] = await Promise.all([
        readFile(new URL("../src/middleware/authMiddleware.js", import.meta.url), "utf8"),
        readFile(new URL("../src/models/Staff.js", import.meta.url), "utf8"),
        readFile(new URL("../src/routes/auth-route.js", import.meta.url), "utf8"),
        Promise.all([
            "waitstaff-route.js",
            "kitchen-route.js",
            "bar-route.js",
        ].map((file) => readFile(new URL(`../src/routes/${file}`, import.meta.url), "utf8"))),
    ])

    assert.match(middlewareSource, /resolveCurrentStaff/)
    assert.match(modelSource, /authVersion/)
    assert.match(modelSource, /AUTH_VERSION_PATHS = \["accountStatus", "role"\]/)
    assert.match(authRoutes, /"\/change-password", authLimiter, requireAuth, changePassword/)
    assert.match(routeSources[0], /requireRole\("waiter"\)/)
    assert.match(routeSources[1], /requireRole\("kitchen"\)/)
    assert.match(routeSources[2], /requireRole\("bartender", "manager", "owner", "co_owner", "admin"\)/)
    for (const source of routeSources) {
        assert.doesNotMatch(source, /WAITER_[A-Z_]+|KITCHEN_[A-Z_]+|BARTENDER_[A-Z_]+/)
    }
})
