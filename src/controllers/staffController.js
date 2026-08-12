import Staff from "../models/Staff.js"
import crypto from "crypto"
import { sendOnboardingEmail } from "../utils/emailService.js"
import { hashToken } from "../utils/tokenHash.js"
import { assertEmailAvailable, isEmailAlreadyInUseError, normalizeAccountEmail, sendEmailInUseResponse } from "../utils/emailAvailability.js"
import { invalidateSetupProgress } from "../services/cacheInvalidationService.js"

const ALLOWED_ROLES = ["waiter", "kitchen", "manager", "bartender"]

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve business identity from request — accepts businessId (preferred) or
 * businessId (legacy fallback) from either query string or body.
 */
function resolveBusinessId(req) {
    return (
        req.session?.user?.businessId ||
        req.query.businessId ||
        req.query.businessId || // legacy fallback
        req.body?.businessId ||
        req.body?.businessId
    )
}

/**
 * Generate a unique STF-XXXX staffId for the given business.
 * Retries up to 10 times to avoid collisions.
 */
async function generateStaffId(businessId) {
    for (let i = 0; i < 10; i++) {
        const num = Math.floor(1000 + Math.random() * 9000) // 4-digit number
        const staffId = `STF-${num}`
        const exists = await Staff.findOne({ businessId, staffId })
        if (!exists) return staffId
    }
    // Fallback to timestamp-based ID if all randoms collide
    return `STF-${Date.now().toString().slice(-6)}`
}

// ─── Staff Management (New unified API) ──────────────────────────────────────

/**
 * Get all staff for a business
 * GET /owner/staff?businessId=...&role=waiter|kitchen|manager&status=active|offline
 */
export async function getStaff(req, res) {
    try {
        const { role, status } = req.query
        const businessId = resolveBusinessId(req)

        if (!businessId) {
            return res.status(400).json({ error: "businessId is required" })
        }

        const filter = { businessId }

        // Role filter — set by card selection, never free-text
        if (role && role !== "all" && ALLOWED_ROLES.includes(role)) {
            filter.role = role
        } else {
            // Exclude business access roles like co_owner from standard operational staff lists
            filter.role = { $in: ALLOWED_ROLES }
        }

        // Presence status filter
        if (status && status !== "all") {
            filter.presenceStatus = status
        }

        const staff = await Staff.find(filter, {
            __v: 0,
            passwordHash: 0,
            inviteToken: 0,
            inviteTokenExpires: 0
        }).sort({ createdAt: -1 })

        // Shape response: always expose staffId, role on each record
        const result = staff.map((s) => ({
            staffId: s.staffId,
            staffId: s.staffId,   // backward compat
            role: s.role,
            name: s.name,
            email: s.email,
            accountStatus: s.accountStatus,
            presenceStatus: s.presenceStatus,
            businessId: s.businessId,
            businessId: s.businessId, // legacy alias
            createdAt: s.createdAt,
            updatedAt: s.updatedAt
        }))

        return res.json(result)
    } catch (err) {
        console.error("[getStaff]", err)
        return res.status(500).json({ error: "Failed to fetch staff" })
    }
}

/**
 * Create a new staff member
 * POST /owner/staff?businessId=...
 * Body: { staffId?, name, email, role }
 *
 * role comes from the card UI selection — not a free-text field.
 * staffId is auto-generated (STF-XXXX) if not provided.
 */
