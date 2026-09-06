const MODULE_DEFINITIONS = Object.freeze([
    Object.freeze({ id: "lodging", label: "Lodging" }),
    Object.freeze({ id: "foodService", label: "Food Service" }),
])

export const BUSINESS_MODULES = Object.freeze(MODULE_DEFINITIONS.map(({ id }) => id))

const DEFAULT_MODULES_BY_BUSINESS_TYPE = Object.freeze({
    restaurant: Object.freeze(["foodService"]),
    bar_lounge: Object.freeze(["foodService"]),
    hotel: Object.freeze(["lodging"]),
})

const REQUIRED_MODULES_BY_BUSINESS_TYPE = DEFAULT_MODULES_BY_BUSINESS_TYPE

const RESTAURANT_NAVIGATION = Object.freeze([
    Object.freeze({ id: "operations", label: "Operations", items: Object.freeze(["orders", "transactions", "reservations"]) }),
    Object.freeze({ id: "management", label: "Management", items: Object.freeze(["menu", "inventory", "servicePoints", "staff"]) }),
    Object.freeze({ id: "insights", label: "Insights", items: Object.freeze(["analytics", "feedback", "guests", "aiBusinessAnalyst"]) }),
    Object.freeze({ id: "account", label: "Account", items: Object.freeze(["billing", "branding", "settings"]) }),
])

const HOTEL_NAVIGATION_BASE = Object.freeze([
    Object.freeze({ id: "hotelOperations", label: "Hotel Operations", items: Object.freeze(["reservations", "transactions", "servicePoints"]) }),
])

const HOTEL_NAVIGATION_COMMON = Object.freeze([
    Object.freeze({ id: "management", label: "Management", items: Object.freeze(["staff"]) }),
    Object.freeze({ id: "insights", label: "Insights", items: Object.freeze(["analytics", "feedback", "guests", "aiBusinessAnalyst"]) }),
    Object.freeze({ id: "account", label: "Account", items: Object.freeze(["billing", "branding", "settings"]) }),
])

function canonicalBusinessType(businessType) {
    if (businessType === "apartment" || businessType === "hotel_apartment") return "hotel"
    if (businessType === "bar_lounge") return "bar_lounge"
    if (businessType === "hotel") return "hotel"
    return "restaurant"
}

export function getDefaultBusinessModules(businessType) {
    const canonicalType = canonicalBusinessType(businessType)
    return [...(DEFAULT_MODULES_BY_BUSINESS_TYPE[canonicalType] || DEFAULT_MODULES_BY_BUSINESS_TYPE.restaurant)]
}

export function normalizeBusinessModules(modules) {
    if (!Array.isArray(modules)) {
        throw new TypeError("modules must be an array")
    }

    const normalized = []
    for (const moduleId of modules) {
        if (typeof moduleId !== "string" || !BUSINESS_MODULES.includes(moduleId)) {
            throw new TypeError(`Invalid business module: ${String(moduleId)}`)
        }
        if (!normalized.includes(moduleId)) normalized.push(moduleId)
    }

    if (normalized.length === 0) {
        throw new TypeError("At least one business module is required")
    }

    return BUSINESS_MODULES.filter((moduleId) => normalized.includes(moduleId))
}

export function validateBusinessModulesForType(businessType, modules) {
    const normalized = normalizeBusinessModules(modules)
    const canonicalType = canonicalBusinessType(businessType)
    const requiredModules = REQUIRED_MODULES_BY_BUSINESS_TYPE[canonicalType] || []
    const missingModule = requiredModules.find((moduleId) => !normalized.includes(moduleId))

    if (missingModule) {
        throw new TypeError(`${canonicalType} businesses require the ${missingModule} module`)
    }

    return normalized
}

export function resolveBusinessModules(business) {
    if (Array.isArray(business?.modules) && business.modules.length > 0) {
        return validateBusinessModulesForType(business.businessType, business.modules)
    }
    return getDefaultBusinessModules(business?.businessType)
}

