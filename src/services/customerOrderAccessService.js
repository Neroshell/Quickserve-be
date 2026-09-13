import GuestSession from "../models/GuestSession.js"

export function getGuestSessionToken(req) {
  return String(
    req.get?.("x-table-session-token") ||
    req.headers?.["x-table-session-token"] ||
    req.query?.tableSessionToken ||
    req.query?.token ||
    req.body?.tableSessionToken ||
    "",
  ).trim()
}

function denied(statusCode, message) {
  return { statusCode, message, guestSession: null }
}

/**
 * Resolve the canonical current customer visit.
 *
 * Device session identity is deliberately only an additional binding here.
 * The GuestSession token, tenant, expiry, visit id and ServicePoint remain the
 * authority for current/live access. Historical order reads use a separate
 * device-and-business policy in the order controller.
 */
export async function resolveCurrentCustomerVisit({
  req,
  businessId,
  sessionId,
  servicePointId = null,
}) {
  const token = getGuestSessionToken(req)
  if (!token) return denied(401, "tableSessionToken is required")
  if (!sessionId) return denied(400, "sessionId is required")

  const guestSession = await GuestSession.findOne({ token, businessId }).lean()
  if (
    !guestSession ||
    !guestSession.expiresAt ||
    new Date(guestSession.expiresAt).getTime() <= Date.now()
  ) {
    return denied(403, "Invalid or expired table session")
  }

  if (!guestSession.boundSessionId || guestSession.boundSessionId !== sessionId) {
    return denied(403, "Table session belongs to another device")
  }

  if (servicePointId && guestSession.servicePointId !== servicePointId) {
    return denied(403, "Table session does not match this service point")
  }

  return {
    statusCode: 200,
    message: null,
    guestSession,
    guestSessionId: String(guestSession._id),
  }
}

export async function isCurrentCustomerVisitStillActive({
  guestSessionId,
  token,
  businessId,
  servicePointId,
  sessionId,
}) {
  if (!guestSessionId || !token || !businessId || !servicePointId || !sessionId) {
    return false
  }

  return Boolean(await GuestSession.exists({
    _id: guestSessionId,
    token,
    businessId,
    servicePointId,
    boundSessionId: sessionId,
    expiresAt: { $gt: new Date() },
  }))
}
