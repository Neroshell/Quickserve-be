import assert from "node:assert/strict"
import test from "node:test"
import bcrypt from "bcrypt"

import Business from "../src/models/Business.js"
import Staff from "../src/models/Staff.js"
import { HOUSEKEEPING_DEFAULT_PERMISSIONS, PERMISSIONS } from "../src/constants/permissions.js"
import { requireOperationalPermission } from "../src/middleware/authMiddleware.js"
import { assertLodgingBusiness } from "../src/services/housekeepingService.js"

process.env.REDIS_URL = ""
const { getMe, loginUser, setupStaffPassword } = await import("../src/controllers/authController.js")

const HOUSEKEEPING_ID = "507f1f77bcf86cd799439011"

function response() {
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

function selectable(value) {
    return {
        select() { return this },
        async lean() { return value },
        then(resolve, reject) { return Promise.resolve(value).then(resolve, reject) },
    }
}

function housekeepingRecord(overrides = {}) {
    return {
        _id: HOUSEKEEPING_ID,
        businessId: "hotel_alpha",
        staffId: "HSK-1001",
        role: "housekeeping",
        name: "Housekeeping Test",
        email: "housekeeping@example.com",
        passwordHash: "stored-password-hash",
        accountStatus: "active",
        presenceStatus: "offline",
        status: "offline",
        permissions: [...HOUSEKEEPING_DEFAULT_PERMISSIONS],
        async save() {},
        ...overrides,
    }
}

function housekeepingSession(overrides = {}) {
    return {
        role: "housekeeping",
        businessId: "hotel_alpha",
        staffObjectId: HOUSEKEEPING_ID,
        staffId: "HSK-1001",
        email: "housekeeping@example.com",
        name: "Housekeeping Test",
        ...overrides,
    }
}

async function runPermissionGuard(record, sessionOverrides = {}) {
    const originalFindOne = Staff.findOne
    Staff.findOne = () => selectable(record)
    try {
        const req = { session: { user: housekeepingSession(sessionOverrides) } }
        const res = response()
        let nextCalled = false
        await requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_VIEW)(req, res, () => {
            nextCalled = true
        })
        return { req, res, nextCalled }
    } finally {
        Staff.findOne = originalFindOne
    }
}

test("housekeeping login creates the normal Staff session", async (t) => {
    const staff = housekeepingRecord()
    t.mock.method(Business, "findOne", () => Promise.resolve(null))
    t.mock.method(Staff, "findOne", () => Promise.resolve(staff))
    t.mock.method(bcrypt, "compare", async () => true)

    const req = {
        body: { email: staff.email, password: "Password1" },
        session: {
            regenerate(callback) { callback() },
            save(callback) { callback() },
        },
    }
    const res = response()
    await loginUser(req, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.role, "housekeeping")
    assert.deepEqual(req.session.user, {
        type: "staff",
        role: "housekeeping",
        staffId: "HSK-1001",
        staffObjectId: HOUSEKEEPING_ID,
        name: "Housekeeping Test",
        email: "housekeeping@example.com",
        businessId: "hotel_alpha",
    })
})

test("an invited housekeeping account preserves defaults through setup and login", async (t) => {
    const staff = housekeepingRecord({
        accountStatus: "pending",
        passwordHash: undefined,
        inviteToken: "stored-invite-token-hash",
        inviteTokenExpires: new Date(Date.now() + 60_000),
    })
    t.mock.method(Business, "findOne", () => Promise.resolve(null))
    t.mock.method(Staff, "findOne", () => Promise.resolve(staff))
    t.mock.method(bcrypt, "hash", async () => "new-password-hash")
    t.mock.method(bcrypt, "compare", async () => true)

    const setupRes = response()
    await setupStaffPassword({
        query: {},
        body: { token: "raw-invite-token", password: "Password1" },
    }, setupRes)
    assert.equal(setupRes.statusCode, 200)
    assert.equal(staff.accountStatus, "active")
    assert.deepEqual(staff.permissions, HOUSEKEEPING_DEFAULT_PERMISSIONS)

    const loginReq = {
        body: { email: staff.email, password: "Password1" },
        session: {
            regenerate(callback) { callback() },
            save(callback) { callback() },
        },
    }
    const loginRes = response()
    await loginUser(loginReq, loginRes)
    assert.equal(loginRes.statusCode, 200)
    assert.equal(loginReq.session.user.role, "housekeeping")
})

