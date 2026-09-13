import assert from "node:assert/strict"
import test from "node:test"
import { HOTEL_ROOM_TYPE_NAME_SUGGESTIONS } from "../src/constants/hotelConstants.js"
import Business from "../src/models/Business.js"
import ServicePoint from "../src/models/ServicePoint.js"
import Reservation from "../src/models/Reservation.js"
import { addHotelRoomType, updateHotelRoomType, removeHotelRoomType } from "../src/controllers/businessController.js"

const legacyDefaultRoomType = { name: "Deluxe", sortOrder: 1, active: true, isDefault: true }


function mockReqRes({ user, body = {}, params = {}, query = {} } = {}) {
    const req = {
        session: { user },
        body,
        params,
        query
    }
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code
            return this
        },
        json(payload) {
            this.body = payload
            return this
        }
    }
    return { req, res }
}

test("ROOM TYPE CATALOG: standard names are suggestions, not configured defaults", () => {
    assert.deepEqual(HOTEL_ROOM_TYPE_NAME_SUGGESTIONS.slice(0, 4), [
        "Standard", "Superior", "Deluxe", "Executive",
    ])
    assert.equal(HOTEL_ROOM_TYPE_NAME_SUGGESTIONS.at(-1), "Apartment")
})

test("ROOM TYPE CATALOG: new hotels start without configured Room Types", () => {
    const hotel = new Business({
        businessId: "biz_empty_hotel",
        name: "Empty Hotel",
        displayName: "Empty Hotel",
        slug: "empty-hotel",
        businessType: "hotel",
    })
    assert.equal(hotel.hotelRoomTypes.length, 0)
})

test("DEFAULTS: restaurants receive no hotel room types", () => {
    const restaurant = new Business({
        businessId: "biz_rest_1",
        name: "Tasty Restaurant",
        displayName: "Tasty Restaurant",
        slug: "tasty-rest",
        businessType: "restaurant"
    })
    assert.equal(restaurant.hotelRoomTypes, undefined)
})

// ----------------------------------------------------
// 2. CUSTOM TYPES TESTS
// ----------------------------------------------------

test("CUSTOM TYPES: addHotelRoomType requires owner authentication", async () => {
    const { req, res } = mockReqRes({ user: null, body: { name: "Beach Villa" } })
    await addHotelRoomType(req, res)
    assert.equal(res.statusCode, 401)
})

test("CUSTOM TYPES: addHotelRoomType rejects non-hotel business", async () => {
    const restBiz = new Business({
        businessId: "biz_rest_2",
        name: "Bar & Grill",
        displayName: "Bar & Grill",
        slug: "bar-grill",
        businessType: "restaurant"
    })
    
    // Save to test in-memory mongoose if needed, or stub Business.findOne
    const origFindOne = Business.findOne
    Business.findOne = async () => restBiz

    try {
        const { req, res } = mockReqRes({
            user: { businessId: "biz_rest_2", role: "owner" },
            body: { name: "Cabana" }
        })
        await addHotelRoomType(req, res)
        assert.equal(res.statusCode, 403)
        assert.equal(res.body.message, "Only hotels can manage room types")
    } finally {
        Business.findOne = origFindOne
    }
})

test("CUSTOM TYPES: addHotelRoomType creates new custom room type and marks isDefault: false", async () => {
    const hotelBiz = new Business({
        businessId: "biz_hotel_1",
        name: "Grand Hotel",
        displayName: "Grand Hotel",
        slug: "grand-hotel",
        businessType: "hotel",
        hotelRoomTypes: []
    })
    hotelBiz.save = async function() { return this }

    const origFindOne = Business.findOne
    const origFindOneAndUpdate = Business.findOneAndUpdate
    Business.findOne = async () => hotelBiz
    Business.findOneAndUpdate = async (_filter, update) => {
        hotelBiz.hotelRoomTypes.push(update.$push.hotelRoomTypes)
        return hotelBiz
    }

    try {
        const { req, res } = mockReqRes({
            user: { businessId: "biz_hotel_1", role: "owner" },
            body: { name: "Heritage Suite" }
        })
        await addHotelRoomType(req, res)
        assert.equal(res.statusCode, 201)
        assert.equal(res.body.roomType.name, "Heritage Suite")
        assert.equal(res.body.roomType.isDefault, false)
        assert.equal(res.body.roomType.active, true)
        assert.equal(res.body.roomType.sortOrder, 1)
    } finally {
        Business.findOne = origFindOne
        Business.findOneAndUpdate = origFindOneAndUpdate
    }
})

