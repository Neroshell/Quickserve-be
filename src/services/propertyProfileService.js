import { PROPERTY_PROFILE_CATALOG } from "../constants/propertyProfileCatalog.js"
import { BUSINESS_PROFILE_CATALOG } from "../constants/businessProfileCatalog.js"

function hasText(value) {
    return typeof value === "string" && value.trim().length > 0
}

function isAnswered(value) {
    return value === true || value === false
}

function serializePhoto(photo) {
    return {
        id: String(photo?._id || photo?.id || ""),
        url: photo?.url || "",
        publicId: photo?.publicId || "",
    }
}

// --- Hotel completeness checklist (unchanged from original) ---
function getHotelChecklist(business, profile, hotelSettings) {
    return [
        {
            id: "property_details",
            label: "Property details",
            category: "required",
            complete: hasText(business?.displayName) &&
                hasText(profile.description) &&
                hasText(profile.accommodationType),
        },
        {
            id: "location",
            label: "Location",
            category: "required",
            complete: hasText(business?.address) &&
                hasText(profile.city) &&
                hasText(business?.country),
        },
        {
            id: "arrival_departure",
            label: "Check-in & check-out",
            category: "required",
            complete: hasText(hotelSettings.checkInTime) &&
                hasText(hotelSettings.checkInUntil) &&
                hasText(hotelSettings.checkOutFrom) &&
                hasText(hotelSettings.checkOutTime) &&
                hasText(business?.timezone),
        },
        {
            id: "contact",
            label: "Guest contact",
            category: "required",
            complete: hasText(business?.phoneNumber) && hasText(business?.contactEmail),
        },
        {
            id: "photos",
            label: "Add property photos",
            category: "recommended",
            complete: Array.isArray(profile.photos) && profile.photos.length > 0,
        },
        {
            id: "facilities",
            label: "Facilities & services",
            category: "recommended",
            complete: Array.isArray(profile.facilityIds) &&
                profile.facilityIds.length > 0 &&
                isAnswered(profile.parking?.available) &&
                isAnswered(profile.breakfastOffered),
        },
        {
            id: "languages",
            label: "Languages spoken",
            category: "recommended",
            complete: Array.isArray(profile.languages) && profile.languages.length > 0,
        },
        {
            id: "policies",
            label: "House rules",
            category: "recommended",
            complete: isAnswered(profile.childrenAllowed) && hasText(profile.petsPolicy),
        },
    ]
}

// --- Restaurant & Bar completeness checklist ---
function getRestaurantBarChecklist(business, profile) {
    return [
        {
            id: "details",
            label: "Business details",
            category: "required",
            complete: hasText(business?.displayName) &&
                hasText(profile.tagline) &&
                hasText(profile.description) &&
                hasText(profile.diningStyle) &&
                profile.priceLevel != null,
        },
        {
            id: "location",
            label: "Location",
            category: "required",
            complete: hasText(business?.address) &&
                hasText(profile.city) &&
                hasText(business?.country),
        },
        {
            id: "cuisines",
            label: "Cuisine & concept",
            category: "required",
            complete: Array.isArray(profile.cuisineTypes) &&
                profile.cuisineTypes.length > 0 &&
                Array.isArray(profile.mealServices) &&
                profile.mealServices.length > 0,
        },
        {
            id: "contact",
            label: "Guest contact",
            category: "required",
            complete: hasText(business?.phoneNumber) && hasText(business?.contactEmail),
        },
        {
            id: "photos",
            label: "Photo gallery",
            category: "recommended",
            complete: Array.isArray(profile.photos) && profile.photos.length > 0,
        },
        {
            id: "atmosphere",
            label: "Atmosphere & experience",
            category: "recommended",
            complete: Array.isArray(profile.atmosphere) && profile.atmosphere.length >= 2,
        },
        {
            id: "facilities",
            label: "Facilities & parking",
            category: "recommended",
            complete: isAnswered(profile.parking?.available) &&
                Array.isArray(profile.facilityIds) &&
                profile.facilityIds.length > 0,
        },
        {
            id: "dietary",
            label: "Dietary & accessibility",
            category: "recommended",
            complete: (Array.isArray(profile.dietaryOptions) && profile.dietaryOptions.length > 0) ||
                (Array.isArray(profile.accessibility) && profile.accessibility.length > 0),
        },
        {
            id: "policies",
            label: "Guest policies",
            category: "recommended",
            complete: isAnswered(profile.childrenAllowed) && hasText(profile.petsPolicy),
        },
        {
            id: "languages_socials",
            label: "Languages & socials",
            category: "recommended",
            complete: (Array.isArray(profile.languages) && profile.languages.length > 0) &&
                (hasText(profile.websiteUrl) || hasText(profile.socialLinks?.instagram)),
        },
    ]
}

