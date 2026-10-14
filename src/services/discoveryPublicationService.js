import { evaluateBusinessOperatingStatus } from "../utils/operatingHours.js"

const DISCOVERY_VISIBLE_BUSINESS_STATUS = "active"
const MAX_SHORT_DESCRIPTION_LENGTH = 280

function hasText(value) {
    return typeof value === "string" && value.trim().length > 0
}

function validCountryCode(value) {
    return typeof value === "string" && /^[a-z]{2}$/i.test(value.trim())
}

function validPublicImageUrl(value) {
    if (!hasText(value)) return false
    try {
        const url = new URL(value)
        return url.protocol === "https:" || url.protocol === "http:"
    } catch {
        return false
    }
}

function publicCoverImage(business) {
    const firstPhoto = business?.propertyProfile?.photos?.[0]
    return validPublicImageUrl(firstPhoto?.url) ? firstPhoto.url.trim() : null
}

function publicGallery(business) {
    const photos = Array.isArray(business?.propertyProfile?.photos)
        ? business.propertyProfile.photos
        : []
    return photos
        .map((photo) => validPublicImageUrl(photo?.url) ? photo.url.trim() : null)
        .filter(Boolean)
}

function normalizedArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string" && item.trim())
        : []
}

function shortDescription(value) {
    if (!hasText(value)) return null
    const normalized = value.replace(/\s+/g, " ").trim()
    return normalized.length <= MAX_SHORT_DESCRIPTION_LENGTH
        ? normalized
        : `${normalized.slice(0, MAX_SHORT_DESCRIPTION_LENGTH - 1).trimEnd()}…`
}

/**
 * The one authority for Discovery publication eligibility. It deliberately
 * does not infer availability, billing, pricing, reviews, or any later-stage
 * capability from this lightweight profile foundation.
 */
export function evaluateDiscoveryPublicationEligibility(business) {
    const profile = business?.propertyProfile || {}
    const blockers = []

    if (business?.status !== DISCOVERY_VISIBLE_BUSINESS_STATUS) {
        blockers.push({
            code: "business_not_active",
            message: "Your business must be active before it can appear on Chillow Discovery.",
        })
    }
    if (!hasText(business?.displayName || business?.name)) {
        blockers.push({
            code: "business_name_required",
            message: "Add a guest-facing business name.",
        })
    }
    if (!validCountryCode(business?.countryCode) || !hasText(business?.country)) {
        blockers.push({
            code: "country_required",
            message: "Add a valid country to your business location.",
        })
    }
    if (!hasText(business?.address) || !hasText(profile.city)) {
        blockers.push({
            code: "public_location_required",
            message: "Add a public address and city to your Business Profile.",
        })
    }
    if (!publicCoverImage(business)) {
        blockers.push({
            code: "cover_photo_required",
            message: "Add a public cover photo to your Business Profile.",
        })
    }

    return {
        eligible: blockers.length === 0,
        blockers,
    }
}

export function getDiscoveryPublicationState(business) {
    const requested = business?.propertyProfile?.discoveryPublished === true
    const eligibility = evaluateDiscoveryPublicationEligibility(business)

    return {
        discoveryPublished: requested,
        publishedAt: business?.propertyProfile?.publishedAt || null,
        eligibility,
        effectivePublic: requested && eligibility.eligible,
    }
}

export function isDiscoveryBusinessVisible(business) {
    return getDiscoveryPublicationState(business).effectivePublic
}

export function buildDiscoveryListingDto(business) {
    if (!isDiscoveryBusinessVisible(business)) return null

    const profile = business.propertyProfile || {}
    const countryCode = business.countryCode.trim().toLowerCase()
    const slug = business.slug.trim().toLowerCase()

    return {
        id: business.businessId,
        name: business.displayName || business.name,
        businessType: business.businessType,
        countryCode,
        slug,
        location: {
            city: profile.city,
            region: profile.region || null,
            address: business.address,
            country: business.country,
        },
        coverImage: publicCoverImage(business),
        tagline: profile.tagline || null,
        shortDescription: shortDescription(profile.description),
        attributes: {
            accommodationType: profile.accommodationType || null,
            starRating: profile.starRating ?? null,
            diningStyle: profile.diningStyle || null,
            cuisineTypes: normalizedArray(profile.cuisineTypes),
            mealServices: normalizedArray(profile.mealServices),
            atmosphere: normalizedArray(profile.atmosphere),
            facilities: normalizedArray(profile.facilityIds),
            accessibility: normalizedArray(profile.accessibility),
            languages: normalizedArray(profile.languages),
        },
        paths: {
            storefront: `/b/${countryCode}/${slug}`,
            reservation: `/reserve/${countryCode}/${slug}`,
        },
        operatingStatus: {
            status: evaluateBusinessOperatingStatus(business).status,
        },
    }
}

export function buildDiscoveryPlaceDto(business) {
    const listing = buildDiscoveryListingDto(business)
    if (!listing) return null

    const profile = business.propertyProfile || {}
    return {
        ...listing,
        description: profile.description || null,
        gallery: publicGallery(business),
        contact: {
            phone: business.phoneNumber || null,
            website: profile.websiteUrl || null,
            socialLinks: {
                instagram: profile.socialLinks?.instagram || null,
                facebook: profile.socialLinks?.facebook || null,
            },
        },
        facilities: {
            ids: normalizedArray(profile.facilityIds),
            accessibility: normalizedArray(profile.accessibility),
            parking: profile.parking?.available === true
                ? {
                    available: true,
                    cost: profile.parking.cost || null,
                    reservation: profile.parking.reservation || null,
                    location: profile.parking.location || null,
                    access: profile.parking.access || null,
                }
                : { available: false },
        },
    }
}

export const DISCOVERY_BUSINESS_SELECT = [
    "businessId",
    "name",
    "displayName",
    "slug",
    "businessType",
    "status",
    "country",
    "countryCode",
    "address",
    "phoneNumber",
    "timezone",
    "operatingHours",
    "propertyProfile",
].join(" ")

export const DISCOVERY_VISIBLE_BUSINESS_STATUSES = Object.freeze([
    DISCOVERY_VISIBLE_BUSINESS_STATUS,
])
