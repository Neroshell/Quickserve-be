import Business from "../models/Business.js"
import { resolveDiscoveryDestination } from "../services/discoveryDestinationResolver.js"
import {
    DISCOVERY_BUSINESS_SELECT,
    DISCOVERY_VISIBLE_BUSINESS_STATUSES,
    buildDiscoveryListingDto,
    buildDiscoveryPlaceDto,
} from "../services/discoveryPublicationService.js"
import {
    PublicBusinessResolutionError,
    normalizePublicBusinessLocator,
    normalizePublicCountryCode,
    resolvePublicBusiness,
} from "../services/publicBusinessResolverService.js"

const MAX_PAGE_SIZE = 50
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE = 10_000
const EARTH_RADIUS_KM = 6378.137
const DEFAULT_NEARBY_RADIUS_KM = 20
const MAX_NEARBY_RADIUS_KM = 50
const CATEGORY_BUSINESS_TYPES = Object.freeze({
    eat: ["restaurant"],
    drink: ["bar_lounge"],
    stay: ["hotel"],
})
const BUSINESS_TYPES = new Set(["restaurant", "bar_lounge", "hotel"])

function setDiscoveryNoStore(res) {
    const headers = {
        "Cache-Control": "private, no-store, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
        "Surrogate-Control": "no-store",
    }
    if (typeof res?.set === "function") res.set(headers)
    else if (typeof res?.setHeader === "function") {
        Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value))
    }
}

function requireSingleQueryValue(value, name) {
    if (Array.isArray(value)) throw new PublicBusinessResolutionError(`${name} must be provided once`)
    return value
}

function optionalText(value, { name, maxLength }) {
    value = requireSingleQueryValue(value, name)
    if (value === undefined) return null
    if (typeof value !== "string") throw new PublicBusinessResolutionError(`${name} must be text`)
    const normalized = value.trim()
    if (!normalized) return null
    if (normalized.length > maxLength) {
        throw new PublicBusinessResolutionError(`${name} must be ${maxLength} characters or fewer`)
    }
    return normalized
}

function positiveInteger(value, { name, defaultValue, maximum }) {
    value = requireSingleQueryValue(value, name)
    if (value === undefined || value === "") return defaultValue
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new PublicBusinessResolutionError(`${name} must be a whole number`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
        throw new PublicBusinessResolutionError(`${name} must be between 1 and ${maximum}`)
    }
    return parsed
}

