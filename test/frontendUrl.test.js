import { describe, it } from "node:test";
import assert from "node:assert";
import {
    getCanonicalFrontendOrigin,
    parseAdditionalFrontendOrigins,
    getTrustedBrowserOrigins,
    normalizeExactHttpOrigin
} from "../src/config/frontendUrl.js";

describe("Frontend URL Configuration", () => {
    describe("normalizeExactHttpOrigin", () => {
        it("returns origin for valid HTTP/HTTPS URLs without paths", () => {
            assert.strictEqual(normalizeExactHttpOrigin("https://app.quickservehq.com"), "https://app.quickservehq.com");
            assert.strictEqual(normalizeExactHttpOrigin("http://localhost:3000"), "http://localhost:3000");
        });

        it("returns origin even if a trailing slash is provided", () => {
            assert.strictEqual(normalizeExactHttpOrigin("https://app.quickservehq.com/"), "https://app.quickservehq.com");
        });

        it("rejects URLs with paths, queries, or fragments", () => {
            assert.strictEqual(normalizeExactHttpOrigin("https://app.quickservehq.com/path"), null);
            assert.strictEqual(normalizeExactHttpOrigin("https://app.quickservehq.com?query=1"), null);
            assert.strictEqual(normalizeExactHttpOrigin("https://app.quickservehq.com#hash"), null);
        });

        it("rejects non-HTTP protocols", () => {
            assert.strictEqual(normalizeExactHttpOrigin("ftp://app.quickservehq.com"), null);
        });
    });

    describe("getCanonicalFrontendOrigin", () => {
        it("returns the exact origin when FRONTEND_BASE_URL is provided", () => {
            assert.strictEqual(
                getCanonicalFrontendOrigin({ FRONTEND_BASE_URL: "https://app.quickservehq.com" }),
                "https://app.quickservehq.com"
            );
        });

        it("returns localhost in non-production when FRONTEND_BASE_URL is omitted", () => {
            assert.strictEqual(getCanonicalFrontendOrigin({ NODE_ENV: "development" }), "http://localhost:3000");
        });

        it("throws an error in production if FRONTEND_BASE_URL is omitted", () => {
            assert.throws(
                () => getCanonicalFrontendOrigin({ NODE_ENV: "production" }),
                /FRONTEND_BASE_URL is required/
            );
        });

        it("throws an error if FRONTEND_BASE_URL is invalid", () => {
            assert.throws(
                () => getCanonicalFrontendOrigin({ FRONTEND_BASE_URL: "https://app.quickservehq.com/path" }),
                /must contain only exact HTTP\(S\) origins/
            );
        });

        it("generated links use the canonical origin, not a legacy domain", () => {
            const origin = getCanonicalFrontendOrigin({
                FRONTEND_BASE_URL: "https://app.quickservehq.com"
            });
            assert.strictEqual(origin, "https://app.quickservehq.com");
            // Verify a generated link would use the canonical domain
            const resetLink = `${origin}/reset-password?token=abc123`;
            assert.ok(resetLink.startsWith("https://app.quickservehq.com/"));
        });
    });

    describe("parseAdditionalFrontendOrigins", () => {
        it("returns an empty array when undefined or empty", () => {
            assert.deepStrictEqual(parseAdditionalFrontendOrigins(undefined), []);
            assert.deepStrictEqual(parseAdditionalFrontendOrigins(""), []);
            assert.deepStrictEqual(parseAdditionalFrontendOrigins("   "), []);
        });

        it("parses comma-separated origins correctly", () => {
            const result = parseAdditionalFrontendOrigins("https://staging.example.com, https://test.example.com");
            assert.deepStrictEqual(result, ["https://staging.example.com", "https://test.example.com"]);
        });

        it("throws if any of the comma-separated origins is invalid", () => {
            assert.throws(
                () => parseAdditionalFrontendOrigins("https://example.com, https://example.com/path"),
                /must contain only exact HTTP\(S\) origins/
            );
        });
    });

    describe("getTrustedBrowserOrigins", () => {
        it("canonical-only production: FRONTEND_BASE_URL without ADDITIONAL_FRONTEND_ORIGINS", () => {
            const env = {
                FRONTEND_BASE_URL: "https://app.quickservehq.com"
            };
            const origins = getTrustedBrowserOrigins(env);
            assert.ok(origins.includes("https://app.quickservehq.com"), "canonical origin present");
            assert.ok(origins.includes("http://localhost:3001"), "default backoffice present");
            assert.strictEqual(origins.length, 2, "only canonical + default backoffice");
        });

        it("multi-origin: combines FRONTEND_BASE_URL, ADDITIONAL_FRONTEND_ORIGINS, and BACKOFFICE_BASE_URL", () => {
            const env = {
                FRONTEND_BASE_URL: "https://app.quickservehq.com",
                ADDITIONAL_FRONTEND_ORIGINS: "https://staging.quickservehq.com, http://localhost:8080",
                BACKOFFICE_BASE_URL: "https://admin.quickservehq.com"
            };
            const origins = getTrustedBrowserOrigins(env);
            assert.ok(origins.includes("https://app.quickservehq.com"));
            assert.ok(origins.includes("https://staging.quickservehq.com"));
            assert.ok(origins.includes("http://localhost:8080"));
            assert.ok(origins.includes("https://admin.quickservehq.com"));
            assert.ok(origins.includes("http://localhost:3001"));
        });

        it("deduplicates origins", () => {
            const env = {
                FRONTEND_BASE_URL: "https://app.quickservehq.com",
                ADDITIONAL_FRONTEND_ORIGINS: "https://app.quickservehq.com"
            };
            const origins = getTrustedBrowserOrigins(env);
            const count = origins.filter(o => o === "https://app.quickservehq.com").length;
            assert.strictEqual(count, 1);
        });
    });
});
