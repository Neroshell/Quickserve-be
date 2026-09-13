import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import Business from "../src/models/Business.js"
import {
    getPropertyProfile,
    updatePropertyProfileSection,
} from "../src/controllers/propertyProfileController.js"
import {
    buildPropertyProfileResponse,
    calculatePropertyProfileCompleteness,
} from "../src/services/propertyProfileService.js"

function makeBusiness(overrides = {}) {
    return {
        businessId: "biz_hotel_alpha",
        businessType: "hotel",
        displayName: "Harbour Hotel",
        address: "1 Marina Road",
        addressPlaceId: "place_123",
        latitude: 35.9,
        longitude: 14.5,
        phoneNumber: "+35620000000",
        contactEmail: "stay@harbour.example",
        country: "Malta",
        countryCode: "mt",
        currency: "EUR",
        timezone: "Europe/Malta",
        slug: "harbour-hotel",
        hotelSettings: {
            checkInTime: "15:00",
            checkInUntil: "22:00",
            checkOutFrom: "07:00",
            checkOutTime: "11:00",
        },
        propertyProfile: {
            accommodationType: "hotel",
            description: "A calm harbour-side hotel.",
            starRating: 4,
            city: "Sliema",
            region: "Central Region",
            postalCode: "SLM 1000",
            photos: [],
            facilityIds: [],
            parking: { available: null, cost: null, reservation: null, location: null, access: null },
            breakfastOffered: null,
            languages: [],
            childrenAllowed: null,
            petsPolicy: null,
            websiteUrl: "",
        },
        updatedAt: new Date("2026-09-12T08:00:00.000Z"),
        markModified() {},
        async save() { return this },
        ...overrides,
    }
}

function mockReqRes({ businessId = "biz_hotel_alpha", section, body = {} } = {}) {
    const req = {
        session: businessId ? { user: { businessId, role: "owner" } } : {},
        params: section ? { section } : {},
        body,
    }
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this },
        json(payload) { this.body = payload; return this },
    }
    return { req, res }
}

function installBusinessFindOne(t, business, onFilter = () => {}) {
    const original = Business.findOne
    Business.findOne = filter => {
        onFilter(filter)
        return { async select() { return business } }
    }
    t.after(() => { Business.findOne = original })
}

test("existing canonical Business fields populate Property Profile without duplication", () => {
    const business = makeBusiness()
    const response = buildPropertyProfileResponse(business)

    assert.equal(response.details.propertyName, business.displayName)
    assert.equal(response.location.address, business.address)
    assert.equal(response.location.country, business.country)
    assert.equal(response.location.latitude, business.latitude)
    assert.equal(response.contact.phone, business.phoneNumber)
    assert.equal(response.contact.email, business.contactEmail)
    assert.equal(response.arrivalDeparture.checkInFrom, business.hotelSettings.checkInTime)
    assert.equal(response.arrivalDeparture.checkOutUntil, business.hotelSettings.checkOutTime)
    assert.equal(response.arrivalDeparture.timezone, business.timezone)
})

test("completeness distinguishes required from recommended information", () => {
    const incomplete = makeBusiness()
    const initial = calculatePropertyProfileCompleteness(incomplete)
    assert.equal(initial.requiredComplete, true)
    assert.equal(initial.percentage, 50)
    assert.equal(initial.checklist.filter(item => item.category === "required").length, 4)
    assert.equal(initial.checklist.filter(item => item.category === "recommended").length, 4)

    incomplete.propertyProfile.photos.push({ _id: "photo_1", url: "https://images.example/property.webp", publicId: "property/1" })
    incomplete.propertyProfile.facilityIds = ["free_wifi"]
    incomplete.propertyProfile.parking.available = false
    incomplete.propertyProfile.breakfastOffered = true
    incomplete.propertyProfile.languages = ["en", "mt"]
    incomplete.propertyProfile.childrenAllowed = true
    incomplete.propertyProfile.petsPolicy = "on_request"

    const complete = calculatePropertyProfileCompleteness(incomplete)
    assert.equal(complete.percentage, 100)
    assert.equal(complete.requiredComplete, true)
})

test("GET is tenant-scoped exclusively from the authenticated session", async t => {
    const business = makeBusiness()
    let capturedFilter
    installBusinessFindOne(t, business, filter => { capturedFilter = filter })
    const { req, res } = mockReqRes()
    req.query = { businessId: "biz_other_tenant" }

    await getPropertyProfile(req, res)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(capturedFilter, { businessId: "biz_hotel_alpha" })
    assert.equal(res.body.businessId, "biz_hotel_alpha")
})

test("individual details updates persist sanitized values and ignore client businessId", async t => {
    const business = makeBusiness()
    let capturedFilter
    installBusinessFindOne(t, business, filter => { capturedFilter = filter })
    const { req, res } = mockReqRes({
        section: "details",
        body: {
            businessId: "biz_other_tenant",
            propertyName: "  Harbour <b>Grand</b>  ",
            accommodationType: "resort",
            description: "  A <script>bad()</script> refreshed description.  ",
            starRating: 5,
        },
    })

    await updatePropertyProfileSection(req, res)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(capturedFilter, { businessId: "biz_hotel_alpha" })
    assert.equal(business.displayName, "Harbour Grand")
    assert.equal(business.propertyProfile.accommodationType, "resort")
    assert.equal(business.propertyProfile.description, "A  refreshed description.")
    assert.equal(res.body.savedSection, "details")
})

