import session from "express-session"
import { ThrottledRedisStore } from "./throttledRedisStore.js"
import { redisSession } from "./sessionRedisClient.js"

export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000 // 8 hours
export const SESSION_TTL_SECONDS = 8 * 60 * 60 // 28800 seconds

export const sessionMiddleware = session({
    store: new ThrottledRedisStore({ 
        client: redisSession, 
        prefix: "qs:sess:",
        ttl: SESSION_TTL_SECONDS,
    }),
    name: "qs_dashboard_session",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // Refreshes the browser cookie while RedisStore.touch() is throttled to 15m
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production", // requires trust proxy in express
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: SESSION_MAX_AGE_MS,
    }
})
