import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import guestProfileRoutes from "../src/routes/guestProfileRoutes.js"
import { createCrmAnalyticsController } from "../src/controllers/guestProfileController.js"
import { AnalyticsRangeError } from "../src/services/analytics/analyticsRangeService.js"

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

test("CRM analytics controller trusts only the authenticated tenant", async () => {
    const calls = []
    const controller = createCrmAnalyticsController({
        async getAnalytics(input) {
            calls.push(input)
            return { contractVersion: 1 }
        },
    })
    const response = createResponse()

    await controller(
        {
            session: { user: { businessId: "biz_session" } },
            query: {
                businessId: "biz_attacker",
                range: "custom",
                from: "2026-08-01",
                to: "2026-08-02",
            },
        },
        response,
    )

    assert.equal(response.statusCode, 200)
    assert.deepEqual(calls, [
        {
            businessId: "biz_session",
            range: "custom",
            from: "2026-08-01",
            to: "2026-08-02",
        },
    ])
})

test("CRM analytics controller rejects missing auth and preserves range errors", async () => {
    const unauthorized = createResponse()
    const controller = createCrmAnalyticsController({
        async getAnalytics() {
            throw new Error("must not be called")
        },
    })
    await controller({ session: {}, query: {} }, unauthorized)
    assert.equal(unauthorized.statusCode, 401)

    const invalid = createResponse()
    const invalidController = createCrmAnalyticsController({
        async getAnalytics() {
            throw new AnalyticsRangeError("Invalid custom range")
        },
    })
    await invalidController(
        {
            session: { user: { businessId: "biz_alpha" } },
            query: { range: "custom" },
        },
        invalid,
    )
    assert.equal(invalid.statusCode, 400)
    assert.deepEqual(invalid.body, { error: "Invalid custom range" })
})

test("/analytics is registered before /:guestId and inherits CRM guards", async () => {
    const paths = guestProfileRoutes.stack
        .filter((layer) => layer.route)
        .map((layer) => layer.route.path)
    assert.ok(paths.indexOf("/analytics") < paths.indexOf("/:guestId"))

    const server = await readFile(new URL("../server.js", import.meta.url), "utf8")
    const route = await readFile(
        new URL("../src/routes/guestProfileRoutes.js", import.meta.url),
        "utf8",
    )
    assert.match(server, /requirePermission\(PERMISSIONS\.CRM_VIEW\)/)
    assert.match(server, /requireRole\("owner", "co_owner", "manager"\)/)
    assert.match(route, /router\.use\(requireEntitlement\("crm"\)\)/)
})