test("CUSTOM TYPES: choosing a legacy suggested name promotes it into an owner-configured Room Type", async () => {
    const hotelBiz = new Business({
        businessId: "biz_hotel_legacy",
        name: "Legacy Hotel",
        displayName: "Legacy Hotel",
        slug: "legacy-hotel",
        businessType: "hotel",
        hotelRoomTypes: [legacyDefaultRoomType],
    })
    hotelBiz.save = async function() { return this }
    const origFindOne = Business.findOne
    Business.findOne = async () => hotelBiz

    try {
        const { req, res } = mockReqRes({
            user: { businessId: "biz_hotel_legacy", role: "owner" },
            body: { name: "Deluxe", description: "Owner configured deluxe rooms", maxGuests: 3 },
        })
        await addHotelRoomType(req, res)
        assert.equal(res.statusCode, 201)
        assert.equal(res.body.promoted, true)
        assert.equal(res.body.roomType.isDefault, false)
        assert.equal(res.body.roomType.description, "Owner configured deluxe rooms")
        assert.equal(res.body.roomType.maxGuests, 3)
    } finally {
        Business.findOne = origFindOne
    }
})

test("CUSTOM TYPES: configured Room Type metadata can be edited without renaming its identity", async () => {
    const hotelBiz = new Business({
        businessId: "biz_hotel_edit",
        name: "Editable Hotel",
        displayName: "Editable Hotel",
        slug: "editable-hotel",
        businessType: "hotel",
        hotelRoomTypes: [{ name: "Garden Suite", sortOrder: 1, active: true, isDefault: false }],
    })
    hotelBiz.save = async function() { return this }
    const origFindOne = Business.findOne
    Business.findOne = async () => hotelBiz

    try {
        const { req, res } = mockReqRes({
            user: { businessId: "biz_hotel_edit", role: "owner" },
            body: {
                currentName: "Garden Suite",
                name: "Garden Suite",
                description: "Updated garden-facing rooms",
                maxGuests: 4,
                bedConfiguration: [{ bedType: "Queen", count: 2 }],
                amenities: ["Balcony"],
                images: [],
            },
        })
        await updateHotelRoomType(req, res)
        assert.equal(res.statusCode, 200)
        assert.equal(res.body.roomType.name, "Garden Suite")
        assert.equal(res.body.roomType.description, "Updated garden-facing rooms")
        assert.equal(res.body.roomType.maxGuests, 4)
        assert.equal(res.body.roomType.bedConfiguration[0].bedType, "Queen")
    } finally {
        Business.findOne = origFindOne
    }
})

test("CUSTOM TYPES: addHotelRoomType prevents case-insensitive duplicates", async () => {
    const hotelBiz = new Business({
        businessId: "biz_hotel_2",
        name: "Grand Hotel",
        displayName: "Grand Hotel",
        slug: "grand-hotel-2",
        businessType: "hotel",
        hotelRoomTypes: [{ name: "Junior Suite", sortOrder: 1, active: true, isDefault: false }]
    })

    const origFindOne = Business.findOne
    Business.findOne = async () => hotelBiz

    try {
        const { req, res } = mockReqRes({
            user: { businessId: "biz_hotel_2", role: "owner" },
            body: { name: "  junior   suite  " }
        })
        await addHotelRoomType(req, res)
        assert.equal(res.statusCode, 409)
        assert.equal(res.body.message, "A room type with this name already exists")
    } finally {
        Business.findOne = origFindOne
    }
})

test("CUSTOM TYPES: addHotelRoomType reactivates an inactive custom room type when re-added", async () => {
    const hotelBiz = new Business({
        businessId: "biz_hotel_3",
        name: "Grand Hotel",
        displayName: "Grand Hotel",
        slug: "grand-hotel-3",
        businessType: "hotel",
        hotelRoomTypes: [
            { name: "Beach Villa", sortOrder: 15, active: false, isDefault: false }
        ]
    })
    hotelBiz.save = async function() { return this }

    const origFindOne = Business.findOne
    Business.findOne = async () => hotelBiz

    try {
        const { req, res } = mockReqRes({
            user: { businessId: "biz_hotel_3", role: "owner" },
            body: { name: "beach villa" }
        })
        await addHotelRoomType(req, res)
        assert.equal(res.statusCode, 200)
        assert.equal(res.body.roomType.name, "Beach Villa")
        assert.equal(res.body.roomType.active, true)
    } finally {
        Business.findOne = origFindOne
    }
})

// ----------------------------------------------------
// 3. REMOVAL TESTS
// ----------------------------------------------------

