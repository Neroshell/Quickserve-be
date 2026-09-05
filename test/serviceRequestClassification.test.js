import assert from "node:assert/strict"
import test from "node:test"
import ServiceRequest from "../src/models/ServiceRequest.js"
import { normalizeFoodServiceRequestCategory } from "../src/services/serviceRequestClassificationService.js"

test("ServiceRequest persists an explicit module, context, resource linkage, and normalized category", () => {
    const modulePath =
        ServiceRequest.schema.path("module")
    const contextPath =
        ServiceRequest.schema.path("contextType")

    assert.deepEqual(modulePath.enumValues, [
        "foodService",
        "lodging",
    ])
    assert.equal(modulePath.options.required, true)
    assert.equal(
        modulePath.options.default,
        "foodService"
    )
    assert.deepEqual(contextPath.enumValues, [
        "table_session",
        "reservation",
        "room_stay",
        "public",
    ])
    assert.ok(
        ServiceRequest.schema.path("reservationId")
    )
    assert.ok(
        ServiceRequest.schema.path("guestSessionId")
    )
    assert.ok(
        ServiceRequest.schema.path("servicePointId")
    )
    assert.ok(
        ServiceRequest.schema.path("requestCategory")
    )
})

test("existing waiter-call reasons normalize only to the supported food-service taxonomy", () => {
    assert.equal(
        normalizeFoodServiceRequestCategory(
            "Bill request"
        ),
        "request_bill"
    )
    assert.equal(
        normalizeFoodServiceRequestCategory(
            "Customer neeed Assistance"
        ),
        "assistance"
    )
    assert.equal(
        normalizeFoodServiceRequestCategory(
            "Emergency"
        ),
        "emergency"
    )
    assert.equal(
        normalizeFoodServiceRequestCategory(
            "Delayed order"
        ),
        "delayed_order"
    )
    assert.equal(
        normalizeFoodServiceRequestCategory(
            "Need more towels"
        ),
        "other"
    )
})
