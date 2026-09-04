export const PERMISSIONS = Object.freeze({
    DASHBOARD_VIEW: "dashboard.view",

    ORDERS_VIEW: "orders.view",
    ORDERS_MANAGE: "orders.manage",

    TRANSACTIONS_VIEW: "transactions.view",

    RESERVATIONS_VIEW: "reservations.view",
    RESERVATIONS_MANAGE: "reservations.manage",

    MENU_VIEW: "menu.view",
    MENU_MANAGE: "menu.manage",

    INVENTORY_VIEW: "inventory.view",
    INVENTORY_MANAGE: "inventory.manage",
    INVENTORY_RECEIVE: "inventory.receive",
    INVENTORY_WASTE: "inventory.waste",
    INVENTORY_ADJUST: "inventory.adjust",
    INVENTORY_RECIPE_MANAGE: "inventory.recipe.manage",

    SERVICE_POINTS_VIEW: "servicePoints.view",
    SERVICE_POINTS_MANAGE: "servicePoints.manage",

    STAFF_VIEW: "staff.view",
    STAFF_MANAGE: "staff.manage",

    ANALYTICS_VIEW: "analytics.view",
    FEEDBACK_VIEW: "feedback.view",
    CRM_VIEW: "crm.view",
    AI_ANALYST_VIEW: "aiAnalyst.view",

    SETTINGS_OPERATIONAL_MANAGE: "settings.operational.manage",
})

export const PERMISSION_VALUES = Object.freeze(Object.values(PERMISSIONS))

export const PERMISSION_DEPENDENCIES = Object.freeze({
    [PERMISSIONS.ORDERS_MANAGE]: [PERMISSIONS.ORDERS_VIEW],
    [PERMISSIONS.RESERVATIONS_MANAGE]: [PERMISSIONS.RESERVATIONS_VIEW],
    [PERMISSIONS.MENU_MANAGE]: [PERMISSIONS.MENU_VIEW],
    [PERMISSIONS.INVENTORY_MANAGE]: [PERMISSIONS.INVENTORY_VIEW],
    [PERMISSIONS.INVENTORY_RECEIVE]: [PERMISSIONS.INVENTORY_VIEW],
    [PERMISSIONS.INVENTORY_WASTE]: [PERMISSIONS.INVENTORY_VIEW],
    [PERMISSIONS.INVENTORY_ADJUST]: [PERMISSIONS.INVENTORY_VIEW],
    [PERMISSIONS.INVENTORY_RECIPE_MANAGE]: [PERMISSIONS.INVENTORY_VIEW],
    [PERMISSIONS.SERVICE_POINTS_MANAGE]: [PERMISSIONS.SERVICE_POINTS_VIEW],
    [PERMISSIONS.STAFF_MANAGE]: [PERMISSIONS.STAFF_VIEW],
})

const PERMISSION_SET = new Set(PERMISSION_VALUES)

export function isValidPermission(permissionKey) {
    return typeof permissionKey === "string" && PERMISSION_SET.has(permissionKey)
}

/**
 * Validate, de-duplicate, and apply manage -> view dependencies. The returned
 * order follows the catalog so API responses and tests remain deterministic.
 */
export function normalizePermissions(permissions = []) {
    if (!Array.isArray(permissions)) {
        throw new TypeError("permissions must be an array")
    }

    const normalized = new Set()
    for (const permissionKey of permissions) {
        if (!isValidPermission(permissionKey)) {
            throw new TypeError(`Invalid permission: ${String(permissionKey)}`)
        }
        normalized.add(permissionKey)
    }

    for (const permissionKey of [...normalized]) {
        for (const dependency of PERMISSION_DEPENDENCIES[permissionKey] || []) {
            normalized.add(dependency)
        }
    }

    return PERMISSION_VALUES.filter((permissionKey) => normalized.has(permissionKey))
}