export function calculatePropertyProfileCompleteness(business) {
    const profile = business?.propertyProfile || {}
    const hotelSettings = business?.hotelSettings || {}
    const isHotel = business?.businessType === "hotel"

    const checklist = isHotel
        ? getHotelChecklist(business, profile, hotelSettings)
        : getRestaurantBarChecklist(business, profile)

    const completedCount = checklist.filter(item => item.complete).length
    const requiredItems = checklist.filter(item => item.category === "required")

    return {
        percentage: Math.round((completedCount / checklist.length) * 100),
        completedCount,
        totalCount: checklist.length,
        requiredComplete: requiredItems.every(item => item.complete),
        checklist,
    }
}

export function buildPropertyProfileResponse(business) {
    const profile = business?.propertyProfile || {}
    const hotelSettings = business?.hotelSettings || {}
    const photos = Array.isArray(profile.photos) ? profile.photos.map(serializePhoto) : []
    const isHotel = business.businessType === "hotel"

    // Base response shared by all shells
    const response = {
        businessId: business.businessId,
        businessType: business.businessType,
        details: {
            propertyName: business.displayName || "",
            description: profile.description || "",
        },
        location: {
            address: business.address || "",
            city: profile.city || "",
            region: profile.region || "",
            postalCode: profile.postalCode || "",
            country: business.country || "",
            countryCode: business.countryCode || "",
            verified: Boolean(
                business.addressPlaceId
                && Number.isFinite(business.latitude)
                && Number.isFinite(business.longitude)
            ),
            latitude: Number.isFinite(business.latitude) ? business.latitude : null,
            longitude: Number.isFinite(business.longitude) ? business.longitude : null,
        },
        photos,
        facilities: {
            facilityIds: Array.isArray(profile.facilityIds) ? [...profile.facilityIds] : [],
            parking: {
                available: profile.parking?.available ?? null,
                cost: profile.parking?.cost || null,
                reservation: profile.parking?.reservation || null,
                location: profile.parking?.location || null,
                access: profile.parking?.access || null,
            },
        },
        languages: Array.isArray(profile.languages) ? [...profile.languages] : [],
        policies: {
            childrenAllowed: profile.childrenAllowed ?? null,
            petsPolicy: profile.petsPolicy || null,
        },
        contact: {
            phone: business.phoneNumber || "",
            email: business.contactEmail || "",
            website: profile.websiteUrl || "",
            socialLinks: {
                instagram: profile.socialLinks?.instagram || "",
                facebook: profile.socialLinks?.facebook || "",
            },
        },
        completeness: calculatePropertyProfileCompleteness(business),
        updatedAt: business.updatedAt || null,
    }

    // Hotel-specific response fields
    if (isHotel) {
        response.details.accommodationType = profile.accommodationType || null
        response.details.starRating = profile.starRating ?? null
        response.facilities.breakfastOffered = profile.breakfastOffered ?? null
        response.arrivalDeparture = {
            checkInFrom: hotelSettings.checkInTime || "15:00",
            checkInUntil: hotelSettings.checkInUntil || "22:00",
            checkOutFrom: hotelSettings.checkOutFrom || "07:00",
            checkOutUntil: hotelSettings.checkOutTime || "11:00",
            timezone: business.timezone || "UTC",
        }
        response.catalogs = PROPERTY_PROFILE_CATALOG
    }

    // Restaurant/Bar-specific response fields
    if (!isHotel) {
        response.details.tagline = profile.tagline || ""
        response.details.priceLevel = profile.priceLevel ?? null
        response.details.diningStyle = profile.diningStyle || null
        response.cuisine = {
            cuisineTypes: Array.isArray(profile.cuisineTypes) ? [...profile.cuisineTypes] : [],
            mealServices: Array.isArray(profile.mealServices) ? [...profile.mealServices] : [],
        }
        response.atmosphere = {
            atmosphere: Array.isArray(profile.atmosphere) ? [...profile.atmosphere] : [],
            dressCode: profile.dressCode || null,
        }
        response.facilities.barHighlights = Array.isArray(profile.barHighlights) ? [...profile.barHighlights] : []
        response.dietaryAccessibility = {
            dietaryOptions: Array.isArray(profile.dietaryOptions) ? [...profile.dietaryOptions] : [],
            accessibility: Array.isArray(profile.accessibility) ? [...profile.accessibility] : [],
        }
        response.policies.reservationPolicy = profile.reservationPolicy || null
        response.catalogs = {
            ...PROPERTY_PROFILE_CATALOG,
            ...BUSINESS_PROFILE_CATALOG,
        }
    }

    return response
}

export { serializePhoto as serializePropertyPhoto }
