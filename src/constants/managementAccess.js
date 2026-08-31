import { PERMISSIONS } from "./permissions.js"

export const MANAGEMENT_ACCESS_AREAS = Object.freeze({
    DASHBOARD: "dashboard",
    ORDERS: "orders",
    RESERVATIONS: "reservations",
    TRANSACTIONS: "transactions",
    MENU: "menu",
    SERVICE_POINTS: "service_points",
    STAFF_MANAGEMENT: "staff_management",
    ANALYTICS: "analytics",
    FEEDBACK: "feedback",
    CRM: "crm",
    AI_ANALYST: "ai_analyst",
    BUSINESS_SETTINGS: "business_settings",
    BRANDING: "branding",
    PAYMENTS_AND_BILLING: "payments_billing",
})

export const MANAGEMENT_ACCESS_AREA_VALUES = Object.freeze(
    Object.values(MANAGEMENT_ACCESS_AREAS),
)

const MANAGEMENT_ACCESS_AREA_SET = new Set(MANAGEMENT_ACCESS_AREA_VALUES)

export const MANAGEMENT_AREA_BY_PERMISSION = Object.freeze({
    [PERMISSIONS.DASHBOARD_VIEW]: MANAGEMENT_ACCESS_AREAS.DASHBOARD,
    [PERMISSIONS.ORDERS_VIEW]: MANAGEMENT_ACCESS_AREAS.ORDERS,
    [PERMISSIONS.ORDERS_MANAGE]: MANAGEMENT_ACCESS_AREAS.ORDERS,
    [PERMISSIONS.TRANSACTIONS_VIEW]: MANAGEMENT_ACCESS_AREAS.TRANSACTIONS,
    [PERMISSIONS.RESERVATIONS_VIEW]: MANAGEMENT_ACCESS_AREAS.RESERVATIONS,
    [PERMISSIONS.RESERVATIONS_MANAGE]: MANAGEMENT_ACCESS_AREAS.RESERVATIONS,
    [PERMISSIONS.MENU_VIEW]: MANAGEMENT_ACCESS_AREAS.MENU,
    [PERMISSIONS.MENU_MANAGE]: MANAGEMENT_ACCESS_AREAS.MENU,
    [PERMISSIONS.SERVICE_POINTS_VIEW]: MANAGEMENT_ACCESS_AREAS.SERVICE_POINTS,
    [PERMISSIONS.SERVICE_POINTS_MANAGE]: MANAGEMENT_ACCESS_AREAS.SERVICE_POINTS,
    [PERMISSIONS.STAFF_VIEW]: MANAGEMENT_ACCESS_AREAS.STAFF_MANAGEMENT,
    [PERMISSIONS.STAFF_MANAGE]: MANAGEMENT_ACCESS_AREAS.STAFF_MANAGEMENT,
    [PERMISSIONS.ANALYTICS_VIEW]: MANAGEMENT_ACCESS_AREAS.ANALYTICS,
    [PERMISSIONS.FEEDBACK_VIEW]: MANAGEMENT_ACCESS_AREAS.FEEDBACK,
    [PERMISSIONS.CRM_VIEW]: MANAGEMENT_ACCESS_AREAS.CRM,
    [PERMISSIONS.AI_ANALYST_VIEW]: MANAGEMENT_ACCESS_AREAS.AI_ANALYST,
    [PERMISSIONS.SETTINGS_OPERATIONAL_MANAGE]: MANAGEMENT_ACCESS_AREAS.BUSINESS_SETTINGS,
})

const PRIMARY_OWNER_BYPASS_ROLES = new Set(["owner", "restaurant_owner", "admin"])

export function isValidManagementAccessArea(area) {
    return typeof area === "string" && MANAGEMENT_ACCESS_AREA_SET.has(area)
}

export function normalizeCoOwnerRestrictions(restrictions = []) {
    if (!Array.isArray(restrictions)) {
        throw new TypeError("restrictions must be an array")
    }

    const normalized = new Set()
    for (const area of restrictions) {
        if (!isValidManagementAccessArea(area)) {
            throw new TypeError(`Invalid management access area: ${String(area)}`)
        }
        normalized.add(area)
    }

    return MANAGEMENT_ACCESS_AREA_VALUES.filter((area) => normalized.has(area))
}

function currentRestrictions(user) {
    const restrictions = Array.isArray(user?.coOwnerRestrictions)
        ? user.coOwnerRestrictions
        : []
    return new Set(restrictions.filter(isValidManagementAccessArea))
}

/**
 * Canonical effective-access resolver for management users.
 *
 * Primary owners are an unconditional bypass. Co-owners are allowed by
 * default unless the requested area is explicitly revoked. Managers retain
 * their existing default-deny, explicit-permission behavior.
 */
export function resolveManagementAccess(user, {
    area,
    managerPermissions = [],
    primaryOwnerOnly = false,
} = {}) {
    if (!user?.role) return false
    if (PRIMARY_OWNER_BYPASS_ROLES.has(user.role)) return true
    if (primaryOwnerOnly) return false

    if (user.role === "co_owner") {
        return isValidManagementAccessArea(area) && !currentRestrictions(user).has(area)
    }

    if (user.role === "manager") {
        const granted = new Set(Array.isArray(user.permissions) ? user.permissions : [])
        return managerPermissions.some((permission) => granted.has(permission))
    }

    return false
}

export function getEffectiveManagementAreas(user) {
    if (!user?.role) return []
    if (PRIMARY_OWNER_BYPASS_ROLES.has(user.role)) return [...MANAGEMENT_ACCESS_AREA_VALUES]

    if (user.role === "co_owner") {
        const restrictions = currentRestrictions(user)
        return MANAGEMENT_ACCESS_AREA_VALUES.filter((area) => !restrictions.has(area))
    }

    if (user.role === "manager") {
        const permissions = new Set(Array.isArray(user.permissions) ? user.permissions : [])
        const areas = new Set()
        for (const permission of permissions) {
            const area = MANAGEMENT_AREA_BY_PERMISSION[permission]
            if (area) areas.add(area)
        }
        return MANAGEMENT_ACCESS_AREA_VALUES.filter((area) => areas.has(area))
    }

    return []
}
