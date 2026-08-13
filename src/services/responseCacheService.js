import { redisSession } from "../config/sessionRedisClient.js"

// Reuse the existing command-capable Redis connection. SSE pub/sub and BullMQ
// deliberately own dedicated connections with incompatible command lifecycles.

export const CACHE_NAMESPACE = "quickserve:v1"

export const CACHE_TTL_SECONDS = Object.freeze({
    // Defensive healing window; post-write invalidation is the freshness path.
    TENANT_STABLE: 10 * 60,
})

export const DEFAULT_CACHE_COMMAND_TIMEOUT_MS = 500
const TIMEOUT_LOG_INTERVAL_MS = 30_000

export function resolveCacheCommandTimeoutMs(env = process.env) {
    const configured = Number(env?.CACHE_COMMAND_TIMEOUT_MS)
    return Number.isInteger(configured) && configured > 0
        ? configured
        : DEFAULT_CACHE_COMMAND_TIMEOUT_MS
}

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

function timeoutAfter(client, command, timeoutMs) {
    let timer
    const abortController = new AbortController()
    const commandClient = typeof client?.withAbortSignal === "function"
        ? client.withAbortSignal(abortController.signal)
        : client
    const commandPromise = Promise.resolve().then(() => command(commandClient))
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error("Redis cache command timed out")
            error.code = "CACHE_COMMAND_TIMEOUT"
            reject(error)
            // node-redis can remove a command that is still queued. Once a
            // command is on the wire it cannot be unsent, so Promise.race is
            // still the fail-open deadline and the command is never retried.
            abortController.abort()
        }, timeoutMs)
    })

    return Promise.race([commandPromise, timeout]).finally(() => clearTimeout(timer))
}

function log(logger, level, message) {
    const writer = logger?.[level] || logger?.log
    if (typeof writer === "function") writer.call(logger, message)
}

export function createResponseCache({
    client = redisSession,
    logger = console,
    commandTimeoutMs = resolveCacheCommandTimeoutMs(),
    enabled = client !== redisSession || Boolean(process.env.REDIS_URL?.trim()),
} = {}) {
    const resolvedCommandTimeoutMs = Number.isInteger(Number(commandTimeoutMs)) && Number(commandTimeoutMs) > 0
        ? Number(commandTimeoutMs)
        : DEFAULT_CACHE_COMMAND_TIMEOUT_MS
    const timeoutLogState = new Map()

    function domainFor(keys) {
        const key = Array.isArray(keys) ? keys[0] : keys
        if (String(key).includes(":public-business:")) return "public-business"
        if (String(key).endsWith(":public-config")) return "public-config"
        if (String(key).endsWith(":setup-progress")) return "setup-progress"
        if (String(key).includes(":menu-items")) return "menu-items"
        return "unknown"
    }

    function logFailure(command, keys, error, startedAt) {
        const reason = errorCode(error)
        const domain = domainFor(keys)
        const elapsedMs = Math.max(0, Date.now() - startedAt)
        const renderedKeys = Array.isArray(keys) ? keys.join(",") : keys
        let suppression = ""

        if (reason === "CACHE_COMMAND_TIMEOUT") {
            const signature = `${command}:${domain}`
            const previous = timeoutLogState.get(signature)
            const now = Date.now()
            if (previous && now - previous.loggedAt < TIMEOUT_LOG_INTERVAL_MS) {
                previous.suppressed += 1
                return
            }
            if (previous?.suppressed) suppression = ` suppressed=${previous.suppressed}`
            timeoutLogState.set(signature, { loggedAt: now, suppressed: 0 })
        }

        log(
            logger,
            "warn",
            `[Cache] command=${command} failure domain=${domain} key=${renderedKeys} elapsedMs=${elapsedMs} timeoutMs=${resolvedCommandTimeoutMs} reason=${reason}${suppression}`,
        )
    }

    async function run(command) {
        return timeoutAfter(client, command, resolvedCommandTimeoutMs)
    }

    return {
        async get(key) {
            if (!enabled) return { hit: false, value: null }

            if (!client?.isReady) {
                log(logger, "warn", `[Cache] command=GET bypass domain=${domainFor(key)} key=${key} elapsedMs=0 timeoutMs=${resolvedCommandTimeoutMs} reason=redis_unavailable`)
                return { hit: false, value: null }
            }

            const startedAt = Date.now()
            try {
                const raw = await run(commandClient => commandClient.get(key))
                if (raw === null) {
                    log(logger, "debug", `[Cache] MISS key=${key}`)
                    return { hit: false, value: null }
                }

                const value = JSON.parse(raw)
                log(logger, "debug", `[Cache] HIT key=${key}`)
                return { hit: true, value }
            } catch (error) {
                logFailure("GET", key, error, startedAt)
                return { hit: false, value: null }
            }
        },

        async set(key, value, ttlSeconds) {
            if (!enabled) return false

            if (!client?.isReady) {
                log(logger, "warn", `[Cache] command=SET bypass domain=${domainFor(key)} key=${key} elapsedMs=0 timeoutMs=${resolvedCommandTimeoutMs} reason=redis_unavailable`)
                return false
            }

            const startedAt = Date.now()
            try {
                const ttl = Number(ttlSeconds)
                if (!Number.isInteger(ttl) || ttl < 1) {
                    throw new TypeError("Cache TTL must be a positive integer")
                }

                const serialized = JSON.stringify(value)
                await run(commandClient => commandClient.set(key, serialized, { EX: ttl }))
                return true
            } catch (error) {
                logFailure("SET", key, error, startedAt)
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
                log(logger, "warn", `[Cache] command=DEL bypass domain=${domainFor(uniqueKeys)} key=${uniqueKeys.join(",")} elapsedMs=0 timeoutMs=${resolvedCommandTimeoutMs} reason=redis_unavailable`)
                return false
            }

            const startedAt = Date.now()
            try {
                await run(commandClient => commandClient.del(uniqueKeys))
                log(logger, "debug", `[Cache] invalidated keys=${uniqueKeys.join(",")}`)
                return true
            } catch (error) {
                logFailure("DEL", uniqueKeys, error, startedAt)
                return false
            }
        },
    }
}

export const responseCache = createResponseCache()
