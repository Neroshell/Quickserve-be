import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import Business from "../src/models/Business.js"
import ServicePoint from "../src/models/ServicePoint.js"
import { normalizeHotelRoomTypePayload } from "../src/controllers/businessController.js"
import { resolveAllowedServicePointType } from "../src/controllers/servicePointController.js"
import {
    SERVICE_POINTS_CHANGED_EVENT,
    publishServicePointsChanged,
} from "../src/utils/sseManager.js"

test("Room Type templates remain embedded Business configuration with canonical metadata", () => {
    const roomTypeSchema = Business.schema.path("hotelRoomTypes").schema
    for (const path of [
        "name",
        "description",
        "roomSize",
        "roomSizeUnit",
        "maxGuests",
        "bedConfiguration",
        "viewType",
        "amenities",
        "images",
    ]) {
        assert.ok(roomTypeSchema.path(path), `missing hotelRoomTypes.${path}`)
    }
    assert.equal(Business.db.models.Room, undefined)
})

test("standard Room Type names are suggestions rather than automatically configured records", async () => {
    const hotel = new Business({
        businessId: "biz_hotel_empty_types",
        name: "Empty Types Hotel",
        displayName: "Empty Types Hotel",
        slug: "empty-types-hotel",
        businessType: "hotel",
    })
    const controllerSource = await readFile(new URL("../src/controllers/businessController.js", import.meta.url), "utf8")
    assert.equal(hotel.hotelRoomTypes.length, 0)
    assert.match(controllerSource, /HOTEL_ROOM_TYPE_NAME_SUGGESTIONS/)
    assert.match(controllerSource, /roomType\.isDefault !== true/)
    assert.match(controllerSource, /export async function updateHotelRoomType/)
})

test("Room Type payload normalization preserves capacity, beds, amenities, photos, and arbitrary names", () => {
    const result = normalizeHotelRoomTypePayload({
        name: "  Garden   Suite  ",
        description: " A quiet garden room. ",
        roomSize: "42",
        roomSizeUnit: "m2",
        maxGuests: "3",
        bedConfiguration: [
            { bedType: "King", count: 1 },
            { bedType: "Sofa Bed", count: 1 },
        ],
        viewType: "Garden View",
        amenities: ["Free WiFi", "Free WiFi", "Coffee Maker"],
        images: ["https://cdn.example/room-1.webp"],
    })

    assert.equal(result.error, undefined)
    assert.deepEqual(result.value, {
        name: "Garden Suite",
        description: "A quiet garden room.",
        roomSize: 42,
        roomSizeUnit: "m2",
        maxGuests: 3,
        bedConfiguration: [
            { bedType: "King", count: 1 },
            { bedType: "Sofa Bed", count: 1 },
        ],
        viewType: "Garden View",
        amenities: ["Free WiFi", "Coffee Maker"],
        images: ["https://cdn.example/room-1.webp"],
    })
})

test("invalid Room Type capacity, duplicate beds, and unsupported size units fail closed", () => {
    assert.match(normalizeHotelRoomTypePayload({ name: "Suite", maxGuests: 0 }).error, /maxGuests/)
    assert.match(normalizeHotelRoomTypePayload({ name: "Suite", roomSizeUnit: "yards" }).error, /roomSizeUnit/)
    assert.match(normalizeHotelRoomTypePayload({
        name: "Suite",
        bedConfiguration: [
            { bedType: "King", count: 1 },
            { bedType: "king", count: 2 },
        ],
    }).error, /duplicate bed types/)
})

test("hotel capabilities accept rooms and reject cross-capability ServicePoint types", () => {
    const hotel = { businessType: "hotel", modules: ["lodging"], hotelRoomTypes: [] }
    assert.equal(resolveAllowedServicePointType(hotel, "room"), "room")
    assert.equal(resolveAllowedServicePointType(hotel, "table"), null)
})

