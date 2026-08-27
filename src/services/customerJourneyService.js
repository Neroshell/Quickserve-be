import crypto from "crypto"
import Business from "../models/Business.js"
import CustomerJourney from "../models/CustomerJourney.js"
import { resolveBusinessDay } from "../utils/businessDate.js"

const JOURNEY_ID_PATTERN = /^jrn_[a-f0-9]{32}$/
const BUSINESS_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_REFERENCE_LENGTH = 256

function normalizedReference(value) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_REFERENCE_LENGTH) return null
  return normalized
}

function normalizedOrderId(value) {
  return normalizedReference(value)
}

function normalizedJourneyId(value) {
  const normalized = normalizedReference(value)
  return normalized && JOURNEY_ID_PATTERN.test(normalized) ? normalized : null
}

export function isCanonicalServicePointId(value) {
  const normalized = normalizedReference(value)
  return Boolean(normalized && normalized.startsWith("sp_") && /^sp_[a-z0-9_-]+$/i.test(normalized))
}

function canonicalServicePointId(value) {
  const normalized = normalizedReference(value)
  return isCanonicalServicePointId(normalized) ? normalized : null
}

function validDate(value, fallback) {
  const date = value instanceof Date ? value : new Date(value || fallback)
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date
}

async function leanResult(query) {
  return typeof query?.lean === "function" ? query.lean() : query
}

async function touchJourney(journey, {
  now,
  servicePointId,
  orderType,
  sessionId,
  tableSessionToken,
}) {
  journey.lastSeenAt = now
  if (servicePointId && !journey.servicePointId) journey.servicePointId = servicePointId
  if (orderType && !journey.orderType) journey.orderType = orderType
  if (sessionId && !journey.sessionId) journey.sessionId = sessionId
  if (tableSessionToken && !journey.tableSessionToken) {
    journey.tableSessionToken = tableSessionToken
  }
  if (typeof journey.save === "function") await journey.save()
  return journey
}

export function generateJourneyId() {
  return `jrn_${crypto.randomBytes(16).toString("hex")}`
}

