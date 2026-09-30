import { describe, it } from "node:test";
import assert from "node:assert";
import { validateOrigin } from "../src/middleware/originValidation.js";

describe("Origin/Referer Middleware Integration", () => {
    it("canonical-only: accepts the canonical origin and rejects malicious domains", () => {
        // Production configuration: only the canonical frontend origin
        const origins = ["https://app.quickservehq.com"];
        const middleware = validateOrigin(origins);

        const runMiddleware = (headers) => {
            let nextCalled = false;
            let statusCalled = null;
            const req = {
                method: "POST",
                originalUrl: "/api/test",
                get: (name) => headers[name.toLowerCase()]
            };
            const res = {
                status: (code) => {
                    statusCalled = code;
                    return { json: () => {} };
                }
            };
            const next = () => { nextCalled = true; };

            middleware(req, res, next);
            return { nextCalled, statusCalled };
        };

        // ACCEPT canonical origin:
        const t1 = runMiddleware({ origin: "https://app.quickservehq.com" });
        assert.strictEqual(t1.nextCalled, true, "Should accept exact canonical origin");

        // ACCEPT referer with canonical origin:
        const t2 = runMiddleware({ referer: "https://app.quickservehq.com/owner/settings" });
        assert.strictEqual(t2.nextCalled, true, "Should accept referer matching canonical origin");

        // REJECT malicious origins:
        const t3 = runMiddleware({ origin: "https://evil.quickservehq.com" });
        assert.strictEqual(t3.statusCalled, 403, "Should reject arbitrary subdomain");

        const t4 = runMiddleware({ origin: "https://quickservehq.com.evil.com" });
        assert.strictEqual(t4.statusCalled, 403, "Should reject suffix domain");

        const t5 = runMiddleware({ origin: "https://evilquickservehq.com" });
        assert.strictEqual(t5.statusCalled, 403, "Should reject prefix domain");

        const t6 = runMiddleware({ origin: "https://attacker.com" });
        assert.strictEqual(t6.statusCalled, 403, "Should reject attacker domain");

        // Missing Origin/Referer — non-browser client (preserved behavior):
        const t7 = runMiddleware({});
        assert.strictEqual(t7.nextCalled, true, "Missing Origin/Referer is allowed (non-browser client)");
    });

    it("safe methods bypass origin validation", () => {
        const middleware = validateOrigin(["https://app.quickservehq.com"]);

        for (const method of ["GET", "HEAD", "OPTIONS"]) {
            let nextCalled = false;
            const req = {
                method,
                originalUrl: "/api/test",
                get: () => "https://attacker.com"
            };
            const res = {
                status: () => ({ json: () => {} })
            };
            middleware(req, res, () => { nextCalled = true; });
            assert.strictEqual(nextCalled, true, `${method} should bypass origin check`);
        }
    });

    it("credentialed CORS options include the origin array and credentials: true", () => {
        // Inline test of createCredentialedCorsOptions to confirm credentials are enabled
        const { createCredentialedCorsOptions } = await import("../src/config/frontendUrl.js");
        const origins = ["https://app.quickservehq.com", "http://localhost:3001"];
        const opts = createCredentialedCorsOptions(origins);
        assert.deepStrictEqual(opts.origin, origins);
        assert.strictEqual(opts.credentials, true);
    });
});
