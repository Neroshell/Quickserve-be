import { redisSession } from "../config/sessionRedisClient.js"

// Reuse the existing command-capable Redis connection. SSE pub/sub and BullMQ
// deliberately own dedicated connections with incompatible command lifecycles.

export const CACHE_NAMESPACE = "quickserve:v1"

export const CACHE_TTL_SECONDS = Object.freeze({
    // Defensive healing window; post-write invalidation is the freshness path.
    TENANT_STABLE: 10 * 60,
})

const DEFAULT_COMMAND_TIMEOUT_MS = 150

function keySegment(value, name) {
    const normalized = String(value ?? "").trim()
    if (!normalized) {
        throw new TypeError(`${name} is required to build a cache key`)
    }
    return encodeURIComponent(normalized)
}

function publicRouteSegment(value, name) {
    return keySegment(String(value ?? "").trim().toLowerCase(), name)
}

function businessPrefix(businessId) {
    return `${CACHE_NAMESPACE}:business:${keySegment(businessId, "businessId")}`
}

export const cacheKeys = Object.freeze({
    setupProgress(businessId) {
        return `${businessPrefix(businessId)}:setup-progress`
    },

    publicBusinessConfig(businessId) {
        return `${businessPrefix(businessId)}:public-config`
    },

    publicBusiness(countryCode, slug) {
        return `${CACHE_NAMESPACE}:public-business:${publicRouteSegment(countryCode, "countryCode")}:${publicRouteSegment(slug, "slug")}`
    },

    menuItems(businessId, { owner = false } = {}) {
        const baseKey = `${businessPrefix(businessId)}:menu-items`
        return owner ? `${baseKey}:owner` : baseKey
    },

    menuItemVariants(businessId) {
        const baseKey = `${businessPrefix(businessId)}:menu-items`
        return [
            baseKey,
            `${baseKey}:owner`,
        ]
    },
})

function errorCode(error) {
    return error?.code || error?.name || "cache_error"
}

function timeoutAfter(promise, timeoutMs) {
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error("Redis cache command timed out")
            error.code = "CACHE_COMMAND_TIMEOUT"
            reject(error)
        }, timeoutMs)
    })

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function log(logger, level, message) {
    const writer = logger?.[level] || logger?.log
    if (typeof writer === "function") writer.call(logger, message)
}

export function createResponseCache({
    client = redisSession,
    logger = console,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    enabled = client !== redisSession || Boolean(process.env.REDIS_URL?.trim()),
} = {}) {
    async function run(command) {
        return timeoutAfter(Promise.resolve().then(command), commandTimeoutMs)
    }

    return {
        async get(key) {
            if (!enabled) return { hit: false, value: null }

            if (!client?.isReady) {
                log(logger, "warn", `[Cache] GET failure key=${key} reason=redis_unavailable`)
                return { hit: false, value: null }
            }

            try {
                const raw = await run(() => client.get(key))
                if (raw === null) {
                    log(logger, "debug", `[Cache] MISS key=${key}`)
                    return { hit: false, value: null }
                }

                const value = JSON.parse(raw)
                log(logger, "debug", `[Cache] HIT key=${key}`)
                return { hit: true, value }
            } catch (error) {
                log(logger, "warn", `[Cache] GET failure key=${key} reason=${errorCode(error)}`)
                return { hit: false, value: null }
            }
        },

        async set(key, value, ttlSeconds) {
            if (!enabled) return false

            if (!client?.isReady) {
                log(logger, "warn", `[Cache] SET failure key=${key} reason=redis_unavailable`)
                return false
            }

            try {
                const ttl = Number(ttlSeconds)
                if (!Number.isInteger(ttl) || ttl < 1) {
                    throw new TypeError("Cache TTL must be a positive integer")
                }

                const serialized = JSON.stringify(value)
                await run(() => client.set(key, serialized, { EX: ttl }))
                return true
            } catch (error) {
                log(logger, "warn", `[Cache] SET failure key=${key} reason=${errorCode(error)}`)
                return false
            }
        },

        async del(key) {
            return this.delMany([key])
        },

        async delMany(keys) {
            const uniqueKeys = [...new Set((keys || []).filter(Boolean))]
            if (uniqueKeys.length === 0) return true
            if (!enabled) return false

            if (!client?.isReady) {
                log(
                    logger,
                    "warn",
                    `[Cache] invalidation failure keys=${uniqueKeys.join(",")} reason=redis_unavailable`,
                )
                return false
            }

            try {
                await run(() => client.del(uniqueKeys))
                log(logger, "debug", `[Cache] invalidated keys=${uniqueKeys.join(",")}`)
                return true
            } catch (error) {
                log(
                    logger,
                    "warn",
                    `[Cache] invalidation failure keys=${uniqueKeys.join(",")} reason=${errorCode(error)}`,
                )
                return false
            }
        },
    }
}

export const responseCache = createResponseCache()