test("ServicePoint remains room identity and stores independent lifecycle states", () => {
    const room = new ServicePoint({
        servicePointId: "sp_room_401",
        businessId: "biz_hotel_a",
        label: "Villa Azure",
        code: "VILLA-A",
        servicePointType: "room",
        roomType: "Garden Suite",
        capacity: 4,
        maxGuests: 4,
        isActive: true,
        reservable: false,
    })

    assert.equal(room.validateSync(), undefined)
    assert.equal(room.label, "Villa Azure")
    assert.equal(room.servicePointType, "room")
    assert.equal(room.isActive, true)
    assert.equal(room.reservable, false)
})

test("ServicePoint owner creation uses tenant-scoped durable idempotency without exposing metadata", async () => {
    const modelSource = await readFile(new URL("../src/models/ServicePoint.js", import.meta.url), "utf8")
    const controllerSource = await readFile(new URL("../src/controllers/servicePointController.js", import.meta.url), "utf8")

    assert.match(modelSource, /businessId: 1, creationIdempotencyKey: 1/)
    assert.match(modelSource, /partialFilterExpression/)
    assert.match(modelSource, /creationIdempotencyKey:[\s\S]*select: false/)
    assert.match(controllerSource, /req\.session\?\.user\?\.businessId/)
    assert.match(controllerSource, /Idempotency-Key was already used for another service point/)
    assert.match(controllerSource, /delete value\.creationIdempotencyKey/)
    assert.match(controllerSource, /roomType must be an active configured hotel room type/)
    assert.doesNotMatch(controllerSource, /req\.body\.businessId/)
})

test("live room metrics are derived from tenant-scoped guest sessions and room ServicePoints", async () => {
    const source = await readFile(new URL("../src/controllers/ownerController.js", import.meta.url), "utf8")
    assert.match(source, /GuestSession\.aggregate/)
    assert.match(source, /\$match: \{\s*businessId,/)
    assert.match(source, /servicePointType === "room"/)
    assert.match(source, /activeRoomsNow:/)
    assert.match(source, /activeRoomDevicesNow:/)
    assert.match(source, /activeServicePointsNow: tables\.length/)
    assert.match(source, /activeGuestDevicesNow: activeSessionsNow/)
    assert.match(source, /nextExpiresAt: \{ \$min: "\$expiresAt" \}/)
    assert.match(source, /nextActivityExpiryAt,/)
})

test("hotel Service Point realtime uses a tenant-scoped content-free invalidation", async () => {
    const calls = []
    await publishServicePointsChanged({
        businessId: "biz_hotel_a",
        scope: "configuration",
        publish: async (...args) => calls.push(args),
    })

    assert.deepEqual(calls, [[
        SERVICE_POINTS_CHANGED_EVENT,
        "biz_hotel_a",
        ["owner"],
        { invalidated: true, scope: "configuration" },
    ]])
    assert.equal(JSON.stringify(calls).includes("guest"), false)
    assert.equal(JSON.stringify(calls).includes("reservation"), false)
})

test("hotel session creation publishes activity while the legacy QR redirect cannot issue authority", async () => {
    const guestSessionRoute = await readFile(new URL("../src/routes/guest-session-route.js", import.meta.url), "utf8")
    const qrRoute = await readFile(new URL("../src/routes/qr-route.js", import.meta.url), "utf8")
    const servicePointController = await readFile(new URL("../src/controllers/servicePointController.js", import.meta.url), "utf8")

    assert.match(guestSessionRoute, /resolveBusinessCapabilities\(business\)\.identity\.shell === "hotel"/)
    assert.match(guestSessionRoute, /publishServicePointsChanged\(\{[\s\S]*?scope: "activity"/)
    assert.doesNotMatch(qrRoute, /models\/GuestSession|GuestSession\.create|publishServicePointsChanged|randomToken/)
    assert.match(qrRoute, /frontend QR bootstrap/)
    assert.match(servicePointController, /export async function createServicePoint[\s\S]*?scope: "configuration"/)
    assert.match(servicePointController, /export async function updateServicePoint[\s\S]*?scope: "configuration"/)
    assert.match(servicePointController, /export async function toggleServicePoint[\s\S]*?scope: "configuration"/)
    assert.match(servicePointController, /export async function toggleReservableServicePoint[\s\S]*?scope: "configuration"/)
    assert.match(servicePointController, /export async function deleteServicePoint[\s\S]*?scope: "configuration"/)
})
