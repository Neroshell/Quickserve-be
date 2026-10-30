import test from "node:test"
import assert from "node:assert/strict"

import {
    getBusinessModuleCatalog,
    getDefaultBusinessModules,
    resolveBusinessCapabilities,
    resolveBusinessModules,
    setBusinessModuleEnabled,
    validateBusinessModulesForType,
} from "../src/services/businessCapabilityService.js"
import { resolveAllowedServicePointType } from "../src/controllers/servicePointController.js"
import {
    getOnboardingVenueTypeCatalog,
    resolveEffectiveVenueType,
    resolveVenueClassification,
} from "../src/constants/venueTypeCatalog.js"

test("legacy businesses resolve identity defaults without a stored modules array", () => {
    assert.deepEqual(resolveBusinessModules({ businessType: "restaurant" }), ["foodService"])
    assert.deepEqual(resolveBusinessModules({ businessType: "bar_lounge" }), ["foodService"])
    assert.deepEqual(resolveBusinessModules({ businessType: "hotel" }), ["lodging"])
})

test("restaurant capabilities expose the canonical owner navigation", () => {
    const capabilities = resolveBusinessCapabilities({
        businessType: "restaurant",
        modules: ["foodService"],
    })

    assert.equal(capabilities.identity.shell, "restaurant")
    assert.equal(capabilities.identity.venueType, "restaurant")
    assert.equal(capabilities.identity.venueLabel, "Restaurant")
    assert.equal(capabilities.reservations.primaryMode, "timeslot")
    assert.equal(capabilities.servicePoints.defaultType, "table")
    assert.equal(capabilities.terminology.servicePoint.singular, "Service Point")
    // Restaurant and bar Business Profiles are supported by the existing
    // property-profile controller; capability metadata must expose that route.
    assert.equal(capabilities.settings.sections.includes("propertyProfile"), true)
    assert.deepEqual(Object.keys(capabilities.terminology), ["servicePoint"])
    assert.equal("servicePointTypes" in capabilities.terminology, false)
    assert.deepEqual(
        capabilities.navigation.groups.map(({ id, items }) => ({ id, items })),
        [
            { id: "operations", items: ["orders", "transactions", "reservations"] },
            { id: "management", items: ["menu", "inventory", "servicePoints", "staff"] },
            { id: "insights", items: ["analytics", "feedback", "guests", "aiBusinessAnalyst"] },
            { id: "account", items: ["billing", "branding", "settings"] },
        ]
    )
})

test("food service extends a hotel without replacing the hotel shell", () => {
    const capabilities = resolveBusinessCapabilities({
        businessType: "hotel",
        modules: ["foodService", "lodging", "foodService"],
    })

    assert.equal(capabilities.identity.shell, "hotel")
    assert.deepEqual(capabilities.visibleModules, ["lodging", "foodService"])
    assert.equal(capabilities.reservations.primaryMode, "stay")
    assert.deepEqual(capabilities.reservations.modes, ["stay", "timeslot"])
    assert.equal(capabilities.servicePoints.defaultType, "room")
    assert.deepEqual(capabilities.servicePoints.allowedTypes, ["room", "other", "table", "booth"])
    assert.equal(capabilities.terminology.servicePoint.singular, "Service Point")
    assert.deepEqual(
        capabilities.navigation.groups.map(({ id }) => id),
        ["hotelOperations", "foodService", "management", "insights", "account"]
    )
    assert.deepEqual(
        capabilities.navigation.groups
            .filter(({ id }) => id === "hotelOperations" || id === "foodService")
            .map(({ id, items }) => ({ id, items })),
        [
            {
                id: "hotelOperations",
            items: ["reservations", "housekeeping", "transactions", "servicePoints"],
            },
            { id: "foodService", items: ["orders", "menu"] },
        ]
    )
    assert.deepEqual(
        capabilities.navigation.groups.find(({ id }) => id === "management")?.items,
        ["inventory", "staff"],
    )
    assert.deepEqual(capabilities.settings.sections, [
        "business",
        "propertyProfile",
        "operations",
        "lodging",
        "preferences",
        "foodService",
        "teamAccess",
        "security",
    ])
})

