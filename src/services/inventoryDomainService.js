import {
    HOTEL_OPERATIONAL_INVENTORY_DOMAINS,
    INVENTORY_ITEM_DOMAINS,
    INVENTORY_ITEM_DOMAIN_VALUES,
} from "../constants/inventory.js"
import { resolveBusinessCapabilities } from "./businessCapabilityService.js"

const DOMAIN_SET = new Set(INVENTORY_ITEM_DOMAIN_VALUES)

function invalidDomainError(message, code = "INVALID_INVENTORY_DOMAIN") {
    const error = new Error(message)
    error.code = code
    error.statusCode = 400
    return error
}

export function normalizeInventoryItemDomain(value, {
    fallback = INVENTORY_ITEM_DOMAINS.FOOD_SERVICE,
} = {}) {
    if (value === undefined || value === null || value === "") return fallback
    if (typeof value !== "string") {
        throw invalidDomainError("Inventory domain must be a string")
    }
    const normalized = value.trim().toLowerCase()
    if (!DOMAIN_SET.has(normalized)) {
        throw invalidDomainError(`Invalid inventory domain: ${String(value)}`)
    }
    return normalized
}

export function resolveAllowedInventoryDomains(business) {
    const capabilities = resolveBusinessCapabilities(business)
    const allowed = []
    if (capabilities.visibleModules.includes("foodService")) {
        allowed.push(INVENTORY_ITEM_DOMAINS.FOOD_SERVICE)
    }
    if (capabilities.visibleModules.includes("lodging")) {
        allowed.push(...HOTEL_OPERATIONAL_INVENTORY_DOMAINS)
    }
    return [...new Set(allowed)]
}

export function resolveInventoryReadDomainsForBusiness(business, value) {
    const allowedDomains = resolveAllowedInventoryDomains(business)
    if (value === undefined || value === null || value === "" || value === "all") {
        return allowedDomains
    }
    if (typeof value !== "string") {
        throw invalidDomainError("Inventory domain filter must be a string")
    }

    const requestedDomains = [...new Set(
        value.split(",").map((domain) => domain.trim().toLowerCase()).filter(Boolean),
    )]
    if (
        requestedDomains.length === 0 ||
        requestedDomains.some((domain) => !DOMAIN_SET.has(domain))
    ) {
        throw invalidDomainError("Invalid inventory domain filter")
    }
    if (requestedDomains.some((domain) => !allowedDomains.includes(domain))) {
        throw invalidDomainError(
            "Inventory domain is not enabled for this business",
            "INVENTORY_DOMAIN_NOT_ENABLED",
        )
    }
    return requestedDomains
}

export function resolveDefaultInventoryDomain(business) {
    const allowed = resolveAllowedInventoryDomains(business)
    if (allowed.includes(INVENTORY_ITEM_DOMAINS.FOOD_SERVICE)) {
        return INVENTORY_ITEM_DOMAINS.FOOD_SERVICE
    }
    if (allowed.includes(INVENTORY_ITEM_DOMAINS.GENERAL)) {
        return INVENTORY_ITEM_DOMAINS.GENERAL
    }
    return allowed[0] || INVENTORY_ITEM_DOMAINS.FOOD_SERVICE
}

export function assertInventoryDomainAllowedForBusiness(business, value, {
    useBusinessDefault = false,
} = {}) {
    const domain = normalizeInventoryItemDomain(value, {
        fallback: useBusinessDefault
            ? resolveDefaultInventoryDomain(business)
            : INVENTORY_ITEM_DOMAINS.FOOD_SERVICE,
    })
    if (!resolveAllowedInventoryDomains(business).includes(domain)) {
        throw invalidDomainError(
            "Inventory domain is not enabled for this business",
            "INVENTORY_DOMAIN_NOT_ENABLED",
        )
    }
    return domain
}

export function isHotelOperationalInventoryDomain(value) {
    return HOTEL_OPERATIONAL_INVENTORY_DOMAINS.includes(value)
}
