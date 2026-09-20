import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import bcrypt from "bcrypt"

// Never connect focused authentication tests to an environment-configured
// realtime Redis endpoint.
process.env.REDIS_URL = ""

const Business = (await import("../src/models/Business.js")).default
const OnboardingSession = (await import("../src/models/OnboardingSession.js")).default
const Staff = (await import("../src/models/Staff.js")).default
const {
    changePassword,
    loginUser,
    resetPassword,
    setupOwnerPassword,
    setupStaffPassword,
} = await import("../src/controllers/authController.js")
const {
    replaceVerificationChallenge,
    resendVerificationEmail,
    startSignup,
    verifyEmail,
} = await import("../src/controllers/onboardingController.js")
const { requireAuth } = await import("../src/middleware/authMiddleware.js")
const {
    createSharedSecurityRateLimit,
    getRequestIp,
    normalizeRateLimitEmail,
} = await import("../src/middleware/sharedSecurityRateLimit.js")
const {
    PASSWORD_MAX_UTF8_BYTES,
    PASSWORD_MIN_CHARACTERS,
    validateNewPassword,
} = await import("../src/utils/passwordPolicy.js")
const { hashToken } = await import("../src/utils/tokenHash.js")

const OWNER_ID = "507f1f77bcf86cd799439011"

function response() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this },
        json(body) { this.body = body; return this },
        set(name, value) { this.headers[name] = value; return this },
        clearCookie() {},
    }
}

function selectable(value) {
    return {
        select() { return this },
        lean() { return Promise.resolve(typeof value === "function" ? value() : value) },
    }
}

async function runMiddleware(middleware, req) {
    const res = response()
    let nextCalled = false
    await middleware(req, res, () => { nextCalled = true })
    return { res, nextCalled }
}

function mockVerificationState(t, initial) {
    const state = { ...initial }
    t.mock.method(OnboardingSession, "findOneAndUpdate", async (filter, update) => {
        if (state.ownerEmail !== filter.ownerEmail || state.emailVerified !== false) return null
        if (filter.verificationTokenExpires?.$gt && state.verificationTokenExpires <= filter.verificationTokenExpires.$gt) return null
        if ((state.verificationAttempts || 0) >= 5) return null

        const suppliedHash = typeof filter.verificationToken === "string"
            ? filter.verificationToken
            : filter.verificationToken?.$ne
        const isCorrectTransition = typeof filter.verificationToken === "string"
        if (isCorrectTransition && state.verificationToken !== suppliedHash) return null
        if (!isCorrectTransition && state.verificationToken === suppliedHash) return null

        if (Array.isArray(update)) {
            state.verificationAttempts = (state.verificationAttempts || 0) + 1
            if (state.verificationAttempts >= 5) state.verificationLockedAt = new Date()
        } else {
            Object.assign(state, update.$set)
            for (const key of Object.keys(update.$unset || {})) delete state[key]
        }
        return state
    })
    t.mock.method(OnboardingSession, "findOne", async (filter) => (
        filter.ownerEmail === state.ownerEmail ? state : null
    ))
    return state
}

class SharedFakeRedis {
    constructor() {
        this.__securityRateLimitTestClient = true
        this.counts = new Map()
    }

    async eval(_script, { keys, arguments: args }) {
        const windowMs = Number(args[0])
        let blocked = 0
        for (let index = 0; index < keys.length; index++) {
            const count = (this.counts.get(keys[index]) || 0) + 1
            this.counts.set(keys[index], count)
            if (count > Number(args[index + 1])) blocked = 1
        }
        return [blocked, windowMs]
    }
}

test("canonical password policy prefers length and respects bcrypt's 72-byte boundary", () => {
    assert.equal(PASSWORD_MIN_CHARACTERS, 12)
    assert.equal(PASSWORD_MAX_UTF8_BYTES, 72)
    assert.equal(validateNewPassword("x").valid, false)
    assert.equal(validateNewPassword("elevenchars").valid, false)
    assert.equal(validateNewPassword("a practical passphrase").valid, true)
    assert.equal(validateNewPassword("x".repeat(72)).valid, true)
    assert.equal(validateNewPassword("x".repeat(73)).valid, false)
    assert.equal(validateNewPassword("🙂".repeat(18)).valid, true)
    assert.equal(validateNewPassword("🙂".repeat(19)).valid, false)
})

