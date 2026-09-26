import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import {
  assertTestNetworkTargetAllowed,
  TEST_EXTERNAL_PROVIDER_OVERRIDE,
} from "../src/utils/testExternalProviderGuard.js";

process.env.NODE_ENV = "test";
process.env[TEST_EXTERNAL_PROVIDER_OVERRIDE] =
  process.env[TEST_EXTERNAL_PROVIDER_OVERRIDE] || "false";

const safeDefaults = {
  RESEND_API_KEY: "re_test_provider_disabled",
  STRIPE_SECRET_KEY: "sk_test_provider_disabled",
  STRIPE_WEBHOOK_SECRET: "whsec_test_provider_disabled",
  CLOUDINARY_CLOUD_NAME: "test-provider-disabled",
  CLOUDINARY_API_KEY: "test-provider-disabled",
  CLOUDINARY_API_SECRET: "test-provider-disabled",
  REDIS_URL: "",
  BULLMQ_ENABLED: "false",
  BULLMQ_EMAILS_ENABLED: "false",
};
for (const [name, value] of Object.entries(safeDefaults)) {
  if (!(name in process.env)) process.env[name] = value;
}

globalThis.__CHILLOW_TEST_PROVIDER_BLOCKS__ = [];

function targetFromArguments(args) {
  const first = args[0];
  if (first instanceof URL || typeof first === "string") return first;
  if (first && typeof first === "object") return first;
  if (typeof args[1] === "string") {
    return { host: args[1] };
  }
  return { host: "localhost" };
}

function guardFunction(target, methodName, provider) {
  const original = target[methodName];
  target[methodName] = function guardedExternalNetworkCall(...args) {
    assertTestNetworkTargetAllowed(provider, targetFromArguments(args));
    return Reflect.apply(original, this, args);
  };
}

guardFunction(net, "connect", "TCP");
guardFunction(net, "createConnection", "TCP");
guardFunction(tls, "connect", "TLS");
guardFunction(http, "request", "HTTP");
guardFunction(http, "get", "HTTP");
guardFunction(https, "request", "HTTPS");
guardFunction(https, "get", "HTTPS");

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    assertTestNetworkTargetAllowed("fetch", input);
    return Reflect.apply(originalFetch, globalThis, [input, init]);
  };
}

process.on("beforeExit", () => {
  const blocks = globalThis.__CHILLOW_TEST_PROVIDER_BLOCKS__;
  if (!Array.isArray(blocks) || blocks.length === 0) return;
  console.error(
    `[TestIsolation] Blocked ${blocks.length} external provider invocation(s). Tests must inject a mock or explicitly set ${TEST_EXTERNAL_PROVIDER_OVERRIDE}=true.`,
  );
  process.exitCode = 1;
});