test("REMOVAL: default room types cannot be removed", async () => {
    const hotelBiz = new Business({
        businessId: "biz_hotel_4",
        name: "Grand Hotel",
        displayName: "Grand Hotel",
        slug: "grand-hotel-4",
        businessType: "hotel",
        hotelRoomTypes: [legacyDefaultRoomType]
    })

    const origFindOne = Business.findOne
    Business.findOne = async () => hotelBiz

    try {
        const { req, res } = mockReqRes({
            user: { businessId: "biz_hotel_4", role: "owner" },
            query: { name: "Deluxe" }
        })
        await removeHotelRoomType(req, res)
        assert.equal(res.statusCode, 400)
        assert.equal(res.body.message, "Default room types cannot be removed")
    } finally {
        Business.findOne = origFindOne
    }
})

test("REMOVAL: unused custom room type is hard-removed from hotelRoomTypes", async () => {
    const hotelBiz = new Business({
        businessId: "biz_hotel_5",
        name: "Grand Hotel",
        displayName: "Grand Hotel",
        slug: "grand-hotel-5",
        businessType: "hotel",
        hotelRoomTypes: [
            { name: "Unused Cottage", sortOrder: 15, active: true, isDefault: false }
        ]
    })
    hotelBiz.save = async function() { return this }

    const origFindOne = Business.findOne
    Business.findOne = async () => hotelBiz
    const origCountDocs = ServicePoint.countDocuments
    ServicePoint.countDocuments = async () => 0 // 0 rooms use it

    try {
        const { req, res } = mockReqRes({
            user: { businessId: "biz_hotel_5", role: "owner" },
            query: { name: "Unused Cottage" }
        })
        await removeHotelRoomType(req, res)
        assert.equal(res.statusCode, 200)
        assert.equal(res.body.removed, true)
        assert.equal(hotelBiz.hotelRoomTypes.length, 0)
    } finally {
        Business.findOne = origFindOne
        ServicePoint.countDocuments = origCountDocs
    }
})

test("REMOVAL: used custom room type is soft-deactivated (active: false) and preserves existing rooms", async () => {
    const hotelBiz = new Business({
        businessId: "biz_hotel_6",
        name: "Grand Hotel",
        displayName: "Grand Hotel",
        slug: "grand-hotel-6",
        businessType: "hotel",
        hotelRoomTypes: [
            { name: "Heritage Room", sortOrder: 15, active: true, isDefault: false }
        ]
    })
    hotelBiz.save = async function() { return this }

    const origFindOne = Business.findOne
    Business.findOne = async () => hotelBiz
    const origCountDocs = ServicePoint.countDocuments
    ServicePoint.countDocuments = async () => 3 // 3 rooms use it

    try {
        const { req, res } = mockReqRes({
            user: { businessId: "biz_hotel_6", role: "owner" },
            query: { name: "Heritage Room" }
        })
        await removeHotelRoomType(req, res)
        assert.equal(res.statusCode, 200)
        assert.equal(res.body.deactivated, true)
        assert.equal(res.body.inUseCount, 3)
        assert.ok(res.body.message.includes("currently used by 3 room(s)"))
        assert.equal(hotelBiz.hotelRoomTypes[0].active, false)
        assert.equal(hotelBiz.hotelRoomTypes[0].name, "Heritage Room")
    } finally {
        Business.findOne = origFindOne
        ServicePoint.countDocuments = origCountDocs
    }
})

// ----------------------------------------------------
// 4. REGRESSION & ISOLATION TESTS
// ----------------------------------------------------

test("REGRESSION: ServicePoint.roomType remains a string", () => {
    const sp = new ServicePoint({
        servicePointId: "sp_101",
        businessId: "biz_hotel_1",
        label: "Room 101",
        code: "101",
        servicePointType: "room",
        roomType: "Heritage Room",
        capacity: 2
    })
    assert.equal(typeof sp.roomType, "string")
    assert.equal(sp.roomType, "Heritage Room")
})

test("REGRESSION: Reservation.roomTypeSnapshot remains unchanged", () => {
    const resv = new Reservation({
        reservationId: "resv_1001",
        businessId: "biz_hotel_1",
        roomTypeSnapshot: "Heritage Room"
    })
    assert.equal(resv.roomTypeSnapshot, "Heritage Room")
})

test("SCHEMA DEFAULT: Business schema leaves hotel Room Types empty until owner creation", () => {
    const hotel = new Business({
        businessId: "biz_schema_hotel",
        name: "Schema Hotel",
        displayName: "Schema Hotel",
        slug: "schema-hotel",
        businessType: "hotel"
    })
    assert.ok(Array.isArray(hotel.hotelRoomTypes))
    assert.equal(hotel.hotelRoomTypes.length, 0)

    const restaurant = new Business({
        businessId: "biz_schema_rest",
        name: "Schema Bistro",
        displayName: "Schema Bistro",
        slug: "schema-bistro",
        businessType: "restaurant"
    })
    assert.equal(restaurant.hotelRoomTypes, undefined)
})
