import mongoose from "mongoose"
import Staff from "../models/Staff.js"
import Business from "../models/Business.js"
import { isValidPermission } from "../constants/permissions.js"
import {
    MANAGEMENT_AREA_BY_PERMISSION,
    isValidManagementAccessArea,
    resolveManagementAccess,
} from "../constants/managementAccess.js"

const STAFF_SESSION_ROLES = new Set([
    "waiter",
    "kitchen",
    "manager",
    "bartender",
    "housekeeping",
    "co_owner",
])

function normalizedAuthVersion(value) {
    const version = Number(value)
    return Number.isSafeInteger(version) && version >= 0 ? version : 0
}

export function isStaffSessionUser(sessionUser) {
    return Boolean(
        sessionUser &&
        (sessionUser.type === "staff" || STAFF_SESSION_ROLES.has(sessionUser.role)),
    )
}

export function isOwnerSessionUser(sessionUser) {
    return Boolean(sessionUser && sessionUser.type === "owner" && sessionUser.role === "owner")
}

function sendRevokedSession(req, res) {
    res.clearCookie?.("qs_dashboard_session")
    if (typeof req.session?.destroy === "function") {
        req.session.destroy((error) => {
            if (error) console.error("[authorization] Failed to destroy revoked session", error)
        })
    }
    return res.status(401).json({
        message: "Session is no longer valid. Please log in again.",
        code: "SESSION_REVOKED",
    })
}

export async function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ message: "Unauthorized. Please log in." })
    }

    try {
        if (isOwnerSessionUser(req.session.user)) {
            const owner = await resolveCurrentOwner(req)
            if (!owner) return sendRevokedSession(req, res)
        } else if (isStaffSessionUser(req.session.user)) {
            const staff = await resolveCurrentStaff(req)
            if (!staff) return sendRevokedSession(req, res)
        }
        return next()
    } catch (error) {
        console.error("[authorization] Failed to verify current session", error)
        return res.status(500).json({ message: "Unable to verify session." })
    }
}

