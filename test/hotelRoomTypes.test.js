import assert from "node:assert/strict"
import test from "node:test"
import { DEFAULT_HOTEL_ROOM_TYPES } from "../src/constants/hotelConstants.js"
import Business from "../src/models/Business.js"
import ServicePoint from "../src/models/ServicePoint.js"
import Reservation from "../src/models/Reservation.js"
import { addHotelRoomType, removeHotelRoomType } from "../src/controllers/businessController.js"
import { buildBackfillRoomTypes } from "../scripts/backfill-hotel-room-types.js"
const defaultRoomTypeCount = DEFAULT_HOTEL_ROOM_TYPES.length


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

// ----------------------------------------------------
// 1. DEFAULTS TESTS
// ----------------------------------------------------

test("DEFAULTS: starter room types carry stable default metadata", () => {
    assert.ok(defaultRoomTypeCount > 0)
    assert.equal(DEFAULT_HOTEL_ROOM_TYPES[0].name, "Standard")
    assert.equal(DEFAULT_HOTEL_ROOM_TYPES[0].isDefault, true)
    assert.equal(DEFAULT_HOTEL_ROOM_TYPES[0].active, true)
    assert.equal(DEFAULT_HOTEL_ROOM_TYPES.at(-1).name, "Apartment")
})

test("DEFAULTS: backfill helper safely adds starter defaults to an existing hotel without room types", () => {
    const backfilled = buildBackfillRoomTypes([])
    assert.equal(backfilled.length, defaultRoomTypeCount)
    assert.equal(backfilled[0].name, "Standard")
    assert.equal(backfilled[0].isDefault, true)
})

test("DEFAULTS: backfill helper is idempotent and does not duplicate existing types", () => {
    const initial = buildBackfillRoomTypes([])
    const secondRun = buildBackfillRoomTypes(initial)
    assert.equal(secondRun.length, defaultRoomTypeCount)
})

test("DEFAULTS: backfill helper preserves existing custom room types and appends missing defaults", () => {
    const existingCustom = [
        { name: "Heritage Suite", sortOrder: 1, active: true, isDefault: false },
        { name: "Standard", sortOrder: 2, active: true, isDefault: true }
    ]
    const merged = buildBackfillRoomTypes(existingCustom)
    // The custom type plus every configured default, without duplicating Standard.
    assert.equal(merged.length, defaultRoomTypeCount + 1)
    assert.equal(merged[0].name, "Heritage Suite")
    assert.equal(merged[0].isDefault, false)
    assert.ok(merged.some(rt => rt.name === "Deluxe"))
})

test("DEFAULTS: backfill repairs default metadata and appends after existing sort order", () => {
    const existing = [
        { name: "Penthouse", sortOrder: 20, active: true, isDefault: false },
        { name: "  standard  ", sortOrder: 4, active: false, isDefault: false }
    ]
    const merged = buildBackfillRoomTypes(existing)
    const standard = merged.find(rt => rt.name.trim().toLowerCase() === "standard")
    assert.equal(standard.active, true)
    assert.equal(standard.isDefault, true)
    assert.equal(merged.filter(rt => rt.name.trim().toLowerCase() === "standard").length, 1)

    const appendedDefaults = merged.filter(rt => rt.isDefault && rt !== standard)
    assert.ok(appendedDefaults.every(rt => rt.sortOrder > 20))
    assert.equal(new Set(merged.map(rt => rt.sortOrder)).size, merged.length)
    assert.deepEqual(buildBackfillRoomTypes(merged), merged)
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
        hotelRoomTypes: [...DEFAULT_HOTEL_ROOM_TYPES]
    })
    hotelBiz.save = async function() { return this }

    const origFindOne = Business.findOne
    Business.findOne = async () => hotelBiz

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
        assert.equal(res.body.roomType.sortOrder, defaultRoomTypeCount + 1)
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
        hotelRoomTypes: [...DEFAULT_HOTEL_ROOM_TYPES]
    })

    const origFindOne = Business.findOne
    Business.findOne = async () => hotelBiz

    try {
        const { req, res } = mockReqRes({
            user: { businessId: "biz_hotel_2", role: "owner" },
            body: { name: "  junior   suite  " } // "Junior Suite" already exists as default
        })
        await addHotelRoomType(req, res)
        assert.equal(res.statusCode, 400)
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
            ...DEFAULT_HOTEL_ROOM_TYPES,
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
        hotelRoomTypes: [...DEFAULT_HOTEL_ROOM_TYPES]
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
            ...DEFAULT_HOTEL_ROOM_TYPES,
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
        assert.equal(hotelBiz.hotelRoomTypes.length, defaultRoomTypeCount)
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
            ...DEFAULT_HOTEL_ROOM_TYPES,
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
        assert.equal(hotelBiz.hotelRoomTypes[defaultRoomTypeCount].active, false)
        assert.equal(hotelBiz.hotelRoomTypes[defaultRoomTypeCount].name, "Heritage Room")
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

test("SCHEMA DEFAULT: Business schema automatically initializes hotelRoomTypes for hotel businessType", () => {
    const hotel = new Business({
        businessId: "biz_schema_hotel",
        name: "Schema Hotel",
        displayName: "Schema Hotel",
        slug: "schema-hotel",
        businessType: "hotel"
    })
    assert.ok(Array.isArray(hotel.hotelRoomTypes))
    assert.equal(hotel.hotelRoomTypes.length, defaultRoomTypeCount)
    assert.equal(hotel.hotelRoomTypes[0].name, "Standard")
    assert.equal(hotel.hotelRoomTypes[0].isDefault, true)

    const restaurant = new Business({
        businessId: "biz_schema_rest",
        name: "Schema Bistro",
        displayName: "Schema Bistro",
        slug: "schema-bistro",
        businessType: "restaurant"
    })
    assert.equal(restaurant.hotelRoomTypes, undefined)
})
