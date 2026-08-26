import mongoose from "mongoose"
import Staff from "../models/Staff.js"
import { isValidPermission } from "../constants/permissions.js"

const MANAGEMENT_OWNER_ROLES = new Set(["owner", "co_owner", "restaurant_owner", "admin"])

export function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ message: "Unauthorized. Please log in." })
    }
    next()
}

export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ message: "Unauthorized. Please log in." })
        }
        if (!roles.includes(req.session.user.role)) {
            return res.status(403).json({ message: "Forbidden. Insufficient permissions." })
        }
        next()
    }
}

export const requirePrimaryOwner = requireRole("owner")

// Accepts primary owners, co-owners, and any legacy role variants stored in older sessions
export const requireOwnerOrCoOwner = requireRole("owner", "co_owner", "restaurant_owner", "admin")

function sendForbidden(res) {
    return res.status(403).json({ message: "Forbidden. Insufficient permissions." })
}

function getManagerIdentityFilter(sessionUser) {
    const businessId = sessionUser?.businessId
    if (!businessId) return null

    if (sessionUser.staffObjectId && mongoose.isValidObjectId(sessionUser.staffObjectId)) {
        return { _id: sessionUser.staffObjectId, businessId }
    }

    if (sessionUser.staffId) {
        return { staffId: sessionUser.staffId, businessId }
    }

    if (sessionUser.email) {
        return { email: String(sessionUser.email).trim().toLowerCase(), businessId }
    }

    return null
}

/**
 * Resolve a Manager from MongoDB for the current request. Redis session data
 * identifies the account but never acts as the permission authority.
 */
export async function resolveCurrentManager(req) {
    if (req.resolvedManagerStaff) return req.resolvedManagerStaff

    const sessionUser = req.session?.user
    if (!sessionUser || sessionUser.role !== "manager") return null

    const filter = getManagerIdentityFilter(sessionUser)
    if (!filter) return null

    const staff = await Staff.findOne(filter)
        .select("_id businessId staffId role accountStatus permissions name email")
        .lean()

    if (
        !staff ||
        staff.accountStatus !== "active" ||
        staff.role !== "manager" ||
        staff.businessId !== sessionUser.businessId
    ) {
        return null
    }

    req.resolvedManagerStaff = staff
    req.resolvedManagerPermissions = Array.isArray(staff.permissions) ? staff.permissions : []
    return staff
}

async function authorizePermissions(req, res, next, permissionKeys, { managerOnlyWhenAuthenticated = false } = {}) {
    const sessionUser = req.session?.user

    if (!sessionUser) {
        if (managerOnlyWhenAuthenticated) return next()
        return res.status(401).json({ message: "Unauthorized. Please log in." })
    }

    if (MANAGEMENT_OWNER_ROLES.has(sessionUser.role)) return next()

    if (sessionUser.role !== "manager") {
        if (managerOnlyWhenAuthenticated) return next()
        return sendForbidden(res)
    }

    try {
        const staff = await resolveCurrentManager(req)
        if (!staff) return sendForbidden(res)

        const currentPermissions = new Set(req.resolvedManagerPermissions)
        if (!permissionKeys.some((permissionKey) => currentPermissions.has(permissionKey))) {
            return sendForbidden(res)
        }

        return next()
    } catch (err) {
        console.error("[authorization] Failed to resolve current Manager permissions", err)
        return res.status(500).json({ message: "Unable to verify permissions." })
    }
}

export function requirePermission(permissionKey) {
    if (!isValidPermission(permissionKey)) {
        throw new TypeError(`Unknown permission: ${String(permissionKey)}`)
    }
    return (req, res, next) => authorizePermissions(req, res, next, [permissionKey])
}

export function requireAnyPermission(...permissionKeys) {
    if (permissionKeys.length === 0 || permissionKeys.some((permissionKey) => !isValidPermission(permissionKey))) {
        throw new TypeError("requireAnyPermission received an unknown permission")
    }
    return (req, res, next) => authorizePermissions(req, res, next, permissionKeys)
}

/**
 * Public/customer routes stay public. If the request carries a Manager session,
 * however, that Manager must have the relevant current database permission.
 */
export function requirePermissionForAuthenticatedManager(permissionKey) {
    if (!isValidPermission(permissionKey)) {
        throw new TypeError(`Unknown permission: ${String(permissionKey)}`)
    }
    return (req, res, next) => authorizePermissions(
        req,
        res,
        next,
        [permissionKey],
        { managerOnlyWhenAuthenticated: true },
    )
}
