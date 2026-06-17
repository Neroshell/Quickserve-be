// Platform Admin authentication — QuickServe internal backoffice only.
//
// This is COMPLETELY SEPARATE from tenant auth (owner/manager/staff sessions).
// Backoffice users authenticate with Supabase (Google Auth) on the frontend and
// send their Supabase access token as a Bearer token on every /admin request:
//
//   Authorization: Bearer <supabase_access_token>
//
// We verify that token against Supabase's auth server and then check the
// resolved email against an explicit allowlist (PLATFORM_ADMIN_EMAILS).
//
// Required backend env:
//   SUPABASE_URL=...
//   SUPABASE_SERVICE_ROLE_KEY=...        (used only as the apikey for verification; never sent to FE)
//   PLATFORM_ADMIN_EMAILS=a@x.com,b@y.com

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function getAllowedAdminEmails() {
    return (process.env.PLATFORM_ADMIN_EMAILS || "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
}

// Small in-process cache so we don't hit Supabase on every single request.
// Keyed by token; stores the resolved email with a short TTL.
const TOKEN_CACHE_TTL_MS = 60 * 1000
const tokenCache = new Map() // token -> { email, expiresAt }

async function verifySupabaseToken(token) {
    const cached = tokenCache.get(token)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.email
    }

    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
            apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
    })

    if (!resp.ok) {
        return null
    }

    const user = await resp.json()
    const email = (user?.email || "").trim().toLowerCase()
    if (!email) return null

    tokenCache.set(token, { email, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS })
    return email
}

export async function requirePlatformAdmin(req, res, next) {
    try {
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
            console.error("[platformAdminAuth] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured")
            return res.status(500).json({ message: "Admin authentication is not configured." })
        }

        const header = req.get("authorization") || ""
        const match = header.match(/^Bearer\s+(.+)$/i)
        if (!match) {
            return res.status(401).json({ message: "Unauthorized. Missing admin bearer token." })
        }
        const token = match[1].trim()

        const email = await verifySupabaseToken(token)
        if (!email) {
            return res.status(401).json({ message: "Unauthorized. Invalid or expired admin token." })
        }

        const allowed = getAllowedAdminEmails()
        if (!allowed.includes(email)) {
            return res.status(403).json({ message: "Forbidden. Not an authorized platform admin." })
        }

        // Attach the verified platform-admin identity (kept distinct from req.session.user).
        req.platformAdmin = { email }
        next()
    } catch (err) {
        console.error("[platformAdminAuth] verification error:", err)
        return res.status(401).json({ message: "Unauthorized." })
    }
}
