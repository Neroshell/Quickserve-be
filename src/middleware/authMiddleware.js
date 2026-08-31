import mongoose from "mongoose"
import Staff from "../models/Staff.js"
import { isValidPermission } from "../constants/permissions.js"
import {
    MANAGEMENT_AREA_BY_PERMISSION,
    isValidManagementAccessArea,
    resolveManagementAccess,
} from "../constants/managementAccess.js"

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

function sendForbidden(res) {
    return res.status(403).json({ message: "Forbidden. Insufficient permissions." })
}

function getManagementStaffIdentityFilter(sessionUser) {
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

    const filter = getManagementStaffIdentityFilter(sessionUser)
    if (!filter) return null

    const staff = await Staff.findOne(filter)
        .select("_id businessId staffId role accountStatus permissions coOwnerRestrictions name email")
        .lean()

    if (
        !staff ||
        staff.accountStatus !== "active" ||
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