/** Resolve the primary owner identity from the canonical Business record. */
export async function resolveCurrentOwner(req) {
    const sessionUser = req.session?.user
    if (!isOwnerSessionUser(sessionUser)) return null
    if (req.resolvedCurrentOwner) return req.resolvedCurrentOwner
    if (!mongoose.isValidObjectId(sessionUser.userId) || !sessionUser.businessId) return null

    const business = await Business.findOne({
        _id: sessionUser.userId,
        businessId: sessionUser.businessId,
    })
        .select("_id businessId ownerEmail ownerName ownerStatus ownerAuthVersion displayName businessType modules capabilities currency taxRate timezone currentPlan billingStatus ownerPasswordHash")
        .lean()

    if (
        !business ||
        business.ownerStatus !== "active" ||
        business.businessId !== sessionUser.businessId ||
        business.ownerEmail !== sessionUser.email ||
        normalizedAuthVersion(business.ownerAuthVersion) !== normalizedAuthVersion(req.session.ownerAuthVersion)
    ) {
        return null
    }

    req.resolvedCurrentOwner = business
    return business
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

function sendForbidden(res) {
    return res.status(403).json({ message: "Forbidden. Insufficient permissions." })
}

function getStaffIdentityFilter(sessionUser) {
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
 * Resolve the canonical Staff record once per request. The session establishes
 * identity only; MongoDB remains authoritative for tenant, active state, role,
 * configurable access, and credential revocation version.
 */
export async function resolveCurrentStaff(req) {
    const sessionUser = req.session?.user
    if (!isStaffSessionUser(sessionUser)) return null
    if (req.resolvedCurrentStaff) return req.resolvedCurrentStaff

    const filter = getStaffIdentityFilter(sessionUser)
    if (!filter) return null

    const staff = await Staff.findOne(filter)
        .select("_id businessId staffId role accountStatus permissions coOwnerRestrictions name email authVersion")
        .lean()

    if (
        !staff ||
        staff.accountStatus !== "active" ||
        staff.businessId !== sessionUser.businessId ||
        staff.role !== sessionUser.role ||
        normalizedAuthVersion(staff.authVersion) !== normalizedAuthVersion(req.session.staffAuthVersion)
    ) {
        return null
    }

    req.resolvedCurrentStaff = staff
    return staff
}

export async function resolveCurrentOperationalStaff(req) {
    const sessionUser = req.session?.user
    if (!sessionUser?.businessId || ["owner", "restaurant_owner", "admin", "co_owner", "manager"].includes(sessionUser.role)) {
        return null
    }
    if (req.resolvedOperationalStaff) return req.resolvedOperationalStaff

    const staff = await resolveCurrentStaff(req)
    if (!staff) return null

    req.resolvedOperationalStaff = staff
    return staff
}

/**
 * Resolve the current Manager or Co-Owner from MongoDB. Session data identifies
 * the account, while current database state remains the authorization authority.
 */
export async function resolveCurrentManagementStaff(req, expectedRole) {
    const sessionUser = req.session?.user
    if (!sessionUser || sessionUser.role !== expectedRole) return null

    const cacheKey = expectedRole === "manager"
        ? "resolvedManagerStaff"
        : "resolvedCoOwnerStaff"
    if (req[cacheKey]) return req[cacheKey]

    const staff = await resolveCurrentStaff(req)

    if (
        !staff ||
        staff.role !== expectedRole ||
        staff.businessId !== sessionUser.businessId
    ) {
        return null
    }

    req[cacheKey] = staff
    return staff
}

export async function resolveCurrentManager(req) {
    const staff = await resolveCurrentManagementStaff(req, "manager")
    if (!staff) return null

    req.resolvedManagerStaff = staff
    req.resolvedManagerPermissions = Array.isArray(staff.permissions) ? staff.permissions : []
    return staff
}

export async function resolveCurrentCoOwner(req) {
    const staff = await resolveCurrentManagementStaff(req, "co_owner")
    if (!staff) return null

    req.resolvedCoOwnerStaff = staff
    req.resolvedCoOwnerRestrictions = Array.isArray(staff.coOwnerRestrictions)
        ? staff.coOwnerRestrictions
        : []
    return staff
}

async function authorizeManagementAccess(req, res, next, {
    areas,
    managerPermissions,
    onlyWhenManagementAuthenticated = false,
}) {
    const sessionUser = req.session?.user

    if (!sessionUser) {
        if (onlyWhenManagementAuthenticated) return next()
        return res.status(401).json({ message: "Unauthorized. Please log in." })
    }

    try {
        if (["owner", "restaurant_owner", "admin"].includes(sessionUser.role)) {
            return next()
        }

        if (sessionUser.role === "co_owner") {
            const staff = await resolveCurrentCoOwner(req)
            if (!staff) return sendForbidden(res)

            const allowed = areas.some((area) => resolveManagementAccess({
                ...sessionUser,
                coOwnerRestrictions: req.resolvedCoOwnerRestrictions,
            }, { area }))
            return allowed ? next() : sendForbidden(res)
        }

        if (sessionUser.role === "manager") {
            const staff = await resolveCurrentManager(req)
            if (!staff) return sendForbidden(res)

            const allowed = resolveManagementAccess({
                ...sessionUser,
                permissions: req.resolvedManagerPermissions,
            }, { area: areas[0], managerPermissions })
            return allowed ? next() : sendForbidden(res)
        }

        if (onlyWhenManagementAuthenticated) return next()
        return sendForbidden(res)
    } catch (err) {
        console.error("[authorization] Failed to resolve current management access", err)
        return res.status(500).json({ message: "Unable to verify permissions." })
    }
}

export function requireManagementArea(area, ...managerPermissions) {
    if (!isValidManagementAccessArea(area)) {
        throw new TypeError(`Unknown management access area: ${String(area)}`)
    }
    if (managerPermissions.some((permissionKey) => !isValidPermission(permissionKey))) {
        throw new TypeError("requireManagementArea received an unknown Manager permission")
    }

    return (req, res, next) => authorizeManagementAccess(req, res, next, {
        areas: [area],
        managerPermissions,
    })
}

export function requirePermission(permissionKey) {
    if (!isValidPermission(permissionKey)) {
        throw new TypeError(`Unknown permission: ${String(permissionKey)}`)
    }

    const area = MANAGEMENT_AREA_BY_PERMISSION[permissionKey]
    if (!area) throw new TypeError(`Permission has no management access area: ${permissionKey}`)

    return (req, res, next) => authorizeManagementAccess(req, res, next, {
        areas: [area],
        managerPermissions: [permissionKey],
    })
}

export function requireAnyPermission(...permissionKeys) {
    if (permissionKeys.length === 0 || permissionKeys.some((permissionKey) => !isValidPermission(permissionKey))) {
        throw new TypeError("requireAnyPermission received an unknown permission")
    }

    const areas = [...new Set(permissionKeys.map((permissionKey) => MANAGEMENT_AREA_BY_PERMISSION[permissionKey]))]
    return (req, res, next) => authorizeManagementAccess(req, res, next, {
        areas,
        managerPermissions: permissionKeys,
    })
}

/**
 * Public/customer routes stay public. If the request carries a Manager or
 * Co-Owner session, however, current effective access is still enforced.
 */
export function requirePermissionForAuthenticatedManager(permissionKey) {
    if (!isValidPermission(permissionKey)) {
        throw new TypeError(`Unknown permission: ${String(permissionKey)}`)
    }

    const area = MANAGEMENT_AREA_BY_PERMISSION[permissionKey]
    return (req, res, next) => authorizeManagementAccess(req, res, next, {
        areas: [area],
        managerPermissions: [permissionKey],
        onlyWhenManagementAuthenticated: true,
    })
}

/**
 * Bounded permission guard for operational workspaces. Management semantics
 * remain unchanged, while non-management Staff are reloaded from MongoDB and
 * must hold one of the explicit permissions supplied here.
 */
export function requireOperationalPermission(...permissionKeys) {
    if (permissionKeys.length === 0 || permissionKeys.some((permissionKey) => !isValidPermission(permissionKey))) {
        throw new TypeError("requireOperationalPermission received an unknown permission")
    }

    return async (req, res, next) => {
        const sessionUser = req.session?.user
        if (!sessionUser) return res.status(401).json({ message: "Unauthorized. Please log in." })

        try {
            if (["owner", "restaurant_owner", "admin"].includes(sessionUser.role)) return next()

            if (sessionUser.role === "co_owner") {
                const staff = await resolveCurrentCoOwner(req)
                if (!staff) return sendForbidden(res)
                const allowed = permissionKeys.some((permissionKey) => resolveManagementAccess({
                    ...sessionUser,
                    coOwnerRestrictions: req.resolvedCoOwnerRestrictions,
                }, { area: MANAGEMENT_AREA_BY_PERMISSION[permissionKey] }))
                return allowed ? next() : sendForbidden(res)
            }

            if (sessionUser.role === "manager") {
                const staff = await resolveCurrentManager(req)
                if (!staff) return sendForbidden(res)
                return permissionKeys.some((permissionKey) => req.resolvedManagerPermissions.includes(permissionKey))
                    ? next()
                    : sendForbidden(res)
            }

            const staff = await resolveCurrentOperationalStaff(req)
            if (!staff) return sendForbidden(res)
            return permissionKeys.some((permissionKey) => (staff.permissions || []).includes(permissionKey))
                ? next()
                : sendForbidden(res)
        } catch (error) {
            console.error("[authorization] Failed to resolve operational permission", error)
            return res.status(500).json({ message: "Unable to verify permissions." })
        }
    }
}
