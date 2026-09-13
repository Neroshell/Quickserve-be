import { PROPERTY_PROFILE_CATALOG } from "../constants/propertyProfileCatalog.js"

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

export function calculatePropertyProfileCompleteness(business) {
    const profile = business?.propertyProfile || {}
    const hotelSettings = business?.hotelSettings || {}

    const checklist = [
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

    return {
        businessId: business.businessId,
        businessType: business.businessType,
        details: {
            propertyName: business.displayName || "",
            accommodationType: profile.accommodationType || null,
            description: profile.description || "",
            starRating: profile.starRating ?? null,
        },
        location: {
            address: business.address || "",
            city: profile.city || "",
            region: profile.region || "",
            postalCode: profile.postalCode || "",
            country: business.country || "",
            countryCode: business.countryCode || "",
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
            breakfastOffered: profile.breakfastOffered ?? null,
        },
        languages: Array.isArray(profile.languages) ? [...profile.languages] : [],
        arrivalDeparture: {
            checkInFrom: hotelSettings.checkInTime || "15:00",
            checkInUntil: hotelSettings.checkInUntil || "22:00",
            checkOutFrom: hotelSettings.checkOutFrom || "07:00",
            checkOutUntil: hotelSettings.checkOutTime || "11:00",
            timezone: business.timezone || "UTC",
        },
        policies: {
            childrenAllowed: profile.childrenAllowed ?? null,
            petsPolicy: profile.petsPolicy || null,
        },
        contact: {
            phone: business.phoneNumber || "",
            email: business.contactEmail || "",
            website: profile.websiteUrl || "",
        },
        completeness: calculatePropertyProfileCompleteness(business),
        catalogs: PROPERTY_PROFILE_CATALOG,
        updatedAt: business.updatedAt || null,
    }
}

export { serializePhoto as serializePropertyPhoto }
