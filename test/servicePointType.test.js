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

test("ServicePoint capacity remains optional for hotel rooms", async () => {
    const path = ServicePoint.schema.path("capacity")

    assert.ok(path)
    assert.notEqual(path.options.required, true)

    const room = new ServicePoint({
        servicePointId: "sp_room_without_capacity",
        businessId: "hotel-1",
        label: "Room 102",
        code: "102",
        servicePointType: "room",
        roomType: "Deluxe",
        maxGuests: 2,
    })

    await room.validate()
    assert.equal(room.capacity, null)
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
            hotelRoomTypes: [
                { name: "Deluxe Suite", active: true },
            ],
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
                    capacity: null,
                    maxGuests: 2,
                    roomType: "  Deluxe   Suite ",
                },
            },
            response
        )

        assert.equal(response.statusCode, 201)
        assert.equal(created.servicePointType, "room")
        assert.equal(created.roomType, "Deluxe Suite")
        assert.equal(created.capacity, 2)
        assert.equal(created.maxGuests, 2)
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
            hotelRoomTypes: [
                { name: "Junior Suite", active: true },
            ],
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
                    capacity: null,
                    maxGuests: 3,
                    bedConfiguration: [],
                    viewType: null,
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
        assert.equal(captured.update.$set.capacity, 3)
        assert.equal(captured.update.$set.maxGuests, 3)
        assert.deepEqual(captured.update.$set.bedConfiguration, [])
        assert.equal(captured.update.$set.beds, 0)
        assert.equal(captured.update.$set.viewType, null)
    } finally {
        Business.findOne = originalBusinessFindOne
        ServicePoint.findOne = originalServicePointFindOne
        ServicePoint.findOneAndUpdate =
            originalFindOneAndUpdate
    }
})

test("create ServicePoint rejects an unmanaged hotel room type", async () => {
    const originalBusinessFindOne = Business.findOne
    const originalServicePointFindOne = ServicePoint.findOne
    let checkedForCollision = false

    Business.findOne = () => ({
        lean: async () => ({
            businessId: "hotel-1",
            businessType: "hotel",
            modules: ["lodging"],
            hotelRoomTypes: [
                { name: "Deluxe", active: true },
            ],
        }),
    })
    ServicePoint.findOne = async () => {
        checkedForCollision = true
        return null
    }

    try {
        const response = createResponse()
        await createServicePoint(
            {
                session: {
                    user: { businessId: "hotel-1" },
                },
                body: {
                    label: "Room 102",
                    code: "102",
                    roomType: "Penthouse",
                },
            },
            response
        )

        assert.equal(response.statusCode, 400)
        assert.match(response.body.error, /active configured hotel room type/i)
        assert.equal(checkedForCollision, false)
    } finally {
        Business.findOne = originalBusinessFindOne
        ServicePoint.findOne = originalServicePointFindOne
    }
})

test("update ServicePoint preserves its current inactive room type", async () => {
    const originalBusinessFindOne = Business.findOne
    const originalServicePointFindOne = ServicePoint.findOne
    const originalFindOneAndUpdate = ServicePoint.findOneAndUpdate
    let captured

    Business.findOne = () => ({
        lean: async () => ({
            businessId: "hotel-1",
            businessType: "hotel",
            modules: ["lodging"],
            hotelRoomTypes: [
                { name: "Heritage Room", active: false },
            ],
        }),
    })
    ServicePoint.findOne = () => ({
        lean: async () => ({
            servicePointId: "sp_legacy",
            businessId: "hotel-1",
            servicePointType: "room",
            roomType: "Heritage Room",
        }),
    })
    ServicePoint.findOneAndUpdate = async (filter, update) => {
        captured = { filter, update }
        return { servicePointId: "sp_legacy", ...update.$set }
    }

    try {
        const response = createResponse()
        await updateServicePoint(
            {
                session: { user: { businessId: "hotel-1" } },
                params: { servicePointId: "sp_legacy" },
                body: {
                    roomType: "  heritage   room ",
                    maxGuests: 4,
                },
            },
            response
        )

        assert.equal(response.statusCode, 200)
        assert.equal(captured.update.$set.roomType, "Heritage Room")
        assert.equal(captured.update.$set.capacity, 4)
        assert.deepEqual(captured.filter, {
            servicePointId: "sp_legacy",
            businessId: "hotel-1",
        })
    } finally {
        Business.findOne = originalBusinessFindOne
        ServicePoint.findOne = originalServicePointFindOne
        ServicePoint.findOneAndUpdate = originalFindOneAndUpdate
    }
})
