import mongoose from "mongoose"
import GuestProfile from "../models/GuestProfile.js"

export const OWNER_GUESTS_DEFAULT_LIMIT = 25
export const OWNER_GUESTS_MAX_LIMIT = 25

const CURSOR_DIRECTIONS = new Set(["next", "previous"])

const VALID_SORT_FIELDS = new Set([
  "lastVisitAt",
  "totalSpendCents",
  "orderCount",
  "visitCount",
])

export class OwnerGuestsCursorError extends Error {
  constructor(message = "Invalid owner guests cursor") {
    super(message)
    this.name = "OwnerGuestsCursorError"
    this.statusCode = 400
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") {
    return OWNER_GUESTS_DEFAULT_LIMIT
  }
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return OWNER_GUESTS_DEFAULT_LIMIT
  }
  return Math.min(parsed, OWNER_GUESTS_MAX_LIMIT)
}

export function encodeOwnerGuestsCursor(guest, sortField) {
  if (!guest || !guest._id) return null

  let sortValue = guest[sortField]
  
  // Date values need to be serialized to ISO string
  if (sortValue instanceof Date) {
    sortValue = sortValue.toISOString()
  } else if (sortValue === undefined) {
    sortValue = null
  }

  return Buffer.from(JSON.stringify({
    sortField,
    sortValue,
    id: String(guest._id),
  }), "utf8").toString("base64url")
}

export function decodeOwnerGuestsCursor(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new OwnerGuestsCursorError("Malformed cursor encoding")
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new OwnerGuestsCursorError("Invalid cursor structure")
    }

    const { sortField, sortValue, id } = decoded

    if (!VALID_SORT_FIELDS.has(sortField)) {
      throw new OwnerGuestsCursorError("Invalid sort field in cursor")
    }

    if (typeof id !== "string" || !/^[a-fA-F0-9]{24}$/.test(id)) {
      throw new OwnerGuestsCursorError("Invalid ObjectId in cursor")
    }

    let parsedSortValue = sortValue
    if (sortField === "lastVisitAt") {
      if (sortValue !== null) {
        parsedSortValue = new Date(sortValue)
        if (Number.isNaN(parsedSortValue.getTime())) {
          throw new OwnerGuestsCursorError("Invalid date in cursor")
        }
      }
    } else if (sortValue !== null && typeof sortValue !== "number") {
      throw new OwnerGuestsCursorError("Invalid numeric value in cursor")
    }

    return {
      sortField,
      sortValue: parsedSortValue,
      id: new mongoose.Types.ObjectId(id),
    }
  } catch (error) {
    if (error instanceof OwnerGuestsCursorError) throw error
    throw new OwnerGuestsCursorError("Failed to decode cursor")
  }
}

function getCursorConstraint(cursor, direction) {
  if (!cursor) return null

  const idOp = direction === "previous" ? "$gt" : "$lt"
  const constraints = []

  if (cursor.sortValue === null) {
    // If sortValue is null, we only check _id within the null group
    constraints.push({
      [cursor.sortField]: null,
      _id: { [idOp]: cursor.id }
    })
    
    // If moving backwards (previous) from a null value, we also match any valid (non-null) value
    if (direction === "previous") {
      constraints.push({ [cursor.sortField]: { $ne: null } })
    }
  } else {
    // Exact tie on sort value, use _id tiebreaker
    constraints.push({
      [cursor.sortField]: cursor.sortValue,
      _id: { [idOp]: cursor.id }
    })
    
    if (direction === "next") {
      // Next means strictly smaller valid values OR null values
      constraints.push({ [cursor.sortField]: { $lt: cursor.sortValue } })
      constraints.push({ [cursor.sortField]: null })
    } else {
      // Previous means strictly larger valid values
      constraints.push({ [cursor.sortField]: { $gt: cursor.sortValue, $ne: null } })
    }
  }

  return { $or: constraints }
}