test("owner signup rejects one-character and below-minimum passwords before persistence", async () => {
    for (const password of ["x", "short value"]) {
        const res = response()
        await startSignup({
            body: {
                firstName: "Owner",
                lastName: "Example",
                email: "owner@example.com",
                password,
                termsAccepted: true,
            },
        }, res)
        assert.equal(res.statusCode, 400)
        assert.match(res.body.code, /^PASSWORD_/)
    }
})

test("Staff invite acceptance enforces policy and atomically preserves tenant and role authority", async (t) => {
    const staff = {
        businessId: "biz_a",
        staffId: "STF-1",
        role: "waiter",
        accountStatus: "pending",
        inviteToken: hashToken("invite-a"),
    }
    let capturedFilter
    let capturedUpdate
    t.mock.method(bcrypt, "hash", async () => "new-hash")
    t.mock.method(Staff, "findOneAndUpdate", async (filter, update) => {
        capturedFilter = filter
        capturedUpdate = update
        if (staff.accountStatus !== "pending" || filter.inviteToken !== staff.inviteToken) return null
        Object.assign(staff, update.$set)
        delete staff.inviteToken
        return staff
    })

    const weak = response()
    await setupStaffPassword({ body: { token: "invite-a", password: "weak" } }, weak)
    assert.equal(weak.statusCode, 400)

    const accepted = response()
    await setupStaffPassword({
        body: {
            token: "invite-a",
            password: "correct horse battery staple",
            role: "manager",
            businessId: "biz_b",
            staffId: "STF-OTHER",
        },
    }, accepted)
    assert.equal(accepted.statusCode, 200)
    assert.equal(staff.businessId, "biz_a")
    assert.equal(staff.role, "waiter")
    assert.equal(capturedFilter.accountStatus, "pending")
    assert.equal(capturedUpdate.$set.role, undefined)
    assert.equal(capturedUpdate.$set.businessId, undefined)

    const replay = response()
    await setupStaffPassword({ body: { token: "invite-a", password: "another valid passphrase" } }, replay)
    assert.equal(replay.statusCode, 404)
})

test("expired or revoked Staff invite fails closed", async (t) => {
    t.mock.method(bcrypt, "hash", async () => "unused")
    t.mock.method(Staff, "findOneAndUpdate", async () => null)
    const res = response()
    await setupStaffPassword({ body: { token: "expired", password: "a valid long passphrase" } }, res)
    assert.equal(res.statusCode, 404)
})

test("owner invitation uses the same policy and atomic token consumption", async (t) => {
    let pending = true
    t.mock.method(bcrypt, "hash", async () => "owner-hash")
    t.mock.method(Business, "findOneAndUpdate", async (_filter, update) => {
        if (!pending) return null
        pending = false
        assert.equal(update.$set.ownerStatus, "active")
        assert.ok(update.$unset.inviteToken !== undefined)
        return { businessId: "biz_owner", ownerStatus: "active" }
    })

    const accepted = response()
    await setupOwnerPassword({ body: { token: "owner-token", password: "owner passphrase value" } }, accepted)
    assert.equal(accepted.statusCode, 200)
    const replay = response()
    await setupOwnerPassword({ body: { token: "owner-token", password: "owner passphrase value" } }, replay)
    assert.equal(replay.statusCode, 404)
})

test("verification succeeds atomically and the consumed code cannot be reused", async (t) => {
    const code = "123456"
    const state = mockVerificationState(t, {
        sessionId: "sess-1",
        ownerEmail: "owner@example.com",
        emailVerified: false,
        verificationToken: hashToken(code),
        verificationTokenExpires: new Date(Date.now() + 60_000),
        verificationAttempts: 0,
    })

    const first = response()
    await verifyEmail({ body: { email: state.ownerEmail, token: code } }, first)
    assert.equal(first.statusCode, 200)
    assert.equal(state.emailVerified, true)
    assert.equal(state.verificationToken, undefined)

    const replay = response()
    await verifyEmail({ body: { email: state.ownerEmail, token: code } }, replay)
    assert.equal(replay.statusCode, 400)
})

