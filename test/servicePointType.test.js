import assert from "node:assert/strict"
import test from "node:test"
import Business from "../src/models/Business.js"
import ServicePoint, {
    normalizeRoomType,
} from "../src/models/ServicePoint.js"
import {
    createServicePoint,
    resolveAllowedServicePointType,
    updateServicePoint,
} from "../src/controllers/servicePointController.js"

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code
            return this
        },
        json(body) {
            this.body = body
            return this
        },
    }
}

test("ServicePoint schema persists the canonical required type", () => {
    const path = ServicePoint.schema.path("servicePointType")

    assert.ok(path)
    assert.equal(path.options.required, true)
    assert.deepEqual(path.enumValues, [
        "table",
        "room",
        "booth",
        "other",
    ])
})

test("room type is normalized and is valid only for room ServicePoints", async () => {
    assert.equal(
        normalizeRoomType("  Deluxe   Suite  "),
        "Deluxe Suite"
    )
    assert.equal(normalizeRoomType("   "), null)

    const room = new ServicePoint({
        servicePointId: "sp_room",
        businessId: "hotel-1",
        label: "Room 101",
        code: "101",
        servicePointType: "room",
        roomType: "  Deluxe   Suite ",
        capacity: 2,
    })
    assert.equal(room.roomType, "Deluxe Suite")
    await room.validate()

    const table = new ServicePoint({
        servicePointId: "sp_table",
        businessId: "hotel-1",
        label: "Table 1",
        code: "T1",
        servicePointType: "table",
        roomType: "Deluxe Suite",
        capacity: 2,
    })
    await assert.rejects(
        table.validate(),
        /only available for room/i
    )
})

test("ServicePoint types resolve from server capabilities", () => {
    assert.equal(
        resolveAllowedServicePointType(
            {
                businessType: "restaurant",
                modules: ["foodService"],
            },
            undefined
        ),
        "table"
    )
    assert.equal(
        resolveAllowedServicePointType(
            {
                businessType: "hotel",
                modules: ["lodging"],
            },
            undefined
        ),
        "room"
    )
    assert.equal(
        resolveAllowedServicePointType(
            {
                businessType: "hotel",
                modules: ["lodging", "foodService"],
            },
            "table"
        ),
        "table"
    )
    assert.equal(
        resolveAllowedServicePointType(
            {
                businessType: "restaurant",
                modules: ["foodService"],
            },
            "room"
        ),
        null
    )
})

test("create ServicePoint persists the capability-resolved type", async () => {
    const originalBusinessFindOne = Business.findOne
    const originalServicePointFindOne = ServicePoint.findOne
    const originalServicePointCreate = ServicePoint.create
    let created

    Business.findOne = () => ({
        lean: async () => ({
            businessId: "hotel-1",
            businessType: "hotel",
            modules: ["lodging"],
        }),
    })
    ServicePoint.findOne = async () => null
    ServicePoint.create = async (input) => {
        created = input
        return input
    }

    try {
        const response = createResponse()
        await createServicePoint(
            {
                session: {
                    user: { businessId: "hotel-1" },
                },
                body: {
                    label: "Room 101",
                    code: "101",
                    capacity: 2,
                    roomType: "  Deluxe   Suite ",
                },
            },
            response
        )

        assert.equal(response.statusCode, 201)
        assert.equal(created.servicePointType, "room")
        assert.equal(created.roomType, "Deluxe Suite")
        assert.equal(created.businessId, "hotel-1")
    } finally {
        Business.findOne = originalBusinessFindOne
        ServicePoint.findOne = originalServicePointFindOne
        ServicePoint.create = originalServicePointCreate
    }
})

test("update ServicePoint validates and persists a requested type", async () => {
    const originalBusinessFindOne = Business.findOne
    const originalServicePointFindOne = ServicePoint.findOne
    const originalFindOneAndUpdate =
        ServicePoint.findOneAndUpdate
    let captured

    Business.findOne = () => ({
        lean: async () => ({
            businessId: "hotel-1",
            businessType: "hotel",
            modules: ["lodging", "foodService"],
        }),
    })
    ServicePoint.findOne = () => ({
        lean: async () => ({
            servicePointId: "sp_1",
            businessId: "hotel-1",
            servicePointType: "table",
            roomType: null,
        }),
    })
    ServicePoint.findOneAndUpdate = async (filter, update) => {
        captured = { filter, update }
        return {
            servicePointId: "sp_1",
            ...update.$set,
        }
    }

    try {
        const response = createResponse()
        await updateServicePoint(
            {
                session: {
                    user: { businessId: "hotel-1" },
                },
                params: { servicePointId: "sp_1" },
                body: {
                    servicePointType: "room",
                    roomType: "  Junior   Suite ",
                },
            },
            response
        )

        assert.equal(response.statusCode, 200)
        assert.deepEqual(captured.filter, {
            servicePointId: "sp_1",
            businessId: "hotel-1",
        })
        assert.equal(
            captured.update.$set.servicePointType,
            "room"
        )
        assert.equal(
            captured.update.$set.roomType,
            "Junior Suite"
        )
    } finally {
        Business.findOne = originalBusinessFindOne
        ServicePoint.findOne = originalServicePointFindOne
        ServicePoint.findOneAndUpdate =
            originalFindOneAndUpdate
    }
})