function buildGuestsFilter({ businessId, filterBy, dateRangeBounds, search }) {
  const query = { businessId }

  // Status/Segment Filter
  if (filterBy === "leads") {
    query.guestStatus = "lead"
  } else {
    // Most analytical filters only want actual customers
    query.guestStatus = "customer"
    
    if (filterBy === "consent_only") {
      query.marketingConsent = true
    } else if (filterBy === "no_consent") {
      query.marketingConsent = false
    } else if (filterBy === "recent") {
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      query.lastVisitAt = { $gte: thirtyDaysAgo }
    } else if (filterBy === "inactive") {
      const ninetyDaysAgo = new Date()
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
      query.lastVisitAt = { $lt: ninetyDaysAgo }
    }
    // "top_spenders", "most_orders", "highest_visits" are handled strictly by sorting
  }

  // Date Range Bounds
  if (dateRangeBounds?.start || dateRangeBounds?.end) {
    const dateField = query.guestStatus === "lead" ? "lastCapturedAt" : "lastVisitAt"
    query[dateField] = query[dateField] || {}
    if (dateRangeBounds.start) query[dateField].$gte = dateRangeBounds.start
    if (dateRangeBounds.end) query[dateField].$lte = dateRangeBounds.end
  }

  // Search
  const normalizedSearch = typeof search === "string" ? search.trim() : ""
  if (normalizedSearch) {
    const searchRegex = new RegExp(escapeRegex(normalizedSearch), "i")
    query.$or = [
      { email: { $regex: searchRegex } },
      { name: { $regex: searchRegex } }
    ]
  }

  return query
}

export async function readOwnerGuestsPage({
  businessId,
  filterBy = "customers",
  dateRangeBounds = null,
  search = "",
  cursor: cursorValue,
  direction = "next",
  limit: requestedLimit,
}, { GuestProfileModel = GuestProfile } = {}) {
  if (!CURSOR_DIRECTIONS.has(direction)) {
    throw new OwnerGuestsCursorError("Invalid cursor direction")
  }
  if (direction === "previous" && !cursorValue) {
    throw new OwnerGuestsCursorError("A cursor is required for previous navigation")
  }

  const limit = normalizeLimit(requestedLimit)
  const cursor = cursorValue ? decodeOwnerGuestsCursor(cursorValue) : null

  // Determine sort field based on the semantic segment.
  // Preserves the exact sort semantics from the original offset-based controller:
  //   top_spenders  → totalSpendCents DESC, _id DESC
  //   most_orders   → orderCount DESC, _id DESC
  //   highest_visits→ visitCount DESC, _id DESC
  //   everything else (including leads) → lastVisitAt DESC, _id DESC
  // Note: the original controller used lastCapturedAt only for date-range
  // filtering on leads, NOT for sorting.  Leads were sorted by lastVisitAt.
  let sortField = "lastVisitAt"
  if (filterBy === "top_spenders") sortField = "totalSpendCents"
  else if (filterBy === "most_orders") sortField = "orderCount"
  else if (filterBy === "highest_visits") sortField = "visitCount"

  if (cursor && cursor.sortField !== sortField) {
    throw new OwnerGuestsCursorError("Cursor sort field does not match the current segment filter")
  }

  const baseFilter = buildGuestsFilter({ businessId, filterBy, dateRangeBounds, search })
  const cursorConstraint = getCursorConstraint(cursor, direction)
  
  const listFilter = cursorConstraint
    ? { ...baseFilter, $and: [cursorConstraint] }
    : baseFilter

  const sort = direction === "previous"
    ? { [sortField]: 1, _id: 1 }
    : { [sortField]: -1, _id: -1 }

  // Execute queries
  const [rawRows, totalCount] = await Promise.all([
    GuestProfileModel.find(listFilter)
      .sort(sort)
      .limit(limit + 1)
      .lean(),
    GuestProfileModel.countDocuments(baseFilter)
  ])

  const hasExtraRecord = rawRows.length > limit
  let guests = rawRows.slice(0, limit)

  if (direction === "previous") {
    guests = guests.reverse()
  }

  const hasPreviousPage = direction === "previous" ? hasExtraRecord : Boolean(cursor)
  const hasNextPage = direction === "previous" ? Boolean(cursor) : hasExtraRecord

  return {
    guests,
    pagination: {
      limit,
      nextCursor: hasNextPage && guests.length > 0
        ? encodeOwnerGuestsCursor(guests[guests.length - 1], sortField)
        : null,
      previousCursor: hasPreviousPage && guests.length > 0
        ? encodeOwnerGuestsCursor(guests[0], sortField)
        : null,
      hasNextPage,
      hasPreviousPage,
      total: totalCount
    }
  }
}
