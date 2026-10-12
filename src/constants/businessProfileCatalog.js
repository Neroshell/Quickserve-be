/**
 * businessProfileCatalog.js
 *
 * Curated catalogs for restaurant & bar business profiles.
 * These power the frontend multi-selects, tag clouds, and dropdowns
 * used in the Business Profile sections for F&B shells.
 *
 * Hotel-specific catalogs remain in propertyProfileCatalog.js —
 * the service layer merges the appropriate set into the API response
 * based on the business shell.
 */

export const DINING_STYLES = Object.freeze([
    { id: "fine_dining", label: "Fine Dining" },
    { id: "casual_dining", label: "Casual Dining" },
    { id: "bistro", label: "Bistro" },
    { id: "cafe", label: "Café / Coffee House" },
    { id: "fast_casual", label: "Fast Casual" },
    { id: "gastropub", label: "Gastropub" },
    { id: "cocktail_bar", label: "Cocktail Bar / Lounge" },
    { id: "wine_bar", label: "Wine Bar" },
    { id: "rooftop_bar", label: "Rooftop Bar" },
    { id: "beach_bar", label: "Beach Bar / Club" },
    { id: "pub", label: "Traditional Pub / Sports Bar" },
    { id: "bakery_patisserie", label: "Bakery & Patisserie" },
])

export const DINING_STYLE_IDS = Object.freeze(DINING_STYLES.map(s => s.id))

export const CUISINE_TYPES = Object.freeze([
    { id: "maltese", label: "Maltese" },
    { id: "mediterranean", label: "Mediterranean" },
    { id: "italian", label: "Italian" },
    { id: "seafood", label: "Seafood" },
    { id: "pizza", label: "Pizza" },
    { id: "steakhouse", label: "Steakhouse / Grill" },
    { id: "french", label: "French" },
    { id: "spanish_tapas", label: "Spanish & Tapas" },
    { id: "greek", label: "Greek" },
    { id: "japanese_sushi", label: "Japanese & Sushi" },
    { id: "asian_fusion", label: "Asian Fusion" },
    { id: "chinese", label: "Chinese" },
    { id: "thai", label: "Thai" },
    { id: "indian", label: "Indian" },
    { id: "middle_eastern", label: "Middle Eastern & Lebanese" },
    { id: "mexican", label: "Mexican" },
    { id: "american_burgers", label: "Burgers & American" },
    { id: "vegan_vegetarian", label: "Vegan & Vegetarian" },
    { id: "healthy_bowls", label: "Salads & Healthy Bowls" },
    { id: "desserts_gelato", label: "Desserts & Gelateria" },
])

export const CUISINE_TYPE_IDS = Object.freeze(CUISINE_TYPES.map(c => c.id))

export const MEAL_SERVICES = Object.freeze([
    { id: "breakfast", label: "Breakfast" },
    { id: "brunch", label: "Brunch" },
    { id: "lunch", label: "Lunch" },
    { id: "afternoon_tea", label: "Afternoon Tea" },
    { id: "dinner", label: "Dinner" },
    { id: "late_night", label: "Late Night" },
])

export const MEAL_SERVICE_IDS = Object.freeze(MEAL_SERVICES.map(m => m.id))

export const ATMOSPHERE_TAGS = Object.freeze([
    { id: "romantic", label: "Romantic" },
    { id: "waterfront_view", label: "Waterfront View" },
    { id: "scenic_view", label: "Scenic View" },
    { id: "outdoor_seating", label: "Outdoor Seating / Terrace" },
    { id: "cozy", label: "Cozy & Intimate" },
    { id: "lively", label: "Lively & Buzzing" },
    { id: "chic_upscale", label: "Chic & Upscale" },
    { id: "historic_setting", label: "Historic Setting" },
    { id: "family_friendly", label: "Family Friendly" },
    { id: "live_music", label: "Live Music" },
    { id: "dj_sets", label: "DJ Sets" },
    { id: "sports_screening", label: "Sports Screening" },
    { id: "business_friendly", label: "Business Friendly" },
])

export const ATMOSPHERE_TAG_IDS = Object.freeze(ATMOSPHERE_TAGS.map(a => a.id))

