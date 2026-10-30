import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildSetupProgressResponse } from "../src/controllers/setupProgressController.js";
import { resolveBusinessCapabilities } from "../src/services/businessCapabilityService.js";

const EMPTY_COUNTS = Object.freeze({
    menuItemCount: 0,
    servicePointCount: 0,
    roomCount: 0,
    readyRoomCount: 0,
    staffCount: 0,
    publicStayReservationsEnabled: true,
});

function accommodationBusiness(overrides = {}) {
    return {
        businessType: "hotel",
        venueType: "hotel",
        modules: ["lodging"],
        countryCode: "mt",
        slug: "harbour-hotel",
        status: "active",
        onboardingCompleted: false,
        stripeOnboardingComplete: false,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        settings: {},
        setupProgress: { setupGuideDismissed: false },
        ...overrides,
    };
}

function restaurantBusiness(overrides = {}) {
    return {
        businessType: "restaurant",
        venueType: "restaurant",
        modules: ["foodService"],
        status: "active",
        onboardingCompleted: false,
        stripeOnboardingComplete: false,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        settings: {},
        setupProgress: { setupGuideDismissed: false },
        ...overrides,
    };
}

function progress(business, countOverrides = {}) {
    return buildSetupProgressResponse(
        business,
        { ...EMPTY_COUNTS, ...countOverrides },
        resolveBusinessCapabilities(business),
    );
}

function task(result, id) {
    const value = result.tasks.find((candidate) => candidate.id === id);
    assert.ok(value, `Expected ${id} task`);
    return value;
}

test("new accommodation business recommends offline billing without making it a universal blocker", () => {
    const result = progress(accommodationBusiness());

    assert.equal(task(result, "service_point").completed, false);
    assert.equal(task(result, "room_readiness").completed, false);
    assert.equal(task(result, "payments_offline").classification, "recommended");
    assert.equal(task(result, "payments_offline").completed, false);
    assert.equal(task(result, "payments_online").completed, false);
    assert.equal(task(result, "reservation_settings").classification, "recommended");
    assert.equal(result.subtitle, "Get Ready to Welcome Guests");
    assert.equal(result.complete, false);
});

test("an accommodation offline payment method completes its recommended setup task", () => {
    const result = progress(accommodationBusiness({ defaultPaymentMethodId: "pm_accommodation_offline" }));

    assert.equal(task(result, "payments_offline").completed, true);
    assert.equal(task(result, "payments_offline").classification, "recommended");
    assert.equal(result.complete, false);
});

test("all supported lodging classifications use the accommodation task set", () => {
    for (const venueType of ["hotel", "resort", "aparthotel", "guest_house", "hostel"]) {
        const result = progress(accommodationBusiness({ venueType }));
        assert.ok(task(result, "room_readiness"), venueType);
        assert.equal(result.subtitle, "Get Ready to Welcome Guests", venueType);
    }
});

test("dining service points do not satisfy the first-room requirement", () => {
    const result = progress(accommodationBusiness({ modules: ["lodging", "foodService"] }), {
        servicePointCount: 1,
        roomCount: 0,
    });

    assert.equal(task(result, "service_point").completed, false);
    assert.equal(task(result, "room_readiness").completed, false);
});

test("a room without price and capacity does not satisfy lodging readiness", () => {
    const result = progress(accommodationBusiness(), { roomCount: 1, readyRoomCount: 0 });

    assert.equal(task(result, "service_point").completed, true);
    assert.equal(task(result, "room_readiness").completed, false);
});

test("a priced, capacity-configured room satisfies lodging readiness", () => {
    const result = progress(accommodationBusiness(), { roomCount: 1, readyRoomCount: 1 });

    assert.equal(task(result, "room_readiness").completed, true);
    assert.equal(task(result, "payments_online").completed, false);
});

test("only online payments remain a required accommodation setup blocker", () => {
    const result = progress(accommodationBusiness({ defaultPaymentMethodId: "pm_accommodation_billing" }), {
        roomCount: 1,
        readyRoomCount: 1,
    });

    assert.equal(task(result, "payments_offline").classification, "recommended");
    assert.equal(task(result, "payments_offline").completed, true);
    assert.equal(task(result, "payments_online").classification, "required");
    assert.equal(result.nextAction?.id, "payments_online");
    assert.equal(result.complete, false);
});