test("auth/me returns current housekeeping permissions and canonical Lodging capability", async (t) => {
    const staff = housekeepingRecord()
    t.mock.method(Staff, "findOne", (filter) => selectable(
        filter.businessId === staff.businessId ? staff : null,
    ))
    t.mock.method(Business, "findOne", (filter) => selectable(
        filter.$or?.some((entry) => entry.businessId === staff.businessId)
            ? { businessId: staff.businessId, businessType: "hotel", modules: ["lodging", "foodService"], displayName: "Mixed Hotel" }
            : null,
    ))

    const req = { session: { user: housekeepingSession() } }
    const res = response()
    await getMe(req, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.role, "housekeeping")
    assert.deepEqual(res.body.permissions, HOUSEKEEPING_DEFAULT_PERMISSIONS)
    assert.deepEqual(res.body.modules, ["lodging", "foodService"])
    assert.equal(res.body.capabilities.visibleModules.includes("lodging"), true)
})

test("operational guard allows active same-tenant housekeeping with housekeeping.view", async () => {
    const result = await runPermissionGuard(housekeepingRecord())
    assert.equal(result.nextCalled, true)
    assert.equal(result.req.resolvedOperationalStaff.staffId, "HSK-1001")
})

test("operational guard denies missing housekeeping.view without inferring role defaults", async () => {
    const result = await runPermissionGuard(housekeepingRecord({
        permissions: [PERMISSIONS.HOUSEKEEPING_PERFORM, PERMISSIONS.INVENTORY_ROOM_USAGE_RECORD],
    }))
    assert.equal(result.nextCalled, false)
    assert.equal(result.res.statusCode, 403)
})

test("operational guard denies disabled housekeeping", async () => {
    const result = await runPermissionGuard(housekeepingRecord({ accountStatus: "disabled" }))
    assert.equal(result.nextCalled, false)
    assert.equal(result.res.statusCode, 403)
})

test("operational guard denies a Staff result from another tenant", async () => {
    const result = await runPermissionGuard(housekeepingRecord({ businessId: "hotel_beta" }))
    assert.equal(result.nextCalled, false)
    assert.equal(result.res.statusCode, 403)
})

test("permission removal after login is enforced on the next protected request", async () => {
    const allowed = await runPermissionGuard(housekeepingRecord())
    assert.equal(allowed.nextCalled, true)

    const revoked = await runPermissionGuard(housekeepingRecord({ permissions: [] }))
    assert.equal(revoked.nextCalled, false)
    assert.equal(revoked.res.statusCode, 403)
})

test("Housekeeping capability accepts Lodging and mixed businesses but rejects Food Service only", () => {
    assert.doesNotThrow(() => assertLodgingBusiness({ businessType: "hotel", modules: ["lodging"] }))
    assert.doesNotThrow(() => assertLodgingBusiness({ businessType: "hotel", modules: ["lodging", "foodService"] }))
    assert.throws(
        () => assertLodgingBusiness({ businessType: "restaurant", modules: ["foodService"] }),
        (error) => error.code === "HOUSEKEEPING_NOT_ENABLED" && error.statusCode === 403,
    )
})

test("housekeeping defaults stay narrow and exclude broad management permissions", () => {
    assert.deepEqual(HOUSEKEEPING_DEFAULT_PERMISSIONS, [
        PERMISSIONS.HOUSEKEEPING_VIEW,
        PERMISSIONS.HOUSEKEEPING_PERFORM,
        PERMISSIONS.INVENTORY_ROOM_USAGE_RECORD,
    ])
    for (const forbidden of [
        PERMISSIONS.INVENTORY_MANAGE,
        PERMISSIONS.RESERVATIONS_MANAGE,
        PERMISSIONS.SERVICE_POINTS_MANAGE,
    ]) {
        assert.equal(HOUSEKEEPING_DEFAULT_PERMISSIONS.includes(forbidden), false)
    }
})

test("disabled housekeeping cannot establish a login session", async (t) => {
    const staff = housekeepingRecord({ accountStatus: "disabled" })
    t.mock.method(Business, "findOne", () => Promise.resolve(null))
    t.mock.method(Staff, "findOne", () => Promise.resolve(staff))

    const req = {
        body: { email: staff.email, password: "Password1" },
        session: {
            regenerate() { throw new Error("session must not be created") },
            save() { throw new Error("session must not be saved") },
        },
    }
    const res = response()
    await loginUser(req, res)

    assert.equal(res.statusCode, 401)
    assert.equal(req.session.user, undefined)
})
