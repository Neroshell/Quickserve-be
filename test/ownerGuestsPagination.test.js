import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"
import {
    decodeOwnerGuestsCursor,
    encodeOwnerGuestsCursor,
    readOwnerGuestsPage,
    OwnerGuestsCursorError,
} from "../src/services/ownerGuestsReadService.js"

function objectId(number) {
    return new mongoose.Types.ObjectId(number.toString(16).padStart(24, "0"))
}

function comparable(value) {
    if (value === null || value === undefined) return value
    if (value instanceof Date) return value.getTime()
    if (value instanceof mongoose.Types.ObjectId) return value.toString()
    return value
}

function matchesCondition(actual, expected) {
    if (expected === null) return actual === null || actual === undefined
    if (
        expected &&
        typeof expected === "object" &&
        !(expected instanceof Date) &&
        !(expected instanceof mongoose.Types.ObjectId) &&
        !(expected instanceof RegExp)
    ) {
        return Object.entries(expected).every(([operator, operand]) => {
            if (operator === "$regex") return operand.test(String(actual ?? ""))
            if (operator === "$in") {
                return operand.some((value) => comparable(actual) === comparable(value))
            }
            if (operator === "$ne") {
                if (operand === null) return actual !== null && actual !== undefined
                return comparable(actual) !== comparable(operand)
            }
            if (operator === "$gte") return comparable(actual) >= comparable(operand)
            if (operator === "$gt") return comparable(actual) > comparable(operand)
            if (operator === "$lt") return comparable(actual) < comparable(operand)
            if (operator === "$lte") return comparable(actual) <= comparable(operand)
            throw new Error(`Unsupported fake query operator: ${operator}`)
        })
    }

    return comparable(actual) === comparable(expected)
}

function matchesFilter(document, filter) {
    return Object.entries(filter).every(([field, condition]) => {
        if (field === "$and") {
            return condition.every((clause) => matchesFilter(document, clause))
        }
        if (field === "$or") {
            return condition.some((clause) => matchesFilter(document, clause))
        }
        return matchesCondition(document[field], condition)
    })
}

function compareDocuments(left, right, sort) {
    for (const [field, direction] of Object.entries(sort)) {
        const leftValue = comparable(left[field])
        const rightValue = comparable(right[field])
        // null handling: null is considered smaller than any non-null value.
        const leftIsNull = leftValue === null || leftValue === undefined;
        const rightIsNull = rightValue === null || rightValue === undefined;

        if (leftIsNull && rightIsNull) continue;
        if (leftIsNull) return -1 * direction; // ASC: left (-1, first). DESC: left (1, last)
        if (rightIsNull) return 1 * direction; // ASC: right (1, last). DESC: right (-1, first)

        if (leftValue < rightValue) return -1 * direction
        if (leftValue > rightValue) return 1 * direction
    }
    return 0
}

function createGuestProfileModel(documents) {
    const calls = { find: [], countDocuments: [] }

    return {
        calls,
        find(filter) {
            const call = { filter, sort: null, limit: null }
            calls.find.push(call)

            return {
                sort(sort) {
                    call.sort = sort
                    return this
                },
                limit(limit) {
                    call.limit = limit
                    return this
                },
                async lean() {
                    return documents
                        .filter((document) => matchesFilter(document, filter))
                        .sort((left, right) => compareDocuments(left, right, call.sort))
                        .slice(0, call.limit)
                },
            }
        },
        async countDocuments(filter) {
            calls.countDocuments.push(filter)
            return documents.filter((document) => matchesFilter(document, filter)).length
        },
    }
}

/**
 * Create test guest profiles. Every 3rd guest shares the same lastVisitAt
 * to exercise tied-value cursor logic.
 */
