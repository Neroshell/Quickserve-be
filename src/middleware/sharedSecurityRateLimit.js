import crypto from "node:crypto"
import { redisSession } from "../config/sessionRedisClient.js"

const RATE_LIMIT_PREFIX = "qs:security-rate:v1"

// One Redis command updates every supplied dimension atomically. A counter's
// TTL is set only when the window starts, so repeated requests cannot extend it
// into a permanent account lockout.
const CONSUME_RATE_LIMIT_SCRIPT = `
local blocked = 0
local retry_after_ms = 0
for index, key in ipairs(KEYS) do
  local count = redis.call("INCR", key)
  if count == 1 then
    redis.call("PEXPIRE", key, ARGV[1])
  end
  local ttl = redis.call("PTTL", key)
  if ttl > retry_after_ms then
    retry_after_ms = ttl
  end
  if count > tonumber(ARGV[index + 1]) then
    blocked = 1
  end
end
return { blocked, retry_after_ms }
`

function digestIdentifier(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex")
}

export function normalizeRateLimitEmail(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : ""
}

export function getRequestIp(req) {
    return String(req.ip || req.socket?.remoteAddress || "unknown")
}

export async function consumeSecurityRateLimit({
    scope,
    windowMs,
    dimensions,
    client = redisSession,
}) {
    if (!client?.isReady && !client?.__securityRateLimitTestClient) {
        throw new Error("Shared rate-limit Redis is unavailable")
    }

    const usableDimensions = dimensions.filter(({ value }) => value !== undefined && value !== null && String(value) !== "")
    if (!scope || !Number.isSafeInteger(windowMs) || windowMs <= 0 || usableDimensions.length === 0) {
        throw new TypeError("Invalid shared security rate-limit configuration")
    }

    const keys = usableDimensions.map(({ name, value }) => (
        `${RATE_LIMIT_PREFIX}:${scope}:${name}:${digestIdentifier(value)}`
    ))
    const limits = usableDimensions.map(({ limit }) => {
        const parsed = Number(limit)
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
            throw new TypeError("Invalid shared security rate-limit dimension")
        }
        return String(parsed)
    })

    const result = await client.eval(CONSUME_RATE_LIMIT_SCRIPT, {
        keys,
        arguments: [String(windowMs), ...limits],
    })
    const blocked = Number(result?.[0]) === 1
    const retryAfterMs = Math.max(0, Number(result?.[1]) || windowMs)
    return { blocked, retryAfterMs }
}

export function createSharedSecurityRateLimit({
    scope,
    windowMs,
    getDimensions,
    message = "Too many attempts. Please try again later.",
    client = redisSession,
}) {
    return async function sharedSecurityRateLimit(req, res, next) {
        try {
            const dimensions = getDimensions(req)
            const result = await consumeSecurityRateLimit({ scope, windowMs, dimensions, client })
            if (!result.blocked) return next()

            const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000))
            res.set?.("Retry-After", String(retryAfterSeconds))
            return res.status(429).json({
                message,
                code: "RATE_LIMITED",
                retryAfterSeconds,
            })
        } catch (error) {
            console.error(`[security-rate-limit] ${scope} unavailable:`, error.message)
            return res.status(503).json({
                message: "Security checks are temporarily unavailable. Please try again shortly.",
                code: "SECURITY_RATE_LIMIT_UNAVAILABLE",
            })
        }
    }
}

