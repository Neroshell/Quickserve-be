export const TEST_EXTERNAL_PROVIDER_OVERRIDE =
  "ALLOW_TEST_EXTERNAL_PROVIDERS";

export class TestExternalProviderBlockedError extends Error {
  constructor(provider, target = null) {
    super(
      `Blocked external ${provider} invocation in test mode` +
      (target ? `: ${target}` : ""),
    );
    this.name = "TestExternalProviderBlockedError";
    this.code = "TEST_EXTERNAL_PROVIDER_BLOCKED";
    this.provider = provider;
    this.target = target;
  }
}

export function isTestEnvironment(env = process.env) {
  return env.NODE_ENV === "test";
}

export function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return (
    !normalized ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("127.")
  );
}

export function recordBlockedTestProviderInvocation(error) {
  const registry = globalThis.__CHILLOW_TEST_PROVIDER_BLOCKS__;
  if (Array.isArray(registry)) {
    registry.push({
      provider: error.provider,
      target: error.target,
      message: error.message,
    });
  }
}

export function assertTestExternalProviderAllowed(
  provider,
  {
    env = process.env,
    mocked = false,
    target = null,
  } = {},
) {
  if (
    !isTestEnvironment(env) ||
    env[TEST_EXTERNAL_PROVIDER_OVERRIDE] === "true" ||
    mocked
  ) {
    return;
  }

  const error = new TestExternalProviderBlockedError(provider, target);
  recordBlockedTestProviderInvocation(error);
  throw error;
}

export function assertTestNetworkTargetAllowed(
  provider,
  target,
  { env = process.env } = {},
) {
  if (
    !isTestEnvironment(env) ||
    env[TEST_EXTERNAL_PROVIDER_OVERRIDE] === "true"
  ) {
    return;
  }

  let hostname = "";
  let printableTarget = target == null ? "" : String(target);
  try {
    if (target instanceof URL) {
      hostname = target.hostname;
      printableTarget = target.toString();
    } else if (typeof target === "string") {
      const parsed = new URL(target);
      hostname = parsed.hostname;
      printableTarget = parsed.toString();
    } else if (target && typeof target === "object") {
      hostname = target.hostname || target.host || "";
      printableTarget = hostname || printableTarget;
    }
  } catch {
    // Relative URLs and socket paths have no remote host and are safe here.
    return;
  }

  if (isLoopbackHostname(hostname)) return;
  const error = new TestExternalProviderBlockedError(provider, printableTarget);
  recordBlockedTestProviderInvocation(error);
  throw error;
}
