import { RedisStore } from "connect-redis"

export const DEFAULT_TOUCH_THROTTLE_MS = 15 * 60 * 1000 // 15 minutes

/**
 * ThrottledRedisStore wraps connect-redis RedisStore to throttle passive
 * touch (EXPIRE) calls sent to Redis on every authenticated request.
 *
 * Passive session touch calls (from express-session rolling cookie behavior)
 * are forwarded to Redis at most once every 15 minutes per session.
 *
 * Explicit session mutations (req.session.save / store.set) and destructions
 * (req.session.destroy / store.destroy) bypass throttling and persist immediately.
 */
export class ThrottledRedisStore extends RedisStore {
    constructor(options = {}, { touchThrottleMs = DEFAULT_TOUCH_THROTTLE_MS } = {}) {
        super(options)
        this.touchThrottleMs = touchThrottleMs
        this.lastTouched = new Map()

        // Periodically prune stale in-memory touch timestamps (older than 8 hours)
        this.cleanupInterval = setInterval(() => {
            const now = Date.now()
            const maxAge = 8 * 60 * 60 * 1000
            for (const [sid, timestamp] of this.lastTouched.entries()) {
                if (now - timestamp > maxAge) {
                    this.lastTouched.delete(sid)
                }
            }
        }, 60 * 60 * 1000)

        if (this.cleanupInterval?.unref) {
            this.cleanupInterval.unref()
        }
    }

    async touch(sid, sess, cb) {
        const now = Date.now()
        const last = this.lastTouched.get(sid) || 0
        if (now - last < this.touchThrottleMs) {
            if (typeof cb === "function") cb(null)
            return
        }
        this.lastTouched.set(sid, now)
        return super.touch(sid, sess, cb)
    }

    async set(sid, sess, cb) {
        this.lastTouched.set(sid, Date.now())
        return super.set(sid, sess, cb)
    }

    async destroy(sid, cb) {
        this.lastTouched.delete(sid)
        return super.destroy(sid, cb)
    }
}