export async function createStaff(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        let { staffId, name, email, role } = req.body

        if (!businessId) {
            return res.status(400).json({ error: "businessId is required" })
        }

        if (!name || !email) {
            return res.status(400).json({ error: "name and email are required" })
        }

        // Validate role (was selected via card UI — not free-text)
        if (!role || !ALLOWED_ROLES.includes(role)) {
            return res.status(400).json({
                error: `Invalid role. Must be one of: ${ALLOWED_ROLES.join(", ")}`
            })
        }

        email = normalizeAccountEmail(email)
        if (!email) {
            return res.status(400).json({ error: "A valid email is required" })
        }

        try {
            await assertEmailAvailable(email)
        } catch (err) {
            if (isEmailAlreadyInUseError(err)) {
                return sendEmailInUseResponse(res)
            }
            throw err
        }

        // Auto-generate staffId if omitted
        if (!staffId || !staffId.trim()) {
            staffId = await generateStaffId(businessId)
        } else {
            staffId = staffId.trim().toUpperCase()
        }

        // Validate staffId format (must start with STF, WTR, KIT, BAR, or MGR)
        if (!/^(STF|WTR|KIT|BAR|MGR)-[A-Z0-9]{4,}$/i.test(staffId)) {
            return res.status(400).json({
                error: "staffId must follow the format WTR-XXXX, KIT-XXXX, BAR-XXXX, MGR-XXXX, or STF-XXXX."
            })
        }

        // Uniqueness checks
        const existingStaffId = await Staff.findOne({ businessId, staffId })
        if (existingStaffId) {
            return res.status(409).json({
                message: "A staff member with this ID already exists in your business."
            })
        }

        // Generate secure invite token
        const inviteToken = crypto.randomBytes(32).toString("hex")
        const inviteTokenExpires = new Date(Date.now() + 48 * 60 * 60 * 1000) // 48 hours

        const staff = await Staff.create({
            businessId,
            businessId: businessId, // legacy alias required by old waiters collection indexes
            staffId,
            staffId: staffId, // populate staffId for backward compat
            role,
            name,
            email,
            accountStatus: "pending",
            presenceStatus: "offline",
            status: "offline",
            inviteToken: hashToken(inviteToken), // store hash; raw token only goes in the email
            inviteTokenExpires
        })

        await invalidateSetupProgress(businessId)

        // Send invitation email
        const frontendUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000"
        const inviteLink = `${frontendUrl}/staff/setup-account?token=${inviteToken}`

        sendOnboardingEmail({ to: staff.email, userName: staff.name, inviteLink, role: "staff" }).catch((err) => {
            console.error("[createStaff] Email failed:", err)
        })

        return res.status(201).json({
            staffId: staff.staffId,
            staffId: staff.staffId,
            role: staff.role,
            name: staff.name,
            email: staff.email,
            accountStatus: staff.accountStatus,
            presenceStatus: staff.presenceStatus,
            businessId: staff.businessId,
            businessId: staff.businessId, // legacy alias
            createdAt: staff.createdAt
        })
    } catch (err) {
        console.error("[createStaff]", err)
        return res.status(500).json({ error: "Failed to create staff member", details: err.message })
    }
}

/**
 * Remove a staff member
 * DELETE /owner/staff/:staffId?businessId=...
 */
export async function deleteStaff(req, res) {
    try {
        const businessId = resolveBusinessId(req)
        const { staffId } = req.params

        if (!businessId) {
            return res.status(400).json({ error: "businessId is required" })
        }

        // Try staffId first, fall back to staffId for old records
        let result = await Staff.findOneAndDelete({ businessId, staffId })
        if (!result) {
            result = await Staff.findOneAndDelete({ businessId, staffId: staffId })
        }

        if (!result) {
            return res.status(404).json({ error: "Staff member not found" })
        }

        await invalidateSetupProgress(businessId)

        return res.json({ message: "Staff member removed successfully" })
    } catch (err) {
        console.error("[deleteStaff]", err)
        return res.status(500).json({ error: "Failed to remove staff member" })
    }
}

// ─── Legacy exports (backward compat — keep /owner/staff working) ───────────

/**
 * @deprecated Use getStaff instead. Kept for backward compat.
 */
export async function getWaiters(req, res) {
    return getStaff(req, res)
}

/**
 * @deprecated Use createStaff instead. Kept for backward compat.
 * Accepts the old { staffId, name, email } shape and maps to new schema.
 */
export async function createWaiter(req, res) {
    // Map old staffId field → staffId for the new flow
    if (req.body.staffId && !req.body.staffId) {
        req.body.staffId = req.body.staffId
    }
    // Default role to "waiter" for legacy callers
    if (!req.body.role) {
        req.body.role = "waiter"
    }
    return createStaff(req, res)
}

/**
 * @deprecated Use deleteStaff instead. Kept for backward compat.
 */
export async function deleteWaiter(req, res) {
    req.params.staffId = req.params.id
    return deleteStaff(req, res)
}
