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

test("legacy businesses resolve identity defaults without a stored modules array", () => {
    assert.deepEqual(resolveBusinessModules({ businessType: "restaurant" }), ["foodService"])
    assert.deepEqual(resolveBusinessModules({ businessType: "bar_lounge" }), ["foodService"])
    assert.deepEqual(resolveBusinessModules({ businessType: "hotel" }), ["lodging"])
})

test("restaurant capabilities preserve the existing owner navigation", () => {
    const capabilities = resolveBusinessCapabilities({
        businessType: "restaurant",
        modules: ["foodService"],
    })

    assert.equal(capabilities.identity.shell, "restaurant")
    assert.equal(capabilities.reservations.primaryMode, "timeslot")
    assert.equal(capabilities.servicePoints.defaultType, "table")
    assert.equal(capabilities.terminology.servicePoint.singular, "Service Point")
    assert.deepEqual(Object.keys(capabilities.terminology), ["servicePoint"])
    assert.equal("servicePointTypes" in capabilities.terminology, false)
    assert.deepEqual(
        capabilities.navigation.groups.map(({ id, items }) => ({ id, items })),
        [
            { id: "operations", items: ["orders", "transactions", "reservations"] },
            { id: "management", items: ["menu", "servicePoints", "staff"] },
            { id: "insights", items: ["analytics", "feedback", "guests"] },
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
    assert.deepEqual(capabilities.servicePoints.allowedTypes, ["room", "table"])
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
                items: ["reservations", "transactions", "servicePoints"],
            },
            { id: "foodService", items: ["orders", "menu"] },
        ]
    )
})

test("hotel-only navigation keeps transactions under hotel operations", () => {
    const capabilities = resolveBusinessCapabilities({
        businessType: "hotel",
        modules: ["lodging"],
    })

    assert.deepEqual(capabilities.navigation.groups[0], {
        id: "hotelOperations",
        label: "Hotel Operations",
        items: ["reservations", "transactions", "servicePoints"],
    })
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

test("backend capability consumers load without syntax or import errors", async () => {
    await Promise.all([
        import("../src/controllers/authController.js"),
        import("../src/controllers/businessController.js"),
        import("../src/controllers/onboardingController.js"),
        import("../src/controllers/publicController.js"),
        import("../src/controllers/servicePointController.js"),
        import("../src/routes/admin-route.js"),
    ])
})
