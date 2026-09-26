/**
 * ARCH-010: Process-aware environment configuration validation.
 *
 * Validates that mandatory environment variables are present based on the
 * process role (api | worker) and the current NODE_ENV.
 *
 * Production deployments fail immediately and explicitly when mandatory
 * configuration is missing — preventing silent localhost fallbacks.
 *
 * Development environments retain safe defaults where intentional.
 */

// ── Variable Definitions ────────────────────────────────────────────────────

/**
 * Variables required in production for the API process.
 * Each entry: [envName, humanDescription]
 */
const API_PRODUCTION_REQUIRED = [
    ["MONGODB_URI", "MongoDB connection string"],
    ["REDIS_URL", "Redis URL for sessions and caching"],
    ["SESSION_SECRET", "Session cookie signing secret"],
    ["STRIPE_SECRET_KEY", "Stripe secret key"],
    ["STRIPE_WEBHOOK_SECRET", "Stripe webhook signing secret"],
    ["FRONTEND_BASE_URL", "Frontend origin for CORS and email links"],
];

/**
 * Variables required in production for the worker process.
 * The worker does not serve HTTP traffic, does not use sessions,
 * and does not validate Stripe webhooks.
 */
const WORKER_PRODUCTION_REQUIRED = [
    ["MONGODB_URI", "MongoDB connection string"],
    ["REDIS_URL", "Redis URL for BullMQ connections"],
];

// ── BullMQ Feature → Worker Requirement Map ─────────────────────────────────

/**
 * Maps each BullMQ feature flag to the env variable name that enables it.
 * When any of these flags are "true", a separately running worker process
 * is required to actually process the jobs.
 */
export const BULLMQ_FEATURES_REQUIRING_WORKER = [
    { flag: "BULLMQ_EMAILS_ENABLED", label: "Transactional emails (Phase 1)" },
    { flag: "BULLMQ_RESERVATION_SCHEDULERS_ENABLED", label: "Reservation schedulers (Phase 2)" },
    { flag: "BULLMQ_BILLING_SCHEDULERS_ENABLED", label: "Billing lifecycle (Phase 2)" },
    { flag: "BULLMQ_POST_PAYMENT_ENABLED", label: "Post-payment CRM (Phase 3)" },
    { flag: "BULLMQ_INVENTORY_SCHEDULERS_ENABLED", label: "Inventory reconciliation (Phase 4)" },
    { flag: "BULLMQ_NOTIFICATIONS_ENABLED", label: "Notification delivery (Phase 5)" },
    { flag: "AI_ANALYST_WEEKLY_ENABLED", label: "AI Analyst weekly reports" },
];

// ── Core Validation ─────────────────────────────────────────────────────────

/**
 * Validates environment configuration for the given process role.
 *
 * @param {"api" | "worker"} role — which process is starting
 * @param {Record<string, string>} [env=process.env]
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateEnvironment(role, env = process.env) {
    const errors = [];
    const warnings = [];
    const isProduction = env.NODE_ENV === "production";

    // Select the required variables based on process role
    const required = role === "worker"
        ? WORKER_PRODUCTION_REQUIRED
        : API_PRODUCTION_REQUIRED;

    if (isProduction) {
        for (const [name, description] of required) {
            if (!env[name]?.trim()) {
                errors.push(`Missing required env: ${name} — ${description}`);
            }
        }
    }

    // Warn about unsafe defaults in production
    if (isProduction && env.SESSION_SECRET === "dev-secret-quickserve-123") {
        errors.push("SESSION_SECRET is set to the development default in production");
    }

    // Worker-specific: BullMQ must be enabled
    if (role === "worker") {
        if (env.BULLMQ_ENABLED !== "true") {
            errors.push("BULLMQ_ENABLED must be 'true' for the worker process");
        }
        if (isProduction && !env.REDIS_URL?.trim()) {
            errors.push("REDIS_URL is required for BullMQ worker connections");
        }
    }

    // API-specific: warn about enabled BullMQ features that need a worker
    if (role === "api" && env.BULLMQ_ENABLED === "true") {
        const enabledFeatures = BULLMQ_FEATURES_REQUIRING_WORKER
            .filter(({ flag }) => env[flag] === "true")
            .map(({ label }) => label);

        if (enabledFeatures.length > 0) {
            warnings.push(
                `BullMQ features enabled that require a separately running worker process: ${enabledFeatures.join(", ")}. ` +
                `Ensure 'npm run worker' is running.`
            );
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

/**
 * Validates environment and exits the process if production validation fails.
 * Logs warnings in all environments.
 *
 * @param {"api" | "worker"} role
 * @param {Record<string, string>} [env=process.env]
 */
export function assertEnvironment(role, env = process.env) {
    const result = validateEnvironment(role, env);

    for (const warning of result.warnings) {
        console.warn(`[Config] ⚠️  ${warning}`);
    }

    if (!result.valid) {
        console.error("[Config] ❌ Environment validation failed:");
        for (const error of result.errors) {
            console.error(`  - ${error}`);
        }
        process.exit(1);
    }

    console.log(`[Config] ✅ Environment validated for ${role} process`);
}
