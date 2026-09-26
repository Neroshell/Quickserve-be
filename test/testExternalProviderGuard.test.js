import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTestExternalProviderAllowed,
  assertTestNetworkTargetAllowed,
  isLoopbackHostname,
  TestExternalProviderBlockedError,
} from "../src/utils/testExternalProviderGuard.js";
import { sendEmailWithResult } from "../src/utils/emailService.js";
import { uploadToCloudinary } from "../src/utils/uploadToCloudinary.js";

test.afterEach(() => {
  const blocks = globalThis.__CHILLOW_TEST_PROVIDER_BLOCKS__;
  if (Array.isArray(blocks)) blocks.length = 0;
});

test("test provider guard permits explicit mocks and loopback infrastructure", () => {
  const env = { NODE_ENV: "test", ALLOW_TEST_EXTERNAL_PROVIDERS: "false" };
  assert.doesNotThrow(() => assertTestExternalProviderAllowed(
    "Stripe",
    { env, mocked: true },
  ));
  assert.doesNotThrow(() => assertTestNetworkTargetAllowed(
    "Redis",
    "redis://127.0.0.1:6379",
    { env },
  ));
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("api.stripe.com"), false);
});

test("test provider guard blocks real clients and non-loopback targets", () => {
  const env = { NODE_ENV: "test", ALLOW_TEST_EXTERNAL_PROVIDERS: "false" };
  assert.throws(
    () => assertTestExternalProviderAllowed("Resend", { env }),
    (error) => (
      error instanceof TestExternalProviderBlockedError &&
      error.code === "TEST_EXTERNAL_PROVIDER_BLOCKED"
    ),
  );
  assert.throws(
    () => assertTestNetworkTargetAllowed(
      "Cloudinary",
      "https://api.cloudinary.com/v1_1/example/image/upload",
      { env },
    ),
    (error) => error.code === "TEST_EXTERNAL_PROVIDER_BLOCKED",
  );
});

test("external providers require an explicit test override", () => {
  const env = { NODE_ENV: "test", ALLOW_TEST_EXTERNAL_PROVIDERS: "true" };
  assert.doesNotThrow(() => assertTestExternalProviderAllowed("Stripe", { env }));
  assert.doesNotThrow(() => assertTestNetworkTargetAllowed(
    "Stripe",
    "https://api.stripe.com",
    { env },
  ));
});

test("email and Cloudinary boundaries allow injected mocks without network", async () => {
  const emailCalls = [];
  const emailResult = await sendEmailWithResult({
    to: "guest@example.test",
    from: "test@example.test",
    subject: "Test",
    html: "<p>Test</p>",
    emailClient: {
      emails: {
        async send(message, options) {
          emailCalls.push({ message, options });
          return { data: { id: "email-test-1" }, error: null };
        },
      },
    },
  });
  assert.equal(emailResult.messageId, "email-test-1");
  assert.equal(emailCalls.length, 1);

  const cloudinaryCalls = [];
  const upload = await uploadToCloudinary(
    Buffer.from("image"),
    "quickserve/biz-test/menu-items",
    "image/png",
    {
      cloudinaryClient: {
        uploader: {
          async upload(dataUri, options) {
            cloudinaryCalls.push({ dataUri, options });
            return {
              secure_url: "https://images.example.test/image.png",
              public_id: "biz-test/image",
            };
          },
        },
      },
    },
  );
  assert.equal(upload.public_id, "biz-test/image");
  assert.equal(cloudinaryCalls[0].options.folder, "quickserve/biz-test/menu-items");
});

test("real email and Cloudinary clients are blocked before provider I/O", async () => {
  await assert.rejects(
    () => sendEmailWithResult({
      to: "guest@example.test",
      from: "test@example.test",
      subject: "Blocked",
      html: "<p>Blocked</p>",
    }),
    (error) => error.code === "TEST_EXTERNAL_PROVIDER_BLOCKED",
  );
  await assert.rejects(
    () => uploadToCloudinary(
      Buffer.from("image"),
      "quickserve/biz-test/menu-items",
      "image/png",
    ),
    (error) => error.code === "TEST_EXTERNAL_PROVIDER_BLOCKED",
  );
});