function optionalCoordinate(value, { name, min, max }) {
    value = requireSingleQueryValue(value, name)
    if (value === undefined) return null
    if (typeof value !== "string" || !/^-?(?:\\d+)(?:\\.\\d+)?$/.test(value.trim())) {
        throw new PublicBusinessResolutionError(`${name} must be a valid coordinate`)
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw new PublicBusinessResolutionError(`${name} must be between ${min} and ${max}`)
    }
    return parsed
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function queryForDiscoverySearch({ countryCode, city, bounds, nearby, category, businessType }) {
    const query = {
        status: { $in: [...DISCOVERY_VISIBLE_BUSINESS_STATUSES] },
        "propertyProfile.discoveryPublished": true,
        displayName: { $type: "string", $regex: /\S/ },
        country: { $type: "string", $regex: /\S/ },
        countryCode: { $regex: /^[a-z]{2}$/i },
        address: { $type: "string", $regex: /\S/ },
        "propertyProfile.city": { $type: "string", $regex: /\S/ },
        "propertyProfile.photos.0.url": { $regex: /^https?:\/\/\S+$/i },
    }
    if (countryCode) query.countryCode = countryCode
    if (nearby) {
        query.discoveryGeoPoint = {
            $geoWithin: {
                $centerSphere: [
                    [nearby.longitude, nearby.latitude],
                    nearby.radiusKm / EARTH_RADIUS_KM,
                ],
            },
        }
    } else if (bounds) query.discoveryGeoPoint = { $geoWithin: { $box: bounds } }
    else if (city) query["propertyProfile.city"] = new RegExp(`^${escapeRegExp(city)}$`, "i")

    const categoryTypes = category ? CATEGORY_BUSINESS_TYPES[category] : null
    const requestedTypes = businessType ? [businessType] : null
    const allowedTypes = categoryTypes && requestedTypes
        ? categoryTypes.filter((type) => requestedTypes.includes(type))
        : categoryTypes || requestedTypes

    if (allowedTypes?.length === 1) query.businessType = allowedTypes[0]
    else if (allowedTypes?.length > 1) query.businessType = { $in: allowedTypes }
    else if (categoryTypes && requestedTypes) query.businessType = { $in: [] }

    return query
}

export function parseDiscoverySearchQuery(rawQuery = {}) {
    const rawCountryCode = optionalText(rawQuery.countryCode, { name: "countryCode", maxLength: 2 })
    const countryCode = rawCountryCode ? normalizePublicCountryCode(rawCountryCode) : null
    const city = optionalText(rawQuery.city, { name: "city", maxLength: 120 })
    const category = optionalText(rawQuery.category, { name: "category", maxLength: 16 })?.toLowerCase() || null
    const businessType = optionalText(rawQuery.businessType, { name: "businessType", maxLength: 32 })?.toLowerCase() || null
    const sort = optionalText(rawQuery.sort, { name: "sort", maxLength: 16 }) || "name_asc"
    const latitude = optionalCoordinate(rawQuery.latitude, { name: "latitude", min: -90, max: 90 })
    const longitude = optionalCoordinate(rawQuery.longitude, { name: "longitude", min: -180, max: 180 })
    const radiusKm = positiveInteger(rawQuery.radiusKm, {
        name: "radiusKm", defaultValue: DEFAULT_NEARBY_RADIUS_KM, maximum: MAX_NEARBY_RADIUS_KM,
    })
    if ((latitude === null) !== (longitude === null)) {
        throw new PublicBusinessResolutionError("latitude and longitude must be supplied together")
    }
    if (latitude !== null && city) {
        throw new PublicBusinessResolutionError("city cannot be combined with nearby coordinates")
    }
    if (rawQuery.radiusKm !== undefined && latitude === null) {
        throw new PublicBusinessResolutionError("radiusKm requires nearby coordinates")
    }


    if (category && !Object.hasOwn(CATEGORY_BUSINESS_TYPES, category)) {
        throw new PublicBusinessResolutionError("category must be eat, drink, or stay")
    }
    if (businessType && !BUSINESS_TYPES.has(businessType)) {
        throw new PublicBusinessResolutionError("businessType is invalid")
    }
    if (!["name_asc", "name_desc"].includes(sort)) {
        throw new PublicBusinessResolutionError("sort must be name_asc or name_desc")
    }

    return {
        countryCode,
        city,
        nearby: latitude === null ? null : { latitude, longitude, radiusKm },
        category,
        businessType,
        sort,
        page: positiveInteger(rawQuery.page, { name: "page", defaultValue: 1, maximum: MAX_PAGE }),
        limit: positiveInteger(rawQuery.limit, { name: "limit", defaultValue: DEFAULT_PAGE_SIZE, maximum: MAX_PAGE_SIZE }),
    }
}

async function lean(query) {
    return typeof query?.lean === "function" ? query.lean() : query
}

/**
 * GET /public/discovery/search
 *
 * Stage 1 deliberately has no response cache. Every read performs the
 * authoritative visibility check so publication revocation and suspension fail
 * closed even if Redis, CDN, or a later Discovery frontend cache is stale.
 */
export async function searchDiscoveryPlaces(req, res, { businessModel = Business } = {}) {
    try {
        const options = parseDiscoverySearchQuery(req.query)
        const placeId = optionalText(req.query?.placeId, { name: "placeId", maxLength: 255 })
        if (placeId && options.nearby) {
            throw new PublicBusinessResolutionError("Choose a destination or nearby coordinates, not both")
        }
        if (placeId) {
            const resolved = await resolveDiscoveryDestination(placeId)
            options.countryCode = resolved.countryCode
            options.city = null
            options.bounds = resolved.bounds
        }
        const query = queryForDiscoverySearch(options)
        const sort = options.sort === "name_desc"
            ? { displayName: -1, _id: 1 }
            : { displayName: 1, _id: 1 }
        const sourceBusinesses = await lean(
            businessModel.find(query)
                .select(DISCOVERY_BUSINESS_SELECT)
                .sort(sort)
                .skip((options.page - 1) * options.limit)
                .limit(options.limit + 1),
        )
        const candidates = Array.isArray(sourceBusinesses) ? sourceBusinesses : []
        const results = candidates
            .slice(0, options.limit)
            .map(buildDiscoveryListingDto)
            .filter(Boolean)

        setDiscoveryNoStore(res)
        return res.json({
            results,
            pagination: {
                page: options.page,
                limit: options.limit,
                hasMore: candidates.length > options.limit,
            },
        })
    } catch (error) {
        if (error instanceof PublicBusinessResolutionError) {
            return res.status(error.statusCode).json({ error: error.message })
        }
        console.error("[discovery:search]", error)
        return res.status(500).json({ error: "Unable to search Chillow Discovery" })
    }
}

/** GET /public/discovery/places/:countryCode/:slug */
export async function getDiscoveryPlace(req, res, { businessModel = Business } = {}) {
    try {
        const locator = normalizePublicBusinessLocator({
            businessSlug: req.params?.slug,
            countryCode: req.params?.countryCode,
        })
        const { business } = await resolvePublicBusiness({
            ...locator,
            statuses: DISCOVERY_VISIBLE_BUSINESS_STATUSES,
            select: DISCOVERY_BUSINESS_SELECT,
            businessModel,
        })
        const place = buildDiscoveryPlaceDto(business)
        if (!place) return res.status(404).json({ error: "Place not found" })

        setDiscoveryNoStore(res)
        return res.json({ place })
    } catch (error) {
        if (error instanceof PublicBusinessResolutionError) {
            return res.status(error.statusCode).json({ error: error.message })
        }
        console.error("[discovery:place]", error)
        return res.status(500).json({ error: "Unable to load Chillow Discovery place" })
    }
}