export function setBusinessModuleEnabled(business, moduleId, enabled) {
    if (!BUSINESS_MODULES.includes(moduleId)) {
        throw new TypeError(`Invalid business module: ${String(moduleId)}`)
    }
    if (typeof enabled !== "boolean") {
        throw new TypeError("enabled must be a boolean")
    }

    const currentModules = resolveBusinessModules(business)
    const nextModules = enabled
        ? [...currentModules, moduleId]
        : currentModules.filter((currentModuleId) => currentModuleId !== moduleId)

    return validateBusinessModulesForType(business?.businessType, nextModules)
}

function buildNavigation(shell, modules) {
    if (shell === "restaurant") {
        // The restaurant shell has one canonical owner navigation definition.
        return RESTAURANT_NAVIGATION.map((group) => ({ ...group, items: [...group.items] }))
    }

    const groups = HOTEL_NAVIGATION_BASE.map((group) => ({ ...group, items: [...group.items] }))
    if (modules.includes("foodService")) {
        groups.push({
            id: "foodService",
            label: "Food Service",
            items: ["orders", "menu", "inventory"],
        })
    }
    groups.push(...HOTEL_NAVIGATION_COMMON.map((group) => ({ ...group, items: [...group.items] })))
    return groups
}

export function resolveBusinessCapabilities(business) {
    const businessObject = typeof business?.toObject === "function" ? business.toObject() : business
    const businessType = canonicalBusinessType(businessObject?.businessType)
    const shell = businessType === "hotel" ? "hotel" : "restaurant"
    const modules = resolveBusinessModules({ ...businessObject, businessType })
    const hasLodging = modules.includes("lodging")
    const hasFoodService = modules.includes("foodService")

    const reservationModes = []
    if (hasLodging) reservationModes.push("stay")
    if (hasFoodService) reservationModes.push("timeslot")

    const allowedServicePointTypes = []
    if (hasLodging) allowedServicePointTypes.push("room")
    if (hasFoodService) allowedServicePointTypes.push("table")

    const primaryReservationMode = shell === "hotel" && hasLodging ? "stay" : "timeslot"
    const defaultServicePointType = shell === "hotel" && hasLodging ? "room" : "table"
    const servicePointTerm = {
        singular: "Service Point",
        plural: "Service Points",
        lower: "service point",
        lowerPlural: "service points",
    }

    return {
        version: 1,
        identity: { businessType, shell },
        visibleModules: modules,
        navigation: {
            shell,
            groups: buildNavigation(shell, modules),
        },
        dashboard: {
            shell,
            sections: shell === "hotel"
                ? [
                    "reservations",
                    "transactions",
                    "servicePoints",
                    ...(hasFoodService ? ["orders", "menu"] : []),
                ]
                : ["orders", "transactions", "reservations", "servicePoints"],
        },
        reservations: {
            modes: reservationModes,
            primaryMode: primaryReservationMode,
        },
        servicePoints: {
            allowedTypes: allowedServicePointTypes,
            defaultType: defaultServicePointType,
        },
        terminology: {
            servicePoint: servicePointTerm,
        },
        settings: {
            sections: [
                "business",
                "operations",
                ...(hasLodging ? ["lodging"] : []),
                ...(hasFoodService ? ["preferences", "foodService"] : []),
                "teamAccess",
                "security",
            ],
        },
        analytics: {
            sections: [
                ...(hasLodging ? ["lodging"] : []),
                ...(hasFoodService ? ["foodService"] : []),
            ],
        },
    }
}

export function getBusinessModuleCatalog() {
    return {
        modules: MODULE_DEFINITIONS.map((definition) => ({ ...definition })),
        defaultsByBusinessType: Object.fromEntries(
            Object.entries(DEFAULT_MODULES_BY_BUSINESS_TYPE).map(([businessType, modules]) => [businessType, [...modules]])
        ),
        requiredByBusinessType: Object.fromEntries(
            Object.entries(REQUIRED_MODULES_BY_BUSINESS_TYPE).map(([businessType, modules]) => [businessType, [...modules]])
        ),
    }
}

export function attachBusinessCapabilities(business) {
    if (!business) return business
    const businessObject = typeof business.toObject === "function" ? business.toObject() : { ...business }
    const modules = resolveBusinessModules(businessObject)
    return {
        ...businessObject,
        modules,
        capabilities: resolveBusinessCapabilities({ ...businessObject, modules }),
    }
}