export const RESTAURANT_FACILITY_GROUPS = Object.freeze([
    {
        id: "dining_areas",
        label: "Dining areas & seating",
        facilities: Object.freeze([
            { id: "outdoor_terrace", label: "Outdoor terrace" },
            { id: "rooftop", label: "Rooftop area" },
            { id: "bar_seating", label: "Bar counter seating" },
            { id: "private_dining", label: "Private dining room" },
        ]),
    },
    {
        id: "comfort_amenities",
        label: "Comfort & connectivity",
        facilities: Object.freeze([
            { id: "air_conditioning", label: "Air conditioning" },
            { id: "free_wifi", label: "Free Wi-Fi" },
            { id: "high_chairs", label: "High chairs for children" },
            { id: "pet_friendly_patio", label: "Pet-friendly outdoor area" },
            { id: "tv_screens", label: "TV screens" },
            { id: "ev_charging", label: "EV charging station" },
        ]),
    },
])

export const RESTAURANT_FACILITY_IDS = Object.freeze(
    RESTAURANT_FACILITY_GROUPS.flatMap(group => group.facilities.map(f => f.id)),
)

export const BAR_HIGHLIGHTS = Object.freeze([
    { id: "craft_cocktails", label: "Craft cocktails" },
    { id: "curated_wine_list", label: "Extensive wine list" },
    { id: "craft_beer", label: "Craft / local beers" },
    { id: "sommelier_service", label: "Sommelier on staff" },
    { id: "happy_hour", label: "Happy hour specials" },
    { id: "byob", label: "BYOB allowed" },
])

export const BAR_HIGHLIGHT_IDS = Object.freeze(BAR_HIGHLIGHTS.map(b => b.id))

export const DIETARY_OPTIONS = Object.freeze([
    { id: "vegetarian_friendly", label: "Vegetarian friendly" },
    { id: "vegan_options", label: "Vegan options" },
    { id: "gluten_free_options", label: "Gluten-free options" },
    { id: "dairy_free_options", label: "Dairy-free options" },
    { id: "halal", label: "Halal options available" },
    { id: "kosher", label: "Kosher options available" },
    { id: "organic_local", label: "Organic / locally sourced" },
])

export const DIETARY_OPTION_IDS = Object.freeze(DIETARY_OPTIONS.map(d => d.id))

export const ACCESSIBILITY_FEATURES = Object.freeze([
    { id: "step_free_access", label: "Step-free entrance" },
    { id: "accessible_restroom", label: "Wheelchair-accessible restroom" },
    { id: "braille_menu", label: "Braille / large-print menu" },
    { id: "assistance_animals", label: "Service animals welcome" },
])

export const ACCESSIBILITY_FEATURE_IDS = Object.freeze(ACCESSIBILITY_FEATURES.map(a => a.id))

export const DRESS_CODES = Object.freeze([
    { id: "casual", label: "Casual" },
    { id: "smart_casual", label: "Smart Casual" },
    { id: "business_casual", label: "Business Casual" },
    { id: "formal", label: "Formal" },
])

export const DRESS_CODE_IDS = Object.freeze(DRESS_CODES.map(d => d.id))

export const RESERVATION_POLICIES = Object.freeze([
    { id: "walk_ins_welcome", label: "Walk-ins welcome" },
    { id: "reservations_recommended", label: "Reservations recommended" },
    { id: "reservations_required", label: "Reservations required" },
])

export const RESERVATION_POLICY_IDS = Object.freeze(RESERVATION_POLICIES.map(r => r.id))

/**
 * Composite catalog object sent to the frontend.
 * Merged into the API response alongside the hotel catalog when applicable.
 */
export const BUSINESS_PROFILE_CATALOG = Object.freeze({
    diningStyles: DINING_STYLES,
    cuisineTypes: CUISINE_TYPES,
    mealServices: MEAL_SERVICES,
    atmosphereTags: ATMOSPHERE_TAGS,
    restaurantFacilityGroups: RESTAURANT_FACILITY_GROUPS,
    barHighlights: BAR_HIGHLIGHTS,
    dietaryOptions: DIETARY_OPTIONS,
    accessibilityFeatures: ACCESSIBILITY_FEATURES,
    dressCodes: DRESS_CODES,
    reservationPolicies: RESERVATION_POLICIES,
})