test("hotel-only navigation keeps transactions under hotel operations", () => {
    const capabilities = resolveBusinessCapabilities({
        businessType: "hotel",
        modules: ["lodging"],
    })

    assert.deepEqual(capabilities.navigation.groups[0], {
        id: "hotelOperations",
        label: "Hotel Operations",
        items: ["reservations", "housekeeping", "transactions", "servicePoints"],
    })
    assert.deepEqual(
        capabilities.navigation.groups.find(({ id }) => id === "management")?.items,
        ["inventory", "staff"],
    )
    assert.deepEqual(capabilities.settings.sections, [
        "business",
        "propertyProfile",
        "operations",
        "lodging",
        "preferences",
        "teamAccess",
        "security",
    ])
})

test("business identity modules cannot be removed", () => {
    assert.throws(
        () => validateBusinessModulesForType("restaurant", ["lodging"]),
        /foodService/
    )
    assert.throws(
        () => validateBusinessModulesForType("hotel", ["foodService"]),
        /lodging/
    )
})

test("hotel owners can toggle food service without changing hotel identity", () => {
    const hotel = { businessType: "hotel", modules: ["lodging"] }

    assert.deepEqual(setBusinessModuleEnabled(hotel, "foodService", true), ["lodging", "foodService"])
    assert.deepEqual(
        setBusinessModuleEnabled({ ...hotel, modules: ["lodging", "foodService"] }, "foodService", false),
        ["lodging"]
    )
})

test("the required restaurant food service module cannot be disabled", () => {
    assert.throws(
        () => setBusinessModuleEnabled(
            { businessType: "restaurant", modules: ["foodService"] },
            "foodService",
            false
        ),
        /At least one business module|required.*foodService|foodService.*required/
    )
})

test("legacy apartment identity resolves to the hotel compatibility shell", () => {
    const capabilities = resolveBusinessCapabilities({ businessType: "apartment" })
    assert.equal(capabilities.identity.businessType, "hotel")
    assert.equal(capabilities.identity.shell, "hotel")
    assert.deepEqual(capabilities.visibleModules, ["lodging"])
})

test("module catalog is the canonical source for admin defaults", () => {
    const catalog = getBusinessModuleCatalog()
    assert.deepEqual(catalog.defaultsByBusinessType.restaurant, getDefaultBusinessModules("restaurant"))
    assert.deepEqual(catalog.defaultsByBusinessType.hotel, getDefaultBusinessModules("hotel"))
    assert.deepEqual(catalog.modules.map(({ id }) => id), ["lodging", "foodService"])
})

test("venue classification catalog maps supported descriptive types to existing foundations", () => {
    const catalog = getOnboardingVenueTypeCatalog()
    const types = catalog.groups.flatMap(({ venueTypes }) => venueTypes)
    assert.deepEqual(types.map(({ id }) => id).sort(), [
        "aparthotel", "bakery", "bar_lounge", "cafe", "guest_house", "hostel", "hotel", "resort", "restaurant",
    ])

    for (const venueType of ["restaurant", "cafe", "bar_lounge", "bakery"]) {
        const classification = resolveVenueClassification({ venueType })
        assert.equal(classification.businessType, venueType === "bar_lounge" ? "bar_lounge" : "restaurant")
        assert.deepEqual(classification.defaultModules, ["foodService"])
    }
    for (const venueType of ["hotel", "resort", "aparthotel", "guest_house", "hostel"]) {
        const classification = resolveVenueClassification({ venueType })
        assert.equal(classification.businessType, "hotel")
        assert.deepEqual(classification.defaultModules, ["lodging"])
    }
})