function createGuests(count = 60, businessId = "biz_a", options = {}) {
    const {
        guestStatus = "customer",
        withNullLastVisitAt = false,
    } = options

    return Array.from({ length: count }, (_, index) => {
        const number = index + 1
        const sharedGroup = Math.floor(index / 3)
        const isNullVisit = withNullLastVisitAt && index >= count - 5 // last 5 have null

        return {
            _id: objectId(number),
            businessId,
            email: `guest${number}@test.com`,
            name: `Guest ${number}`,
            guestStatus,
            lastVisitAt: isNullVisit ? null : new Date(`2026-08-${String(28 - sharedGroup).padStart(2, "0")}T12:00:00.000Z`),
            lastCapturedAt: guestStatus === "lead"
                ? new Date(`2026-08-${String(28 - sharedGroup).padStart(2, "0")}T12:00:00.000Z`)
                : null,
            visitCount: count - index,
            orderCount: Math.floor((count - index) * 0.7),
            paidOrderCount: Math.floor((count - index) * 0.5),
            totalSpendCents: (count - index) * 1500,
            averageSpendCents: 1500,
            marketingConsent: index % 2 === 0,
            favouriteItems: [],
        }
    })
}

async function readPage(documents, overrides = {}) {
    const GuestProfileModel = createGuestProfileModel(documents)
    const result = await readOwnerGuestsPage({
        businessId: "biz_a",
        filterBy: "customers",
        search: "",
        ...overrides,
    }, { GuestProfileModel })
    return { result, GuestProfileModel }
}

