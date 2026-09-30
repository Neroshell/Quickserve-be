const DEVELOPMENT_FRONTEND_ORIGIN = "http://localhost:3000";
const DEVELOPMENT_BACKOFFICE_ORIGIN = "http://localhost:3001";

function invalidOriginError(name, value) {
    return new Error(
        `${name} must contain only exact HTTP(S) origins without paths, queries, fragments, or credentials: ${value}`,
    );
}

export function normalizeExactHttpOrigin(value) {
    if (typeof value !== "string" || !value.trim()) return null;

    try {
        const url = new URL(value.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        if (url.username || url.password) return null;
        if (url.pathname !== "/" || url.search || url.hash) return null;
        if (url.origin === "null") return null;
        return url.origin;
    } catch {
        return null;
    }
}

function requireExactOrigin(value, name) {
    const normalized = normalizeExactHttpOrigin(value);
    if (!normalized) throw invalidOriginError(name, value);
    return normalized;
}

export function parseAdditionalFrontendOrigins(value) {
    if (typeof value !== "string" || !value.trim()) return [];

    return value
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .map((candidate) => requireExactOrigin(candidate, "ADDITIONAL_FRONTEND_ORIGINS"));
}

export function getCanonicalFrontendOrigin(env = process.env) {
    const configured = env.FRONTEND_BASE_URL?.trim();
    if (!configured) {
        if (env.NODE_ENV === "production") {
            throw new Error("FRONTEND_BASE_URL is required in production");
        }
        return DEVELOPMENT_FRONTEND_ORIGIN;
    }

    return requireExactOrigin(configured, "FRONTEND_BASE_URL");
}

export function getTrustedBrowserOrigins(env = process.env) {
    const origins = [
        getCanonicalFrontendOrigin(env),
        DEVELOPMENT_BACKOFFICE_ORIGIN,
        ...parseAdditionalFrontendOrigins(env.ADDITIONAL_FRONTEND_ORIGINS),
    ];

    if (env.BACKOFFICE_BASE_URL?.trim()) {
        origins.push(requireExactOrigin(env.BACKOFFICE_BASE_URL, "BACKOFFICE_BASE_URL"));
    }

    return [...new Set(origins)];
}

export function createCredentialedCorsOptions(trustedOrigins) {
    return {
        origin: [...trustedOrigins],
        credentials: true,
    };
}
