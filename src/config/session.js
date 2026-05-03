import session from "express-session"
import { RedisStore } from "connect-redis"
import { redisSession } from "./sessionRedisClient.js"

export const sessionMiddleware = session({
    store: new RedisStore({ 
        client: redisSession, 
        prefix: "qs:sess:" 
    }),
    name: "qs_dashboard_session",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // 🟢 FIX: Refreshes the cookie & Redis TTL on every user activity
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production", // requires trust proxy in express
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", // NOTE: change to "none" if frontend & backend are on completely different domains
        maxAge: 8 * 60 * 60 * 1000 // 8 hours
    }
})

