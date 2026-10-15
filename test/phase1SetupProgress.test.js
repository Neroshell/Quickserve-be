import test from "node:test";
import assert from "node:assert/strict";

import { resolveBusinessCapabilities } from "../src/services/businessCapabilityService.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers replicated from setupProgressController.js
// ─────────────────────────────────────────────────────────────────────────────

function hasText(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function buildTasks(business, counts, capabilities) {
    const isHotel = capabilities.identity.shell === "hotel";
    const hasFoodService = capabilities.visibleModules.includes("foodService");

    const stripeConnected = business.stripeOnboardingComplete === true ||
        (business.stripeChargesEnabled === true && business.stripePayoutsEnabled === true);

    const offlinePaymentsConfigured = hasText(business.defaultPaymentMethodId);

    const tasks = [];
    let stage = 1;

    const servicePointLabel = isHotel ? "room" : "table";
    tasks.push({
        id: "service_point",
        stage: stage++,
        title: `Add your first ${servicePointLabel}`,
        classification: "required",
        completed: counts.servicePointCount > 0
    });

    if (hasFoodService) {
        tasks.push({
            id: "menu_item",
            stage: stage++,
            classification: "required",
            completed: counts.menuItemCount > 0
        });
    } else if (isHotel) {
        tasks.push({
            id: "room_readiness",
            stage: stage++,
            classification: "required",
            completed: counts.readyRoomCount > 0
        });
    }

    // Team — restaurant only
    if (!isHotel) {
        tasks.push({
            id: "team",
            stage: stage++,
            classification: "recommended",
            completed: counts.staffCount > 0
        });
    }

    // Offline payments — restaurant only
    if (!isHotel) {
        tasks.push({
            id: "payments_offline",
            stage: stage++,
            classification: "recommended",
            completed: offlinePaymentsConfigured
        });
    }

    tasks.push({
        id: "payments_online",
        stage: stage++,
        classification: isHotel ? "required" : "recommended",
        completed: stripeConnected
    });

    // Verify — hotel only
    if (isHotel) {
        tasks.push({
            id: "verify",
            stage: stage++,
            classification: "verification",
            completed: counts.orderCount > 0
        });
    }

    return tasks;
}

function buildSetupProgressResponse(business, counts, capabilities) {
    const tasks = buildTasks(business, counts, capabilities);

    const requiredTasks = tasks.filter(t => t.classification === "required");
    const completedRequiredCount = requiredTasks.filter(t => t.completed).length;

    const totalCoreCount = tasks.length;
    const completedCoreCount = tasks.filter(t => t.completed).length;

    const complete = completedCoreCount === totalCoreCount;

    let nextAction = null;
    for (const task of tasks) {
        if (!task.completed) {
            nextAction = task;
            break;
        }
    }

    return {
        tasks,
        nextAction,
        completedRequiredCount,
        totalRequiredCount: requiredTasks.length,
        completedCoreCount,
        totalCoreCount,
        progressPercent: totalCoreCount === 0 ? 100 : Math.round((completedCoreCount / totalCoreCount) * 100),
        complete,
        dismissed: business.setupProgress?.setupGuideDismissed === true,
        counts
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture factories
// ─────────────────────────────────────────────────────────────────────────────

function makeRestaurantBusiness(overrides = {}) {
    return {
        businessType: "restaurant",
        stripeOnboardingComplete: false,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        defaultPaymentMethodId: null,
        setupProgress: { setupGuideDismissed: false },
        ...overrides,
    };
}

function makeHotelBusiness(overrides = {}) {
    return {
        businessType: "hotel",
        stripeOnboardingComplete: false,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        defaultPaymentMethodId: null,
        setupProgress: { setupGuideDismissed: false },
        ...overrides,
    };
}

function makeEmptyCounts() {
    return { menuItemCount: 0, servicePointCount: 0, readyRoomCount: 0, staffCount: 0, orderCount: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTAURANT TASK SHAPE
// ─────────────────────────────────────────────────────────────────────────────

test("restaurant: has exactly 5 tasks — table, menu, team, offline pay, online pay", () => {
    const biz = makeRestaurantBusiness();
    const caps = resolveBusinessCapabilities(biz);
    const tasks = buildTasks(biz, makeEmptyCounts(), caps);

    const ids = tasks.map(t => t.id);
    assert.deepEqual(ids, ["service_point", "menu_item", "team", "payments_offline", "payments_online"]);
    assert.equal(tasks.length, 5);
});

test("restaurant: does not include verify or operating_hours", () => {
    const biz = makeRestaurantBusiness();
    const caps = resolveBusinessCapabilities(biz);
    const tasks = buildTasks(biz, makeEmptyCounts(), caps);

    assert.ok(!tasks.find(t => t.id === "verify"), "verify must not appear in restaurant journey");
    assert.ok(!tasks.find(t => t.id === "operating_hours"), "operating_hours must not appear in restaurant journey");
});

test("restaurant: task classifications are correct", () => {
    const biz = makeRestaurantBusiness();
    const caps = resolveBusinessCapabilities(biz);
    const tasks = buildTasks(biz, makeEmptyCounts(), caps);

    assert.equal(tasks.find(t => t.id === "service_point").classification, "required");
    assert.equal(tasks.find(t => t.id === "menu_item").classification, "required");
    assert.equal(tasks.find(t => t.id === "team").classification, "recommended");
    assert.equal(tasks.find(t => t.id === "payments_offline").classification, "recommended");
    assert.equal(tasks.find(t => t.id === "payments_online").classification, "recommended");
});

// ─────────────────────────────────────────────────────────────────────────────
// RESTAURANT PROGRESSIVE JOURNEY
// ─────────────────────────────────────────────────────────────────────────────

test("restaurant: completing table only → not complete, next action is menu_item", () => {
    const biz = makeRestaurantBusiness();
    const caps = resolveBusinessCapabilities(biz);
    const counts = { ...makeEmptyCounts(), servicePointCount: 1 };
    const progress = buildSetupProgressResponse(biz, counts, caps);

    assert.equal(progress.complete, false);
    assert.equal(progress.completedCoreCount, 1);
    assert.equal(progress.totalCoreCount, 5);
    assert.equal(progress.nextAction.id, "menu_item");
});

test("restaurant: table + menu → not complete, next action is team", () => {
    const biz = makeRestaurantBusiness();
    const caps = resolveBusinessCapabilities(biz);
    const counts = { ...makeEmptyCounts(), servicePointCount: 1, menuItemCount: 1 };
    const progress = buildSetupProgressResponse(biz, counts, caps);

    assert.equal(progress.complete, false);
    assert.equal(progress.completedCoreCount, 2);
    assert.equal(progress.nextAction.id, "team");
});

test("restaurant: 0/5 → 1/5 → 2/5 → 3/5 → 4/5 → 5/5 all progress correctly", () => {
    let biz = makeRestaurantBusiness();
    const caps = resolveBusinessCapabilities(biz);
    let counts = makeEmptyCounts();
    let progress;

    // 0/5
    progress = buildSetupProgressResponse(biz, counts, caps);
    assert.equal(progress.completedCoreCount, 0);
    assert.equal(progress.nextAction.id, "service_point");

    // 1/5
    counts.servicePointCount = 1;
    progress = buildSetupProgressResponse(biz, counts, caps);
    assert.equal(progress.completedCoreCount, 1);
    assert.equal(progress.nextAction.id, "menu_item");

    // 2/5
    counts.menuItemCount = 1;
    progress = buildSetupProgressResponse(biz, counts, caps);
    assert.equal(progress.completedCoreCount, 2);
    assert.equal(progress.nextAction.id, "team");

    // 3/5
    counts.staffCount = 1;
    progress = buildSetupProgressResponse(biz, counts, caps);
    assert.equal(progress.completedCoreCount, 3);
    assert.equal(progress.nextAction.id, "payments_offline");

    // 4/5 — still not complete
    biz.defaultPaymentMethodId = "pm_123";
    progress = buildSetupProgressResponse(biz, counts, caps);
    assert.equal(progress.completedCoreCount, 4);
    assert.equal(progress.complete, false);
    assert.equal(progress.nextAction.id, "payments_online");

    // 5/5 → complete
    biz.stripeOnboardingComplete = true;
    progress = buildSetupProgressResponse(biz, counts, caps);
    assert.equal(progress.completedCoreCount, 5);
    assert.equal(progress.complete, true);
    assert.equal(progress.nextAction, null);
});

test("restaurant: tracker count and percentage stay synchronized", () => {
    // table + menu + team = 3 of 5
    const biz = makeRestaurantBusiness();
    const caps = resolveBusinessCapabilities(biz);
    const counts = { ...makeEmptyCounts(), servicePointCount: 1, menuItemCount: 1, staffCount: 1 };
    const progress = buildSetupProgressResponse(biz, counts, caps);

    assert.equal(progress.completedCoreCount, 3);
    assert.equal(progress.totalCoreCount, 5);
    assert.equal(progress.progressPercent, 60);
});

// ─────────────────────────────────────────────────────────────────────────────
// HOTEL JOURNEY
// ─────────────────────────────────────────────────────────────────────────────

test("hotel: journey follows its own capability-aware task list (4 tasks: room, room_readiness, payments_online, verify)", () => {
    const biz = makeHotelBusiness();
    const caps = resolveBusinessCapabilities(biz);
    const counts = makeEmptyCounts();
    let progress = buildSetupProgressResponse(biz, counts, caps);

    assert.equal(progress.totalCoreCount, 4, "Hotel sequence has 4 tasks");
    const ids = progress.tasks.map(t => t.id);
    assert.deepEqual(ids, ["service_point", "room_readiness", "payments_online", "verify"]);
    assert.equal(progress.nextAction.id, "service_point");

    counts.servicePointCount = 1;
    progress = buildSetupProgressResponse(biz, counts, caps);
    assert.equal(progress.completedCoreCount, 1);
    assert.equal(progress.nextAction.id, "room_readiness");

    counts.readyRoomCount = 1;
    progress = buildSetupProgressResponse(biz, counts, caps);
    assert.equal(progress.completedCoreCount, 2);
    assert.equal(progress.nextAction.id, "payments_online");

    biz.stripeOnboardingComplete = true;
    progress = buildSetupProgressResponse(biz, counts, caps);
    assert.equal(progress.completedCoreCount, 3);
    assert.equal(progress.complete, false);
    assert.equal(progress.nextAction.id, "verify");

    counts.orderCount = 1;
    progress = buildSetupProgressResponse(biz, counts, caps);
    assert.equal(progress.completedCoreCount, 4);
    assert.equal(progress.complete, true);
    assert.equal(progress.nextAction, null);
});

test("hotel: does NOT include team, operating_hours, or payments_offline", () => {
    const biz = makeHotelBusiness();
    const caps = resolveBusinessCapabilities(biz);
    const tasks = buildTasks(biz, makeEmptyCounts(), caps);

    assert.ok(!tasks.find(t => t.id === "team"), "hotel must not have team task");
    assert.ok(!tasks.find(t => t.id === "operating_hours"), "hotel must not have operating_hours");
    assert.ok(!tasks.find(t => t.id === "payments_offline"), "hotel must not have payments_offline");
});

test("hotel: payments_online is required (Stripe Connect mandatory)", () => {
    const biz = makeHotelBusiness();
    const caps = resolveBusinessCapabilities(biz);
    const tasks = buildTasks(biz, makeEmptyCounts(), caps);

    const po = tasks.find(t => t.id === "payments_online");
    assert.ok(po, "payments_online task must exist for hotels");
    assert.equal(po.classification, "required");
});

// ─────────────────────────────────────────────────────────────────────────────
// DISMISSAL GATING
// ─────────────────────────────────────────────────────────────────────────────

test("restaurant: complete=false when only 4 of 5 steps done (payments_online missing)", () => {
    const biz = makeRestaurantBusiness({ defaultPaymentMethodId: "pm_123" });
    const caps = resolveBusinessCapabilities(biz);
    const counts = { ...makeEmptyCounts(), servicePointCount: 1, menuItemCount: 1, staffCount: 1 };
    const progress = buildSetupProgressResponse(biz, counts, caps);

    assert.equal(progress.completedCoreCount, 4);
    assert.equal(progress.complete, false);
});

test("restaurant: complete=true only when all 5 steps done", () => {
    const biz = makeRestaurantBusiness({ defaultPaymentMethodId: "pm_123", stripeOnboardingComplete: true });
    const caps = resolveBusinessCapabilities(biz);
    const counts = { ...makeEmptyCounts(), servicePointCount: 1, menuItemCount: 1, staffCount: 1 };
    const progress = buildSetupProgressResponse(biz, counts, caps);

    assert.equal(progress.completedCoreCount, 5);
    assert.equal(progress.complete, true);
});