test("wrong verification attempts increment durably and five failures exhaust the challenge", async (t) => {
    const state = mockVerificationState(t, {
        sessionId: "sess-2",
        ownerEmail: "owner@example.com",
        emailVerified: false,
        verificationToken: hashToken("123456"),
        verificationTokenExpires: new Date(Date.now() + 60_000),
        verificationAttempts: 0,
    })

    for (let attempt = 1; attempt <= 5; attempt++) {
        const res = response()
        await verifyEmail({ body: { email: state.ownerEmail, token: "654321" }, session: {} }, res)
        assert.equal(state.verificationAttempts, attempt)
        assert.equal(res.statusCode, 400)
        if (attempt === 5) assert.equal(res.body.code, "VERIFICATION_ATTEMPTS_EXHAUSTED")
    }

    const newBrowser = response()
    await verifyEmail({ body: { email: state.ownerEmail, token: "123456" }, session: {} }, newBrowser)
    assert.equal(newBrowser.statusCode, 400)
    assert.equal(newBrowser.body.code, "VERIFICATION_ATTEMPTS_EXHAUSTED")
})

test("expired verification code fails server-side", async (t) => {
    mockVerificationState(t, {
        sessionId: "sess-expired",
        ownerEmail: "owner@example.com",
        emailVerified: false,
        verificationToken: hashToken("123456"),
        verificationTokenExpires: new Date(Date.now() - 1_000),
        verificationAttempts: 0,
    })
    const res = response()
    await verifyEmail({ body: { email: "owner@example.com", token: "123456" } }, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.code, "VERIFICATION_CODE_EXPIRED")
})

test("concurrent correct verification requests have one winner", async (t) => {
    mockVerificationState(t, {
        sessionId: "sess-concurrent",
        ownerEmail: "owner@example.com",
        emailVerified: false,
        verificationToken: hashToken("123456"),
        verificationTokenExpires: new Date(Date.now() + 60_000),
        verificationAttempts: 0,
    })
    const responses = [response(), response()]
    await Promise.all(responses.map((res) => verifyEmail({
        body: { email: "owner@example.com", token: "123456" },
    }, res)))
    assert.deepEqual(responses.map((res) => res.statusCode).sort(), [200, 400])
})

test("resend atomically replaces the code, resets attempts, and concurrent calls send once", async (t) => {
    const originalHash = hashToken("111111")
    const state = {
        ownerEmail: "owner@example.com",
        ownerName: "Owner",
        emailVerified: false,
        verificationToken: originalHash,
        verificationTokenExpires: new Date(Date.now() + 60_000),
        verificationAttempts: 4,
        verificationLastSentAt: new Date(0),
        verificationGeneration: 1,
        verificationLockedAt: new Date(),
    }
    t.mock.method(OnboardingSession, "findOneAndUpdate", async (filter, update) => {
        const cutoff = filter.$or[0].verificationLastSentAt.$lte
        if (state.emailVerified || state.verificationLastSentAt > cutoff) return null
        Object.assign(state, update.$set)
        state.verificationGeneration += update.$inc.verificationGeneration
        for (const key of Object.keys(update.$unset)) delete state[key]
        return state
    })
    const sentCodes = []
    const sender = async ({ verificationCode }) => {
        sentCodes.push(verificationCode)
        return true
    }
    const now = new Date()
    const results = await Promise.all([
        replaceVerificationChallenge(state.ownerEmail, { now, sendVerificationCode: sender }),
        replaceVerificationChallenge(state.ownerEmail, { now, sendVerificationCode: sender }),
    ])
    assert.equal(results.filter((result) => result.replaced).length, 1)
    assert.equal(sentCodes.length, 1)
    assert.notEqual(state.verificationToken, originalHash)
    assert.equal(state.verificationToken, hashToken(sentCodes[0]))
    assert.equal(state.verificationAttempts, 0)
    assert.equal(state.verificationGeneration, 2)
    assert.equal(state.verificationLockedAt, undefined)
})

test("public resend returns the same generic response for ineligible account states", async (t) => {
    t.mock.method(OnboardingSession, "findOneAndUpdate", async () => null)
    const missing = response()
    const alreadyVerified = response()
    await resendVerificationEmail({ body: { email: "missing@example.com" } }, missing)
    await resendVerificationEmail({ body: { email: "verified@example.com" } }, alreadyVerified)
    assert.equal(missing.statusCode, 202)
    assert.equal(alreadyVerified.statusCode, 202)
    assert.deepEqual(missing.body, alreadyVerified.body)
})