export function createCustomerJourneyService({
  businessModel = Business,
  journeyModel = CustomerJourney,
  businessDayResolver = resolveBusinessDay,
  idGenerator = generateJourneyId,
  clock = () => new Date(),
  logger = console,
} = {}) {
  /**
   * Resolves or creates a durable ordering journey.
   *
   * Resolution priority is deliberately strict:
   * 1. a tenant-owned, same-business-day supplied journey id;
   * 2. a validated dine-in table-session token;
   * 3. an unfinished direct/takeaway journey on the same device and day;
   * 4. a new server-generated journey id.
   *
   * Client-provided ids are never used to create documents. Every failure is
   * fail-open and returns journeyId:null so order/payment flows remain usable.
   */
  async function startCustomerJourney({
    businessId,
    servicePointId = null,
    orderType = null,
    tableSessionToken = null,
    sessionId = null,
    journeyId = null,
    now = clock(),
  } = {}) {
    const tenantId = normalizedReference(businessId)
    if (!tenantId) {
      return { journeyId: null, localBusinessDate: null }
    }

    try {
      const business = await leanResult(
        businessModel.findOne(
          { businessId: tenantId },
          "timezone operatingHours",
        ),
      )
      if (!business) {
        return { journeyId: null, localBusinessDate: null }
      }

      const observedAt = validDate(now, clock())
      const resolvedDay = businessDayResolver(business, observedAt)
      const localBusinessDate = resolvedDay?.businessDay
      if (
        typeof localBusinessDate !== "string" ||
        !BUSINESS_DAY_PATTERN.test(localBusinessDate)
      ) {
        throw new TypeError("Business-day resolver did not return YYYY-MM-DD")
      }

      const canonicalPointId = canonicalServicePointId(servicePointId)
      const safeOrderType = ["dine-in", "takeout"].includes(orderType)
        ? orderType
        : null
      const safeSessionId = normalizedReference(sessionId)
      const safeTableSessionToken = normalizedReference(tableSessionToken)
      const requestedJourneyId = normalizedJourneyId(journeyId)
      const activeTakeawayFilter = safeOrderType === "takeout"
        ? { completedAt: null }
        : {}

      if (requestedJourneyId) {
        const existing = await journeyModel.findOne({
          businessId: tenantId,
          journeyId: requestedJourneyId,
          localBusinessDate,
          ...activeTakeawayFilter,
        })
        if (existing) {
          return touchJourney(existing, {
            now: observedAt,
            servicePointId: canonicalPointId,
            orderType: safeOrderType,
            sessionId: safeSessionId,
            tableSessionToken: safeTableSessionToken,
          })
        }
      }

      if (safeTableSessionToken) {
        const existingByToken = await journeyModel.findOne({
          businessId: tenantId,
          tableSessionToken: safeTableSessionToken,
          ...activeTakeawayFilter,
        })
        if (existingByToken) {
          return touchJourney(existingByToken, {
            now: observedAt,
            servicePointId: canonicalPointId,
            orderType: safeOrderType,
            sessionId: safeSessionId,
            tableSessionToken: safeTableSessionToken,
          })
        }
      }

      // Reusing a device identity is safe only for a direct/takeaway flow.
      // A fresh dine-in QR token always represents a fresh table visit.
      if (safeSessionId && !safeTableSessionToken && safeOrderType !== "dine-in") {
        const existingByDevice = await journeyModel.findOne({
          businessId: tenantId,
          sessionId: safeSessionId,
          localBusinessDate,
          completedAt: null,
        })
        if (existingByDevice) {
          return touchJourney(existingByDevice, {
            now: observedAt,
            servicePointId: canonicalPointId,
            orderType: safeOrderType,
            sessionId: safeSessionId,
            tableSessionToken: null,
          })
        }
      }

      const journey = await journeyModel.create({
        journeyId: idGenerator(),
        businessId: tenantId,
        servicePointId: canonicalPointId,
        orderType: safeOrderType,
        sessionId: safeSessionId,
        tableSessionToken: safeTableSessionToken,
        localBusinessDate,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      })

      return journey
    } catch (error) {
      logger.error("[customerJourneyService] startCustomerJourney fail-open error:", error)
      return {
        journeyId: null,
        businessId: tenantId,
        localBusinessDate: null,
        failOpenFallback: true,
      }
    }
  }

  async function recordOrderPlacementForJourney({
    businessId,
    journeyId,
    orderId,
    createdAt = clock(),
  } = {}) {
    const tenantId = normalizedReference(businessId)
    const safeJourneyId = normalizedJourneyId(journeyId)
    const safeOrderId = normalizedOrderId(orderId)
    if (!tenantId || !safeJourneyId || !safeOrderId) return null

    try {
      const orderedAt = validDate(createdAt, clock())
      const seenAt = validDate(clock(), orderedAt)
      const updated = await journeyModel.findOneAndUpdate(
        {
          businessId: tenantId,
          journeyId: safeJourneyId,
          placedOrderIds: { $ne: safeOrderId },
        },
        {
          $addToSet: { placedOrderIds: safeOrderId },
          $inc: { orderCount: 1 },
          $max: { lastOrderedAt: orderedAt, lastSeenAt: seenAt },
        },
        { new: true },
      )

      if (updated) {
        await journeyModel.updateOne(
          {
            businessId: tenantId,
            journeyId: safeJourneyId,
            $or: [
              { firstOrderedAt: null },
              { firstOrderedAt: { $exists: false } },
              { firstOrderedAt: { $gt: orderedAt } },
            ],
          },
          { $set: { firstOrderedAt: orderedAt } },
        )
      }

      return journeyModel.findOne({ businessId: tenantId, journeyId: safeJourneyId })
    } catch (error) {
      logger.error("[customerJourneyService] recordOrderPlacementForJourney error:", error)
      return null
    }
  }

  async function recordOrderPaymentForJourney({
    businessId,
    journeyId,
    orderId,
    spendCents = 0,
    paidAt = clock(),
  } = {}) {
    const tenantId = normalizedReference(businessId)
    const safeJourneyId = normalizedJourneyId(journeyId)
    const safeOrderId = normalizedOrderId(orderId)
    if (!tenantId || !safeJourneyId || !safeOrderId) return null

    try {
      const paidAtDate = validDate(paidAt, clock())
      const seenAt = validDate(clock(), paidAtDate)
      const validSpend = Math.max(0, Math.round(Number(spendCents) || 0))
      const updated = await journeyModel.findOneAndUpdate(
        {
          businessId: tenantId,
          journeyId: safeJourneyId,
          paidOrderIds: { $ne: safeOrderId },
        },
        {
          $addToSet: { paidOrderIds: safeOrderId },
          $inc: {
            paidOrderCount: 1,
            totalSpendCents: validSpend,
          },
          $max: { lastSeenAt: seenAt },
        },
        { new: true },
      )

      if (updated) {
        // A confirmed paid takeaway order is the lifecycle boundary that lets
        // the same browser begin a separate future takeaway journey.
        await journeyModel.updateOne(
          {
            businessId: tenantId,
            journeyId: safeJourneyId,
            orderType: "takeout",
            completedAt: null,
          },
          { $set: { completedAt: paidAtDate } },
        )
      }

      return journeyModel.findOne({ businessId: tenantId, journeyId: safeJourneyId })
    } catch (error) {
      logger.error("[customerJourneyService] recordOrderPaymentForJourney error:", error)
      return null
    }
  }

  async function linkJourneyToProfile({
    businessId,
    journeyId,
    guestProfileId,
    identifiedAt = clock(),
  } = {}) {
    const tenantId = normalizedReference(businessId)
    const safeJourneyId = normalizedJourneyId(journeyId)
    if (!tenantId || !safeJourneyId || !guestProfileId) return null

    try {
      const linkedAt = validDate(identifiedAt, clock())
      const updated = await journeyModel.findOneAndUpdate(
        {
          businessId: tenantId,
          journeyId: safeJourneyId,
          $or: [
            { guestProfileId: null },
            { guestProfileId: { $exists: false } },
          ],
        },
        {
          $set: {
            guestProfileId,
            identifiedAt: linkedAt,
            lastSeenAt: validDate(clock(), linkedAt),
          },
        },
        { new: true },
      )
      if (updated) return updated

      // Idempotent retries may link the same profile again, but a journey can
      // never be reassigned to a different customer.
      const existing = await journeyModel.findOne({
        businessId: tenantId,
        journeyId: safeJourneyId,
        guestProfileId,
      })
      if (!existing) {
        logger.warn("[customerJourneyService] Journey profile linkage conflict", {
          businessId: tenantId,
          journeyId: safeJourneyId,
        })
      }
      return existing
    } catch (error) {
      logger.error("[customerJourneyService] linkJourneyToProfile error:", error)
      return null
    }
  }

  return {
    startCustomerJourney,
    resolveOrStartCustomerJourney: startCustomerJourney,
    recordOrderPlacementForJourney,
    recordOrderPaymentForJourney,
    linkJourneyToProfile,
  }
}

const customerJourneyService = createCustomerJourneyService()

export const startCustomerJourney = customerJourneyService.startCustomerJourney
export const resolveOrStartCustomerJourney = customerJourneyService.resolveOrStartCustomerJourney
export const recordOrderPlacementForJourney = customerJourneyService.recordOrderPlacementForJourney
export const recordOrderPaymentForJourney = customerJourneyService.recordOrderPaymentForJourney
export const linkJourneyToProfile = customerJourneyService.linkJourneyToProfile
