import { cacheKeys, responseCache } from "./responseCacheService.js"
import Business from "../models/Business.js"

function uniqueBusinessIds(businessIds) {
    return [...new Set(
        (businessIds || [])
            .map(businessId => String(businessId ?? "").trim())
            .filter(Boolean)
    )]
}

export async function invalidateSetupProgress(businessId) {
    if (!businessId) return false
    return responseCache.del(cacheKeys.setupProgress(businessId))
}

export async function invalidatePublicBusinessConfig(businessId) {
    if (!businessId) return false
    return responseCache.del(cacheKeys.publicBusinessConfig(businessId))
}

export async function invalidatePublicBusinessRoute(countryCode, slug) {
    if (!countryCode || !slug) return false
    return responseCache.del(cacheKeys.publicBusiness(countryCode, slug))
}

export async function invalidatePublicBusinessRoutes(routes) {
    const keys = [...new Set(
        (routes || [])
            .filter(route => route?.countryCode && route?.slug)
            .map(route => cacheKeys.publicBusiness(route.countryCode, route.slug))
    )]
    return responseCache.delMany(keys)
}

export async function invalidatePublicBusinessForBusinessId(
    businessId,
    { businessModel = Business, logger = console } = {},
) {
    if (!businessId) return false

    try {
        const business = await businessModel.findOne({ businessId })
            .select("countryCode slug")
            .lean()
        if (!business) return false
        return invalidatePublicBusinessRoute(business.countryCode, business.slug)
    } catch (error) {
        const reason = error?.code || error?.name || "route_lookup_error"
        logger?.warn?.(`[Cache] public business invalidation lookup failure businessId=${businessId} reason=${reason}`)
        return false
    }
}

export async function invalidateMenuItems(businessId) {
    if (!businessId) return false
    return responseCache.delMany(cacheKeys.menuItemVariants(businessId))
}

export async function invalidateMenuMutation(businessId) {
    if (!businessId) return false
    return responseCache.delMany([
        ...cacheKeys.menuItemVariants(businessId),
        cacheKeys.setupProgress(businessId),
    ])
}

export async function invalidateBusinessConfiguration(businessId) {
    if (!businessId) return false
    return responseCache.delMany([
        cacheKeys.setupProgress(businessId),
        cacheKeys.publicBusinessConfig(businessId),
    ])
}

export async function invalidateAllBusinessReadCaches(businessId, { publicBusinessRoutes = [] } = {}) {
    if (!businessId) return false
    return responseCache.delMany([
        cacheKeys.setupProgress(businessId),
        cacheKeys.publicBusinessConfig(businessId),
        ...cacheKeys.menuItemVariants(businessId),
        ...publicBusinessRoutes
            .filter(route => route?.countryCode && route?.slug)
            .map(route => cacheKeys.publicBusiness(route.countryCode, route.slug)),
    ])
}

export async function invalidatePublicBusinessConfigs(businessIds) {
    const keys = uniqueBusinessIds(businessIds)
        .map(businessId => cacheKeys.publicBusinessConfig(businessId))
    return responseCache.delMany(keys)
}
