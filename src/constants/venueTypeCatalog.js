/**
 * Backend-owned descriptive venue taxonomy.
 *
 * `businessType` remains the legacy operational shell. This catalog only
 * describes the venue and maps it to an existing, supported shell/module
 * foundation; it does not grant permissions or enable extra workflows.
 */
const FOOD_AND_DRINKS = "food_and_drinks"
const ACCOMMODATION = "accommodation"

export const DISCOVERY_MODE_IDS = Object.freeze([
    "chill",
    "find_a_stay",
    "go_out",
])

export const VENUE_CLASSIFICATION_GROUPS = Object.freeze([
    Object.freeze({ id: ACCOMMODATION, label: "Accommodation" }),
    Object.freeze({ id: FOOD_AND_DRINKS, label: "Food & Drinks" }),
])

export const VENUE_TYPE_CATALOG = Object.freeze([
    Object.freeze({ id: "restaurant", label: "Restaurant", classificationGroup: FOOD_AND_DRINKS, legacyBusinessType: "restaurant", defaultModules: Object.freeze(["foodService"]), onboardingAvailable: true, accommodationType: null }),
    Object.freeze({ id: "cafe", label: "Café", classificationGroup: FOOD_AND_DRINKS, legacyBusinessType: "restaurant", defaultModules: Object.freeze(["foodService"]), onboardingAvailable: true, accommodationType: null }),
    Object.freeze({ id: "bar_lounge", label: "Bar & Lounge", classificationGroup: FOOD_AND_DRINKS, legacyBusinessType: "bar_lounge", defaultModules: Object.freeze(["foodService"]), onboardingAvailable: true, accommodationType: null }),
    Object.freeze({ id: "bakery", label: "Bakery", classificationGroup: FOOD_AND_DRINKS, legacyBusinessType: "restaurant", defaultModules: Object.freeze(["foodService"]), onboardingAvailable: true, accommodationType: null }),
    Object.freeze({ id: "hotel", label: "Hotel", classificationGroup: ACCOMMODATION, legacyBusinessType: "hotel", defaultModules: Object.freeze(["lodging"]), onboardingAvailable: true, accommodationType: "hotel" }),
    Object.freeze({ id: "resort", label: "Resort", classificationGroup: ACCOMMODATION, legacyBusinessType: "hotel", defaultModules: Object.freeze(["lodging"]), onboardingAvailable: true, accommodationType: "resort" }),
    Object.freeze({ id: "aparthotel", label: "Aparthotel", classificationGroup: ACCOMMODATION, legacyBusinessType: "hotel", defaultModules: Object.freeze(["lodging"]), onboardingAvailable: true, accommodationType: "aparthotel" }),
    Object.freeze({ id: "guest_house", label: "Guest house", classificationGroup: ACCOMMODATION, legacyBusinessType: "hotel", defaultModules: Object.freeze(["lodging"]), onboardingAvailable: true, accommodationType: "guest_house" }),
    Object.freeze({ id: "hostel", label: "Hostel", classificationGroup: ACCOMMODATION, legacyBusinessType: "hotel", defaultModules: Object.freeze(["lodging"]), onboardingAvailable: true, accommodationType: "hostel" }),
])

export const VENUE_TYPE_IDS = Object.freeze(VENUE_TYPE_CATALOG.map(({ id }) => id))

const VENUE_TYPE_BY_ID = new Map(VENUE_TYPE_CATALOG.map((entry) => [entry.id, entry]))
const DEFAULT_VENUE_TYPE_BY_LEGACY_BUSINESS_TYPE = Object.freeze({
    restaurant: "restaurant",
    bar_lounge: "bar_lounge",
    hotel: "hotel",
})

export class VenueTypeValidationError extends TypeError {
    constructor(message) {
        super(message)
        this.name = "VenueTypeValidationError"
    }
}

function normalizeVenueType(value) {
    if (typeof value !== "string" || value.trim() !== value || !value) {
        throw new VenueTypeValidationError("venueType must be a supported venue type")
    }
    return value
}

export function getVenueTypeDefinition(venueType) {
    if (typeof venueType !== "string") return null
    return VENUE_TYPE_BY_ID.get(venueType) || null
}

export function getDefaultVenueTypeForBusinessType(businessType) {
    return DEFAULT_VENUE_TYPE_BY_LEGACY_BUSINESS_TYPE[businessType] || null
}

/**
 * Resolve Discovery classifications from the canonical venue catalog. These
 * modes are consumer search intents, not operational modules or permissions.
 */
export function getVenueTypesForDiscoveryMode(mode) {
    if (!DISCOVERY_MODE_IDS.includes(mode)) return null
    if (mode === "chill") return [...VENUE_TYPE_IDS]

    const requiredModule = mode === "find_a_stay" ? "lodging" : "foodService"
    return VENUE_TYPE_CATALOG
        .filter((venueType) => venueType.defaultModules.includes(requiredModule))
        .map((venueType) => venueType.id)
}

/**
 * Legacy Business documents do not always persist venueType. Search them
 * through their catalog-mapped shell so they remain discoverable during the
 * additive migration.
 */
export function getLegacyBusinessTypesForDiscoveryMode(mode) {
    const venueTypes = getVenueTypesForDiscoveryMode(mode)
    if (!venueTypes) return null
    return [...new Set(venueTypes.map((venueType) => (
        getVenueTypeDefinition(venueType)?.legacyBusinessType
    )).filter(Boolean))]
}

/**
 * Resolve the one allowed descriptive/legacy pairing. Callers must persist the
 * returned values rather than trusting a client-supplied businessType/modules.
 */
export function resolveVenueClassification({ venueType, businessType, accommodationType } = {}) {
    const resolvedVenueType = venueType === undefined || venueType === null || venueType === ""
        ? getDefaultVenueTypeForBusinessType(businessType)
        : normalizeVenueType(venueType)
    const definition = getVenueTypeDefinition(resolvedVenueType)

    if (!definition) {
        throw new VenueTypeValidationError(`Unsupported venueType: ${String(venueType ?? businessType)}`)
    }
    if (businessType && businessType !== definition.legacyBusinessType) {
        throw new VenueTypeValidationError(
            `venueType ${definition.id} is incompatible with businessType ${businessType}`,
        )
    }
    if (accommodationType !== undefined && accommodationType !== null && accommodationType !== "") {
        if (definition.accommodationType !== accommodationType) {
            throw new VenueTypeValidationError(
                `venueType ${definition.id} is incompatible with accommodationType ${accommodationType}`,
            )
        }
    }

    return {
        venueType: definition.id,
        businessType: definition.legacyBusinessType,
        defaultModules: [...definition.defaultModules],
        definition,
    }
}

/**
 * Legacy Business documents predate venueType. Derive their descriptive value
 * for read contracts without writing or mutating those records.
 */
export function resolveEffectiveVenueType(business) {
    const explicit = getVenueTypeDefinition(business?.venueType)
    if (explicit) return explicit.id
    return getDefaultVenueTypeForBusinessType(business?.businessType)
}

export function getOnboardingVenueTypeCatalog() {
    return {
        version: 1,
        groups: VENUE_CLASSIFICATION_GROUPS.map((group) => ({
            ...group,
            venueTypes: VENUE_TYPE_CATALOG
                .filter((venueType) => venueType.onboardingAvailable && venueType.classificationGroup === group.id)
                .map(({ id, label, classificationGroup, legacyBusinessType, defaultModules, onboardingAvailable }) => ({
                    id,
                    label,
                    classificationGroup,
                    legacyBusinessType,
                    defaultModules: [...defaultModules],
                    onboardingAvailable,
                })),
        })),
    }
}