test("capabilities retain canonical venue identity labels across supported classifications", () => {
    const supportedVenueTypes = [
        ["restaurant", "restaurant", "Restaurant"],
        ["cafe", "restaurant", "Café"],
        ["bakery", "restaurant", "Bakery"],
        ["bar_lounge", "bar_lounge", "Bar & Lounge"],
        ["hotel", "hotel", "Hotel"],
        ["resort", "hotel", "Resort"],
        ["aparthotel", "hotel", "Aparthotel"],
        ["guest_house", "hotel", "Guest house"],
        ["hostel", "hotel", "Hostel"],
    ]

    for (const [venueType, businessType, venueLabel] of supportedVenueTypes) {
        const capabilities = resolveBusinessCapabilities({ venueType, businessType })
        assert.equal(capabilities.identity.venueType, venueType)
        assert.equal(capabilities.identity.venueLabel, venueLabel)
    }
})

test("venue classification rejects unknown or contradictory values while legacy records remain readable", () => {
    assert.equal(resolveEffectiveVenueType({ businessType: "restaurant" }), "restaurant")
    assert.equal(resolveEffectiveVenueType({ businessType: "hotel" }), "hotel")
    assert.throws(() => resolveVenueClassification({ venueType: "spa" }), /Unsupported venueType/)
    assert.throws(
        () => resolveVenueClassification({ venueType: "cafe", businessType: "hotel" }),
        /incompatible with businessType/,
    )
    assert.throws(
        () => resolveVenueClassification({ venueType: "resort", accommodationType: "hotel" }),
        /incompatible with accommodationType/,
    )
})

test("unknown legacy business types are rejected rather than receiving restaurant capabilities", () => {
    assert.throws(
        () => resolveBusinessCapabilities({ businessType: "spa", modules: ["foodService"] }),
        /Unsupported business type: spa/,
    )
    assert.throws(
        () => getDefaultBusinessModules("spa"),
        /Unsupported business type: spa/,
    )
})

test("ServicePoint capabilities preserve generic schema-supported locations", () => {
    assert.deepEqual(
        resolveBusinessCapabilities({ businessType: "restaurant", modules: ["foodService"] }).servicePoints.allowedTypes,
        ["table", "booth", "other"],
    )
    assert.deepEqual(
        resolveBusinessCapabilities({ businessType: "hotel", modules: ["lodging"] }).servicePoints.allowedTypes,
        ["room", "other"],
    )
    assert.deepEqual(
        resolveBusinessCapabilities({ businessType: "hotel", modules: ["lodging", "foodService"] }).servicePoints.allowedTypes,
        ["room", "other", "table", "booth"],
    )
})

test("ServicePoint controller accepts only capability-enabled generic types", () => {
    const foodServiceBusiness = { businessType: "restaurant", modules: ["foodService"] }
    const lodgingBusiness = { businessType: "hotel", modules: ["lodging"] }

    assert.equal(resolveAllowedServicePointType(foodServiceBusiness, "booth"), "booth")
    assert.equal(resolveAllowedServicePointType(foodServiceBusiness, "other"), "other")
    assert.equal(resolveAllowedServicePointType(lodgingBusiness, "other"), "other")
    assert.equal(resolveAllowedServicePointType(lodgingBusiness, "table"), null)
    assert.equal(resolveAllowedServicePointType(lodgingBusiness, "counter"), null)
})

test("backend capability consumers load without syntax or import errors", async () => {
    const existingRedisUrl = process.env.REDIS_URL
    process.env.REDIS_URL = ""

    try {
        await Promise.all([
            import("../src/controllers/authController.js"),
            import("../src/controllers/businessController.js"),
            import("../src/controllers/onboardingController.js"),
            import("../src/controllers/publicController.js"),
            import("../src/controllers/servicePointController.js"),
            import("../src/routes/admin-route.js"),
        ])
    } finally {
        if (existingRedisUrl === undefined) delete process.env.REDIS_URL
        else process.env.REDIS_URL = existingRedisUrl
    }
})