test("an accommodation can complete setup without offline billing", () => {
    const result = progress(accommodationBusiness({ stripeOnboardingComplete: true }), {
        roomCount: 1,
        readyRoomCount: 1,
    });

    assert.equal(task(result, "payments_online").completed, true);
    assert.equal(task(result, "payments_offline").completed, false);
    assert.equal(result.nextAction, null);
    assert.equal(result.complete, true);
});

test("accommodation setup completes without creating a reservation", () => {
    const result = progress(accommodationBusiness({
        stripeOnboardingComplete: true,
        defaultPaymentMethodId: "pm_accommodation_billing",
    }), {
        roomCount: 1,
        readyRoomCount: 1,
    });

    assert.equal(result.complete, true);
    assert.equal(result.nextAction, null);
    assert.equal(result.bookingReadiness?.operationalSetupComplete, true);
    assert.equal(result.bookingReadiness?.publicBookingEligible, false);
    assert.equal(result.tasks.some((candidate) => candidate.id === "verify"), false);
});

test("booking preview uses the canonical business country and slug", () => {
    const result = progress(accommodationBusiness({ countryCode: "ng", slug: "lagoon-resort" }));

    assert.equal(task(result, "booking_preview").href, "/reserve/ng/lagoon-resort?mode=stay");
    assert.equal(task(result, "booking_preview").classification, "recommended");
});

test("missing public identity omits the preview action instead of linking to a generic page", () => {
    const result = progress(accommodationBusiness({ countryCode: "", slug: "" }));

    assert.equal(result.tasks.some((candidate) => candidate.id === "booking_preview"), false);
});

test("disabled global reservations are visible without blocking operational completion", () => {
    const result = progress(accommodationBusiness({
        stripeOnboardingComplete: true,
        defaultPaymentMethodId: "pm_accommodation_billing",
        settings: { reservationsEnabled: false },
    }), { roomCount: 1, readyRoomCount: 1, publicStayReservationsEnabled: true });

    assert.equal(result.complete, true);
    assert.equal(result.bookingReadiness?.onlineReservationsEnabled, false);
    assert.equal(result.bookingReadiness?.publicBookingEligible, false);
});

test("disabled public stay mode is visible without creating a circular setup dependency", () => {
    const result = progress(accommodationBusiness({
        stripeOnboardingComplete: true,
        defaultPaymentMethodId: "pm_accommodation_billing",
        settings: { publicReservationModes: [] },
    }), { roomCount: 1, readyRoomCount: 1, publicStayReservationsEnabled: false });

    assert.equal(result.complete, true);
    assert.equal(task(result, "reservation_settings").completed, false);
    assert.equal(result.bookingReadiness?.publicStayReservationsEnabled, false);
});

test("hybrid lodging retains room requirements and keeps food service recommended", () => {
    const result = progress(accommodationBusiness({ modules: ["lodging", "foodService"] }));

    assert.ok(task(result, "room_readiness"));
    assert.equal(task(result, "food_service_menu").classification, "recommended");
    assert.equal(result.tasks.some((candidate) => candidate.id === "menu_item"), false);
});

test("incomplete hybrid food service does not block lodging setup completion", () => {
    const result = progress(accommodationBusiness({
        modules: ["lodging", "foodService"],
        stripeOnboardingComplete: true,
        defaultPaymentMethodId: "pm_hybrid_billing",
    }), { roomCount: 1, readyRoomCount: 1, menuItemCount: 0 });

    assert.equal(task(result, "food_service_menu").completed, false);
    assert.equal(result.complete, true);
});

test("restaurant task definitions stay free of accommodation requirements", () => {
    const result = progress(restaurantBusiness(), { servicePointCount: 1, menuItemCount: 1 });

    assert.deepEqual(result.tasks.map((candidate) => candidate.id), [
        "service_point",
        "menu_item",
        "team",
        "payments_offline",
        "payments_online",
    ]);
    assert.equal(result.complete, true);
    assert.equal(result.subtitle, "Get Ready to Accept Orders");
});

test("completion keeps the reservation eligibility fence and primary-owner route guard", async () => {
    const [controller, route] = await Promise.all([
        readFile(new URL("../src/controllers/setupProgressController.js", import.meta.url), "utf8"),
        readFile(new URL("../src/routes/owner-route.js", import.meta.url), "utf8"),
    ]);

    assert.match(controller, /withReservationEligibilityFence/);
    assert.match(controller, /onboardingCompleted: true/);
    assert.match(controller, /invalidateSetupProgress\(businessId\)/);
    assert.match(route, /router\.post\("\/setup-progress\/dismiss", requirePrimaryOwner, dismissSetupGuide\)/);
});