test("parking follow-up values are cleared when parking is not available", async t => {
    const business = makeBusiness()
    installBusinessFindOne(t, business)
    const { req, res } = mockReqRes({
        section: "facilities",
        body: {
            facilityIds: ["free_wifi", "restaurant", "free_wifi"],
            breakfastOffered: false,
            parking: {
                available: false,
                cost: "paid",
                reservation: "required",
                location: "onsite",
                access: "private",
            },
        },
    })

    await updatePropertyProfileSection(req, res)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(business.propertyProfile.facilityIds, ["free_wifi", "restaurant"])
    assert.deepEqual(business.propertyProfile.parking, {
        available: false,
        cost: null,
        reservation: null,
        location: null,
        access: null,
    })
})

test("arrival and departure ranges use canonical hotel settings and reject inverted bounds", async t => {
    const business = makeBusiness()
    installBusinessFindOne(t, business)
    const invalid = mockReqRes({
        section: "arrival-departure",
        body: {
            checkInFrom: "23:00",
            checkInUntil: "20:00",
            checkOutFrom: "07:00",
            checkOutUntil: "11:00",
        },
    })
    await updatePropertyProfileSection(invalid.req, invalid.res)
    assert.equal(invalid.res.statusCode, 400)
    assert.match(invalid.res.body.message, /Check-in from/)

    const valid = mockReqRes({
        section: "arrival-departure",
        body: {
            checkInFrom: "14:00",
            checkInUntil: "23:30",
            checkOutFrom: "06:30",
            checkOutUntil: "12:00",
        },
    })
    await updatePropertyProfileSection(valid.req, valid.res)
    assert.equal(valid.res.statusCode, 200)
    assert.equal(business.hotelSettings.checkInTime, "14:00")
    assert.equal(business.hotelSettings.checkOutTime, "12:00")
})

test("photo reordering can set a cover and removal cannot reference another tenant's photo", async t => {
    const photos = [
        { _id: "photo_a", url: "https://images.example/a.webp", publicId: "" },
        { _id: "photo_b", url: "https://images.example/b.webp", publicId: "" },
    ]
    const business = makeBusiness({
        propertyProfile: { ...makeBusiness().propertyProfile, photos },
    })
    installBusinessFindOne(t, business)

    const reordered = mockReqRes({ section: "photos", body: { photoIds: ["photo_b"] } })
    await updatePropertyProfileSection(reordered.req, reordered.res)
    assert.equal(reordered.res.statusCode, 200)
    assert.deepEqual(business.propertyProfile.photos.map(photo => photo._id), ["photo_b"])
    assert.equal(reordered.res.body.photos[0].id, "photo_b")

    const foreign = mockReqRes({ section: "photos", body: { photoIds: ["foreign_photo"] } })
    await updatePropertyProfileSection(foreign.req, foreign.res)
    assert.equal(foreign.res.statusCode, 400)
})

test("Property Profile is unavailable to non-hotel businesses", async t => {
    installBusinessFindOne(t, makeBusiness({ businessType: "restaurant" }))
    const { req, res } = mockReqRes()
    await getPropertyProfile(req, res)
    assert.equal(res.statusCode, 409)
})

test("Business schema validates structured Property Profile enums", () => {
    const business = new Business({
        businessId: "biz_schema_profile",
        name: "Schema Hotel",
        displayName: "Schema Hotel",
        slug: "schema-hotel",
        businessType: "hotel",
        modules: ["lodging"],
        propertyProfile: {
            accommodationType: "hotel",
            facilityIds: ["swimming_pool", "free_wifi"],
            languages: ["en", "mt"],
            petsPolicy: "on_request",
        },
    })
    assert.equal(business.validateSync(), undefined)

    business.propertyProfile.facilityIds = ["guest_room_minibar"]
    assert.match(
        business.validateSync().message,
        /guest_room_minibar.*valid enum value/i,
    )

    const restaurant = new Business({
        businessId: "biz_schema_restaurant",
        name: "Schema Restaurant",
        displayName: "Schema Restaurant",
        slug: "schema-restaurant",
        businessType: "restaurant",
        modules: ["foodService"],
    })
    assert.equal(restaurant.propertyProfile, undefined)
})

test("Property Profile and property-photo routes use the owner/co-owner Business Settings guard", async () => {
    const [businessRoutes, uploadRoutes, propertyProfileController] = await Promise.all([
        readFile(new URL("../src/routes/business-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/routes/upload-route.js", import.meta.url), "utf8"),
        readFile(new URL("../src/controllers/propertyProfileController.js", import.meta.url), "utf8"),
    ])

    assert.match(businessRoutes, /router\.get\("\/property-profile", requireBusinessIdentityOwner, getPropertyProfile\)/)
    assert.match(businessRoutes, /router\.patch\("\/property-profile\/:section", requireBusinessIdentityOwner, updatePropertyProfileSection\)/)
    assert.match(uploadRoutes, /"\/property-photo",\s*requireManagementArea\(MANAGEMENT_ACCESS_AREAS\.BUSINESS_SETTINGS\)/)
    assert.match(uploadRoutes, /router\.use\(requireAuth\)/)

    const profileProjection = propertyProfileController.match(
        /const PROPERTY_PROFILE_SELECT = \[([\s\S]*?)\]\.join\(" "\)/,
    )
    assert.ok(profileProjection, "Property Profile projection must remain explicit")
    assert.match(profileProjection[1], /"modules"/)
})
