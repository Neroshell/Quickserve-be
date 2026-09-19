import crypto from "node:crypto"

const TOKEN_PREFIX = "qsp1"
const TOKEN_PATTERN = /^qsp1\.[A-Za-z0-9_-]{43}$/
const TOKEN_PURPOSE = "quickserve:guest-session-qr:v1"

export class ServicePointQrCapabilityConfigurationError extends Error {
    constructor(message) {
        super(message)
        this.name = "ServicePointQrCapabilityConfigurationError"
        this.code = "SERVICE_POINT_QR_CAPABILITY_SECRET_MISSING"
    }
}

export function getServicePointQrCapabilitySecret(env = process.env) {
    const secret = String(env.QR_CAPABILITY_SIGNING_SECRET || "")
    if (secret.length < 32) {
        throw new ServicePointQrCapabilityConfigurationError(
            "QR_CAPABILITY_SIGNING_SECRET must contain at least 32 characters"
        )
    }
    return secret
}

export function normalizeServicePointQrCapabilityVersion(value) {
    if (value === null || value === undefined || value === "") return 1
    const version = Number(value)
    if (!Number.isSafeInteger(version) || version < 1) {
        throw new TypeError("QR capability version must be a positive safe integer")
    }
    return version
}

function canonicalScope({ businessId, servicePointId, version }) {
    const tenantId = String(businessId || "").trim()
    const pointId = String(servicePointId || "").trim()
    const normalizedVersion = normalizeServicePointQrCapabilityVersion(version)
    if (!tenantId || !pointId) {
        throw new TypeError("QR capability scope is incomplete")
    }
    return JSON.stringify([
        TOKEN_PURPOSE,
        tenantId,
        pointId,
        normalizedVersion,
    ])
}

export function createServicePointQrCapability(
    scope,
    { env = process.env } = {}
) {
    const secret = getServicePointQrCapabilitySecret(env)
    const signature = crypto
        .createHmac("sha256", secret)
        .update(canonicalScope(scope))
        .digest("base64url")
    return `${TOKEN_PREFIX}.${signature}`
}

export function isServicePointQrCapabilityWellFormed(capability) {
    return TOKEN_PATTERN.test(String(capability || ""))
}

export function servicePointQrCapabilityMatches(
    capability,
    scope,
    { env = process.env } = {}
) {
    if (!isServicePointQrCapabilityWellFormed(capability)) return false

    let expected
    try {
        expected = createServicePointQrCapability(scope, { env })
    } catch (error) {
        if (error?.code === "SERVICE_POINT_QR_CAPABILITY_SECRET_MISSING") {
            throw error
        }
        return false
    }

    const suppliedBuffer = Buffer.from(String(capability))
    const expectedBuffer = Buffer.from(expected)
    return suppliedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
}

