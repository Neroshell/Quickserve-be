import rateLimit from "express-rate-limit"

export function createAddressSearchLimiter() {
    return rateLimit({
        windowMs: 60 * 1000,
        limit: 60,
        standardHeaders: "draft-8",
        legacyHeaders: false,
    })
}