test("password reset and password change reject frontend-bypassed weak credentials", async () => {
    const resetRes = response()
    await resetPassword({ body: { token: "token", password: "weak" } }, resetRes)
    assert.equal(resetRes.statusCode, 400)

    const changeRes = response()
    await changePassword({
        session: { user: { role: "owner" } },
        body: { currentPassword: "existing", newPassword: "weak" },
    }, changeRes)
    assert.equal(changeRes.statusCode, 400)
})

test("owner password reset atomically consumes token and advances session authority", async (t) => {
    let consumed = false
    let capturedUpdate
    t.mock.method(bcrypt, "hash", async () => "replacement-hash")
    t.mock.method(Business, "findOneAndUpdate", async (_filter, update) => {
        if (consumed) return null
        consumed = true
        capturedUpdate = update
        return { _id: OWNER_ID, businessId: "biz_owner", ownerAuthVersion: 3 }
    })
    t.mock.method(Staff, "findOneAndUpdate", async () => null)

    const first = response()
    await resetPassword({ body: { token: "reset-token", password: "new owner passphrase" } }, first)
    assert.equal(first.statusCode, 200)
    assert.equal(capturedUpdate.$inc.ownerAuthVersion, 1)
    assert.ok(capturedUpdate.$unset.passwordResetToken !== undefined)

    const replay = response()
    await resetPassword({ body: { token: "reset-token", password: "new owner passphrase" } }, replay)
    assert.equal(replay.statusCode, 400)
})

test("owner authVersion invalidates old sessions while the current version passes", async (t) => {
    const business = {
        _id: OWNER_ID,
        businessId: "biz_owner",
        ownerEmail: "owner@example.com",
        ownerName: "Owner",
        ownerStatus: "active",
        ownerAuthVersion: 2,
    }
    t.mock.method(Business, "findOne", () => selectable(business))
    const baseUser = {
        type: "owner",
        role: "owner",
        userId: OWNER_ID,
        businessId: business.businessId,
        email: business.ownerEmail,
    }
    const stale = await runMiddleware(requireAuth, {
        session: { user: baseUser, ownerAuthVersion: 1, destroy(callback) { callback() } },
    })
    assert.equal(stale.res.statusCode, 401)

    const current = await runMiddleware(requireAuth, {
        session: { user: baseUser, ownerAuthVersion: 2 },
    })
    assert.equal(current.nextCalled, true)
})

test("login errors do not distinguish unknown, inactive Owner, or disabled Staff", async (t) => {
    t.mock.method(bcrypt, "compare", async () => true)
    const cases = [
        { business: null, staff: null },
        { business: { ownerStatus: "pending", ownerPasswordHash: "hash" }, staff: null },
        { business: null, staff: { accountStatus: "disabled", passwordHash: "hash" } },
    ]
    for (const scenario of cases) {
        t.mock.method(Business, "findOne", async () => scenario.business)
        t.mock.method(Staff, "findOne", async () => scenario.staff)
        const res = response()
        await loginUser({ body: { email: "person@example.com", password: "password" } }, res)
        assert.equal(res.statusCode, 401)
        assert.equal(res.body.message, "Invalid credentials")
        Business.findOne.mock.restore()
        Staff.findOne.mock.restore()
    }
})

test("valid Owner login establishes a versioned canonical session and invalid password fails", async (t) => {
    const business = {
        _id: { toString: () => OWNER_ID },
        businessId: "biz_owner",
        ownerName: "Owner",
        ownerEmail: "owner@example.com",
        ownerStatus: "active",
        ownerPasswordHash: "stored-hash",
        ownerAuthVersion: 4,
        displayName: "Owner Business",
    }
    t.mock.method(Business, "findOne", async () => business)
    t.mock.method(Staff, "findOne", async () => null)
    t.mock.method(bcrypt, "compare", async (plain) => plain === "correct password")

    const session = {
        regenerate(callback) { callback() },
        save(callback) { callback() },
    }
    const valid = response()
    await loginUser({
        body: { email: business.ownerEmail, password: "correct password" },
        session,
    }, valid)
    assert.equal(valid.statusCode, 200)
    assert.equal(session.user.businessId, business.businessId)
    assert.equal(session.ownerAuthVersion, 4)

    const invalid = response()
    await loginUser({
        body: { email: business.ownerEmail, password: "wrong password" },
        session: {},
    }, invalid)
    assert.equal(invalid.statusCode, 401)
    assert.equal(invalid.body.message, "Invalid credentials")
})

