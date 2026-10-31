import assert from "node:assert/strict"
import test from "node:test"

import { resolveDashboardMode } from "../src/controllers/ownerController.js"

test("hybrid dashboard permits the food-service view only when both effective modules are available", () => {
    assert.equal(resolveDashboardMode({
        requestedDashboard: "foodService",
        visibleModules: ["lodging", "foodService"],
    }), "foodService")

    assert.equal(resolveDashboardMode({
        requestedDashboard: "hotel",
        visibleModules: ["lodging", "foodService"],
    }), "hotel")
})

test("single-module and invalid dashboard requests retain the canonical dashboard", () => {
    assert.equal(resolveDashboardMode({
        requestedDashboard: "foodService",
        visibleModules: ["lodging"],
    }), "hotel")

    assert.equal(resolveDashboardMode({
        requestedDashboard: "hotel",
        visibleModules: ["foodService"],
    }), "foodService")

    assert.equal(resolveDashboardMode({
        requestedDashboard: "unknown",
        visibleModules: ["lodging", "foodService"],
    }), "hotel")
})