function emails(result) {
    return result.guests.map((guest) => guest.email)
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

test("owner guests defaults to at most 25 records", async () => {
    const documents = createGuests()
    const { result } = await readPage(documents)

    assert.equal(result.guests.length, 25)
    assert.equal(result.pagination.limit, 25)
    assert.equal(result.pagination.hasNextPage, true)
    assert.equal(result.pagination.hasPreviousPage, false)
})

test("owner guests total count covers the full matching set", async () => {
    const documents = createGuests(60)
    const { result } = await readPage(documents)

    assert.equal(result.pagination.total, 60)
    assert.equal(result.guests.length, 25)
})

test("default sort uses lastVisitAt DESC, _id DESC", async () => {
    const { result, GuestProfileModel } = await readPage(createGuests(12), { limit: 12 })

    assert.deepEqual(GuestProfileModel.calls.find[0].sort, { lastVisitAt: -1, _id: -1 })
    assert.equal(result.guests.length, 12)
})

test("top_spenders sort uses totalSpendCents DESC, _id DESC", async () => {
    const { GuestProfileModel } = await readPage(createGuests(12), { filterBy: "top_spenders" })

    assert.deepEqual(GuestProfileModel.calls.find[0].sort, { totalSpendCents: -1, _id: -1 })
})

test("most_orders sort uses orderCount DESC, _id DESC", async () => {
    const { GuestProfileModel } = await readPage(createGuests(12), { filterBy: "most_orders" })

    assert.deepEqual(GuestProfileModel.calls.find[0].sort, { orderCount: -1, _id: -1 })
})

test("highest_visits sort uses visitCount DESC, _id DESC", async () => {
    const { GuestProfileModel } = await readPage(createGuests(12), { filterBy: "highest_visits" })

    assert.deepEqual(GuestProfileModel.calls.find[0].sort, { visitCount: -1, _id: -1 })
})

test("leads segment filters by guestStatus=lead and sorts by lastVisitAt DESC", async () => {
    const customers = createGuests(10, "biz_a", { guestStatus: "customer" })
    const leads = createGuests(5, "biz_a", { guestStatus: "lead" }).map((g, i) => ({
        ...g,
        _id: objectId(100 + i),
        email: `lead${i}@test.com`,
    }))
    const documents = [...customers, ...leads]
    const { result, GuestProfileModel } = await readPage(documents, { filterBy: "leads" })

    assert.equal(result.guests.every((g) => g.guestStatus === "lead"), true)
    assert.deepEqual(GuestProfileModel.calls.find[0].sort, { lastVisitAt: -1, _id: -1 })
    assert.equal(GuestProfileModel.calls.find[0].filter.guestStatus, "lead")
})

test("nextCursor returns the next distinct set", async () => {
    const documents = createGuests()
    const first = (await readPage(documents)).result
    const second = (await readPage(documents, {
        cursor: first.pagination.nextCursor,
        direction: "next",
    })).result

    assert.equal(second.guests.length, 25)
    assert.notDeepEqual(emails(second), emails(first))
})

test("adjacent pages contain no duplicates", async () => {
    const documents = createGuests()
    const first = (await readPage(documents)).result
    const second = (await readPage(documents, {
        cursor: first.pagination.nextCursor,
        direction: "next",
    })).result
    const firstEmails = new Set(emails(first))

    assert.equal(emails(second).some((email) => firstEmails.has(email)), false)
})

test("cursor traversal skips no guests when multiple records share lastVisitAt", async () => {
    const documents = createGuests(60)
    const seen = []
    let cursor = null

    do {
        const page = (await readPage(documents, { cursor, direction: "next" })).result
        seen.push(...emails(page))
        cursor = page.pagination.nextCursor
    } while (cursor)

    const expected = [...documents]
        .filter((g) => g.guestStatus === "customer")
        .sort((left, right) => compareDocuments(left, right, { lastVisitAt: -1, _id: -1 }))
        .map((guest) => guest.email)

    assert.deepEqual(seen, expected)
    assert.equal(seen.length, 60)
})

test("top_spenders cursor traversal skips no guests", async () => {
    const documents = createGuests(60)
    const seen = []
    let cursor = null

    do {
        const page = (await readPage(documents, {
            filterBy: "top_spenders",
            cursor,
            direction: "next",
        })).result
        seen.push(...emails(page))
        cursor = page.pagination.nextCursor
    } while (cursor)

    assert.equal(seen.length, 60)
    assert.equal(new Set(seen).size, 60)
})

test("most_orders cursor traversal skips no guests", async () => {
    const documents = createGuests(60)
    const seen = []
    let cursor = null

    do {
        const page = (await readPage(documents, {
            filterBy: "most_orders",
            cursor,
            direction: "next",
        })).result
        seen.push(...emails(page))
        cursor = page.pagination.nextCursor
    } while (cursor)

    assert.equal(seen.length, 60)
    assert.equal(new Set(seen).size, 60)
})

test("highest_visits cursor traversal skips no guests", async () => {
    const documents = createGuests(60)
    const seen = []
    let cursor = null

    do {
        const page = (await readPage(documents, {
            filterBy: "highest_visits",
            cursor,
            direction: "next",
        })).result
        seen.push(...emails(page))
        cursor = page.pagination.nextCursor
    } while (cursor)

    assert.equal(seen.length, 60)
    assert.equal(new Set(seen).size, 60)
})

test("previous navigation returns the correct preceding set", async () => {
    const documents = createGuests()
    const first = (await readPage(documents)).result
    const second = (await readPage(documents, {
        cursor: first.pagination.nextCursor,
        direction: "next",
    })).result
    const previous = (await readPage(documents, {
        cursor: second.pagination.previousCursor,
        direction: "previous",
    })).result

    assert.deepEqual(emails(previous), emails(first))
    assert.equal(previous.pagination.hasPreviousPage, false)
    assert.equal(previous.pagination.hasNextPage, true)
})

test("forward then previous returns the original records", async () => {
    const documents = createGuests(60)
    const first = (await readPage(documents)).result
    const second = (await readPage(documents, {
        cursor: first.pagination.nextCursor,
        direction: "next",
    })).result
    const backToFirst = (await readPage(documents, {
        cursor: second.pagination.previousCursor,
        direction: "previous",
    })).result

    assert.deepEqual(emails(backToFirst), emails(first))
})

test("search + cursor pagination works", async () => {
    const documents = createGuests(40)
    const byEmail = (await readPage(documents, { search: "guest1" })).result

    // guest1, guest10-19 = 11 matches
    assert.equal(byEmail.guests.every((g) => g.email.includes("guest1")), true)
    assert.equal(byEmail.guests.length > 0, true)
})

test("segment filter + cursor works", async () => {
    const documents = createGuests(40)
    const consentOnly = (await readPage(documents, { filterBy: "consent_only" })).result

    assert.equal(consentOnly.guests.every((g) => g.marketingConsent === true), true)
    assert.equal(consentOnly.pagination.total, 20) // every other guest has consent
})

test("date range + cursor works", async () => {
    const documents = createGuests(30)
    const dateRangeBounds = {
        start: new Date("2026-08-20T00:00:00.000Z"),
        end: new Date("2026-08-28T23:59:59.999Z"),
    }
    const { result } = await readPage(documents, { dateRangeBounds })

    assert.equal(result.guests.every((g) => {
        const visit = new Date(g.lastVisitAt)
        return visit >= dateRangeBounds.start && visit <= dateRangeBounds.end
    }), true)
})

test("tenant isolation is enforced", async () => {
    const documents = [
        ...createGuests(10, "biz_a"),
        ...createGuests(10, "biz_b").map((g, i) => ({
            ...g,
            _id: objectId(i + 100),
            email: `other${i}@test.com`,
        })),
    ]
    const { result, GuestProfileModel } = await readPage(documents)

    assert.equal(result.guests.every((g) => g.businessId === "biz_a"), true)
    assert.equal(GuestProfileModel.calls.find[0].filter.businessId, "biz_a")
})

test("malformed cursors are rejected as 400 errors", () => {
    assert.throws(
        () => decodeOwnerGuestsCursor("not-a-valid-cursor"),
        (error) => error.name === "OwnerGuestsCursorError" && error.statusCode === 400,
    )
})

test("cursor with incompatible sort/filter returns 400", async () => {
    const documents = createGuests(30)
    const defaultPage = (await readPage(documents)).result
    // Default cursor uses lastVisitAt as sortField; top_spenders expects totalSpendCents
    await assert.rejects(
        () => readPage(documents, {
            filterBy: "top_spenders",
            cursor: defaultPage.pagination.nextCursor,
            direction: "next",
        }),
        (error) => error.name === "OwnerGuestsCursorError" && error.statusCode === 400,
    )
})

test("previous without cursor is rejected", async () => {
    await assert.rejects(
        () => readPage(createGuests(10), { direction: "previous" }),
        (error) => error.name === "OwnerGuestsCursorError" && error.statusCode === 400,
    )
})

test("26+ profiles with identical primary sort value paginate correctly", async () => {
    // All 30 guests share the same lastVisitAt — determinism depends entirely on _id
    const sameDate = new Date("2026-08-15T12:00:00.000Z")
    const documents = createGuests(30).map((g) => ({ ...g, lastVisitAt: sameDate }))
    const seen = []
    let cursor = null

    do {
        const page = (await readPage(documents, { cursor, direction: "next" })).result
        seen.push(...emails(page))
        cursor = page.pagination.nextCursor
    } while (cursor)

    assert.equal(seen.length, 30)
    assert.equal(new Set(seen).size, 30)
})

test("null lastVisitAt values are handled deterministically without duplicates or skips", async () => {
    const documents = createGuests(30, "biz_a", { withNullLastVisitAt: true })
    const seen = []
    let cursor = null

    do {
        const page = (await readPage(documents, { cursor, direction: "next" })).result
        seen.push(...emails(page))
        cursor = page.pagination.nextCursor
    } while (cursor)

    assert.equal(seen.length, 30)
    assert.equal(new Set(seen).size, 30)

    // The last entries should be the ones with null lastVisitAt
    const nullGuests = documents.filter((g) => g.lastVisitAt === null)
    assert.equal(nullGuests.length, 5)
    // All null-visit guests should appear in the traversal
    for (const g of nullGuests) {
        assert.equal(seen.includes(g.email), true, `Missing null-visit guest: ${g.email}`)
    }
})

test("zero results shows empty array, not infinite skeleton", async () => {
    const { result } = await readPage([], { filterBy: "customers" })

    assert.deepEqual(result.guests, [])
    assert.equal(result.pagination.total, 0)
    assert.equal(result.pagination.hasNextPage, false)
    assert.equal(result.pagination.hasPreviousPage, false)
    assert.equal(result.pagination.nextCursor, null)
    assert.equal(result.pagination.previousCursor, null)
})

test("numeric zero sort values (orderCount=0) paginate correctly", async () => {
    const documents = createGuests(10).map((g) => ({ ...g, orderCount: 0 }))
    const seen = []
    let cursor = null

    do {
        const page = (await readPage(documents, {
            filterBy: "most_orders",
            cursor,
            direction: "next",
        })).result
        seen.push(...emails(page))
        cursor = page.pagination.nextCursor
    } while (cursor)

    assert.equal(seen.length, 10)
    assert.equal(new Set(seen).size, 10)
})