test("shared Redis login throttling applies by email and IP across middleware instances", async () => {
    const client = new SharedFakeRedis()
    const createLoginLimiter = () => createSharedSecurityRateLimit({
        scope: "auth-login",
        windowMs: 15 * 60 * 1000,
        client,
        getDimensions: (req) => [
            { name: "ip", value: getRequestIp(req), limit: 50 },
            { name: "email", value: normalizeRateLimitEmail(req.body?.email), limit: 10 },
        ],
    })
    const instanceA = createLoginLimiter()
    const instanceB = createLoginLimiter()

    for (let attempt = 1; attempt <= 10; attempt++) {
        const middleware = attempt % 2 ? instanceA : instanceB
        const result = await runMiddleware(middleware, {
            ip: `203.0.113.${attempt}`,
            body: { email: "owner@example.com" },
        })
        assert.equal(result.nextCalled, true)
    }
    const blockedOwner = await runMiddleware(instanceB, {
        ip: "203.0.113.200",
        body: { email: "OWNER@example.com" },
    })
    assert.equal(blockedOwner.res.statusCode, 429)

    for (let attempt = 1; attempt <= 10; attempt++) {
        const result = await runMiddleware(attempt % 2 ? instanceA : instanceB, {
            ip: `198.51.100.${attempt}`,
            body: { email: "active-staff@example.com" },
        })
        assert.equal(result.nextCalled, true)
    }
    const blockedStaff = await runMiddleware(instanceA, {
        ip: "198.51.100.200",
        body: { email: "active-staff@example.com" },
    })
    assert.equal(blockedStaff.res.statusCode, 429)
})

test("resend abuse is bounded by normalized email across changing IPs", async () => {
    const client = new SharedFakeRedis()
    const resendLimiter = createSharedSecurityRateLimit({
        scope: "onboarding-resend",
        windowMs: 60 * 60 * 1000,
        client,
        getDimensions: (req) => [
            { name: "ip", value: getRequestIp(req), limit: 30 },
            { name: "email", value: normalizeRateLimitEmail(req.body?.email), limit: 5 },
        ],
    })
    for (let attempt = 1; attempt <= 5; attempt++) {
        const allowed = await runMiddleware(resendLimiter, {
            ip: `192.0.2.${attempt}`,
            body: { email: attempt % 2 ? "Owner@Example.com" : "owner@example.com" },
        })
        assert.equal(allowed.nextCalled, true)
    }
    const blocked = await runMiddleware(resendLimiter, {
        ip: "192.0.2.200",
        body: { email: "owner@example.com" },
    })
    assert.equal(blocked.res.statusCode, 429)
})

test("shared limiter fails closed when Redis is unavailable", async () => {
    const limiter = createSharedSecurityRateLimit({
        scope: "test-unavailable",
        windowMs: 1_000,
        client: { isReady: false },
        getDimensions: () => [{ name: "ip", value: "127.0.0.1", limit: 1 }],
    })
    const { res, nextCalled } = await runMiddleware(limiter, { body: {} })
    assert.equal(nextCalled, false)
    assert.equal(res.statusCode, 503)
    assert.equal(res.body.code, "SECURITY_RATE_LIMIT_UNAVAILABLE")
})

test("SEC-006 routes use shared Redis controls and preserve canonical email infrastructure", async () => {
    const [authRoutes, onboardingRoutes, onboardingController, staffController, teamController] = await Promise.all([
        readFile(new URL("../src/routes/auth-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/routes/onboarding-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/controllers/onboardingController.js", import.meta.url), "utf8"),
        readFile(new URL("../src/controllers/staffController.js", import.meta.url), "utf8"),
        readFile(new URL("../src/controllers/teamController.js", import.meta.url), "utf8"),
    ])
    assert.match(authRoutes, /router\.post\("\/login", loginLimiter, loginUser\)/)
    assert.match(authRoutes, /inviteSetupLimiter/)
    assert.match(onboardingRoutes, /onboardingResendLimiter/)
    assert.match(onboardingRoutes, /onboardingVerifyLimiter/)
    assert.match(onboardingController, /sendOnboardingVerificationCode/)
    assert.match(staffController, /sendOnboardingEmail/)
    assert.match(teamController, /sendOnboardingEmail/)
})
