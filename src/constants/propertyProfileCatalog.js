export const PROPERTY_ACCOMMODATION_TYPES = Object.freeze([
    { id: "hotel", label: "Hotel" },
    { id: "aparthotel", label: "Aparthotel" },
    { id: "guest_house", label: "Guest house" },
    { id: "bed_and_breakfast", label: "Bed & breakfast" },
    { id: "resort", label: "Resort" },
    { id: "hostel", label: "Hostel" },
    { id: "apartment", label: "Apartment" },
    { id: "villa", label: "Villa" },
    { id: "other", label: "Other accommodation" },
])

export const PROPERTY_FACILITY_GROUPS = Object.freeze([
    {
        id: "food_and_drink",
        label: "Food & drink",
        facilities: Object.freeze([
            { id: "restaurant", label: "Restaurant" },
            { id: "bar", label: "Bar" },
            { id: "room_service", label: "Room service" },
        ]),
    },
    {
        id: "guest_services",
        label: "Guest services",
        facilities: Object.freeze([
            { id: "front_desk_24h", label: "24-hour front desk" },
            { id: "concierge", label: "Concierge" },
            { id: "luggage_storage", label: "Luggage storage" },
            { id: "airport_shuttle", label: "Airport shuttle" },
        ]),
    },
    {
        id: "wellness",
        label: "Wellness & leisure",
        facilities: Object.freeze([
            { id: "swimming_pool", label: "Swimming pool" },
            { id: "spa", label: "Spa" },
            { id: "fitness_centre", label: "Fitness centre" },
            { id: "sauna", label: "Sauna" },
            { id: "hot_tub", label: "Hot tub / Jacuzzi" },
        ]),
    },
    {
        id: "outdoors",
        label: "Outdoors",
        facilities: Object.freeze([
            { id: "garden", label: "Garden" },
            { id: "terrace", label: "Terrace" },
            { id: "beach_access", label: "Beach access" },
            { id: "water_park", label: "Water park" },
        ]),
    },
    {
        id: "general",
        label: "General",
        facilities: Object.freeze([
            { id: "free_wifi", label: "Free Wi-Fi" },
            { id: "air_conditioning", label: "Air conditioning" },
            { id: "non_smoking_rooms", label: "Non-smoking rooms" },
            { id: "family_rooms", label: "Family rooms" },
            { id: "elevator", label: "Elevator" },
            { id: "ev_charging", label: "Electric vehicle charging" },
        ]),
    },
])

export const PROPERTY_FACILITY_IDS = Object.freeze(
    PROPERTY_FACILITY_GROUPS.flatMap(group => group.facilities.map(facility => facility.id)),
)

export const PROPERTY_LANGUAGE_OPTIONS = Object.freeze([
    { id: "ar", label: "Arabic" },
    { id: "bg", label: "Bulgarian" },
    { id: "ca", label: "Catalan" },
    { id: "zh", label: "Chinese" },
    { id: "hr", label: "Croatian" },
    { id: "cs", label: "Czech" },
    { id: "da", label: "Danish" },
    { id: "nl", label: "Dutch" },
    { id: "en", label: "English" },
    { id: "et", label: "Estonian" },
    { id: "fi", label: "Finnish" },
    { id: "fr", label: "French" },
    { id: "de", label: "German" },
    { id: "el", label: "Greek" },
    { id: "he", label: "Hebrew" },
    { id: "hi", label: "Hindi" },
    { id: "hu", label: "Hungarian" },
    { id: "is", label: "Icelandic" },
    { id: "id", label: "Indonesian" },
    { id: "it", label: "Italian" },
    { id: "ja", label: "Japanese" },
    { id: "ko", label: "Korean" },
    { id: "lv", label: "Latvian" },
    { id: "lt", label: "Lithuanian" },
    { id: "mt", label: "Maltese" },
    { id: "no", label: "Norwegian" },
    { id: "pl", label: "Polish" },
    { id: "pt", label: "Portuguese" },
    { id: "ro", label: "Romanian" },
    { id: "ru", label: "Russian" },
    { id: "sr", label: "Serbian" },
    { id: "sk", label: "Slovak" },
    { id: "sl", label: "Slovenian" },
    { id: "es", label: "Spanish" },
    { id: "sv", label: "Swedish" },
    { id: "th", label: "Thai" },
    { id: "tr", label: "Turkish" },
    { id: "uk", label: "Ukrainian" },
    { id: "vi", label: "Vietnamese" },
])

export const PROPERTY_LANGUAGE_IDS = Object.freeze(
    PROPERTY_LANGUAGE_OPTIONS.map(language => language.id),
)

export const PROPERTY_PROFILE_CATALOG = Object.freeze({
    accommodationTypes: PROPERTY_ACCOMMODATION_TYPES,
    facilityGroups: PROPERTY_FACILITY_GROUPS,
    languages: PROPERTY_LANGUAGE_OPTIONS,
})
