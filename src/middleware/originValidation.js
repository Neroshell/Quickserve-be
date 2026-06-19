// Origin validation — CSRF defense-in-depth (OWASP "verify origin" pattern).
//
// For state-changing requests (POST/PUT/PATCH/DELETE) that may carry the session
// cookie, we verify the browser-supplied Origin (or Referer fallback) against an
// allowlist. A cross-site page can't forge these headers, so a forged request
// from evil.com is rejected before it reaches any controller.
//
// Notes:
//  - Safe methods (GET/HEAD/OPTIONS) are skipped — they don't change state, and
//    OPTIONS is the CORS preflight.
//  - Requests with NO Origin/Referer are allowed: browsers always send Origin on
//    cross-site state-changing requests, so a missing value means a non-browser
//    caller (server-to-server, curl, mobile) where CSRF doesn't apply. The Stripe
//    webhook (no Origin, signature-verified) is also registered before this runs.
//  - This is a complement to, not a replacement for, CSRF tokens (added later).

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function originFromReferer(referer) {
    try {
        return new URL(referer).origin
    } catch {
        return null
    }
}

export function validateOrigin(allowedOrigins = []) {
    const allow = new Set(allowedOrigins.filter(Boolean))

    return (req, res, next) => {
        if (SAFE_METHODS.has(req.method)) return next()

        const headerOrigin = req.get("origin")
        const referer = req.get("referer")
        const origin = headerOrigin || (referer ? originFromReferer(referer) : null)

        // No browser-controlled origin info → not a CSRF vector (non-browser client).
        if (!origin) return next()

        if (!allow.has(origin)) {
            console.warn(`[originValidation] Blocked ${req.method} ${req.originalUrl} from origin: ${origin}`)
            return res.status(403).json({ message: "Request origin not allowed." })
        }

        return next()
    }
}
