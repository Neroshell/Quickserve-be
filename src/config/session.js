import session from "express-session"
import { RedisStore } from "connect-redis"
import { redisSession } from "./sessionRedisClient.js"

export const sessionMiddleware = session({
    store: new RedisStore({ 
        client: redisSession, 
        prefix: "qs:sess:" 
    }),
    name: "qs_dashboard_session",
    secret: process.env.SESSION_SECRET || "fallback-secret-for-dev-quickserve",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production", // requires trust proxy in express
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000 // 8 hours
    }
})
