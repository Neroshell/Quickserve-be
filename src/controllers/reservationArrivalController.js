import {
  checkInRestaurantReservationArrival,
  inspectReservationArrivalToken,
} from "../services/reservationArrivalService.js";

const OUTCOME_HTTP_STATUS = Object.freeze({
  ready: 200,
  checked_in: 200,
  already_checked_in: 200,
  inactive: 410,
  expired: 410,
  not_ready: 409,
  invalid: 404,
});

const OUTCOME_MESSAGES = Object.freeze({
  ready: "Your reservation is ready for arrival check-in.",
  checked_in: "You're checked in! We've notified the restaurant that you've arrived. Please wait to be seated.",
  already_checked_in: "You're already checked in.",
  inactive: "This reservation is no longer active.",
  expired: "This check-in link has expired.",
  not_ready: "This reservation is not ready for arrival check-in.",
  invalid: "This check-in link is invalid.",
});

function tokenFromRequest(req) {
  return String(req.body?.token || "").trim();
}

function respond(res, result) {
  const outcome = result?.outcome || "invalid";
  return res.status(OUTCOME_HTTP_STATUS[outcome] || 400).json({
    outcome,
    message: OUTCOME_MESSAGES[outcome] || OUTCOME_MESSAGES.invalid,
    reservation: result?.reservation || null,
  });
}

export async function validateReservationArrival(req, res) {
  const token = tokenFromRequest(req);
  if (!token) {
    return res.status(400).json({
      outcome: "invalid",
      message: "A check-in token is required.",
      reservation: null,
    });
  }
  try {
    return respond(res, await inspectReservationArrivalToken({ token }));
  } catch (error) {
    console.error("[ReservationArrival] Validation failed", {
      errorClass: error?.name || "Error",
      reason: error?.code || "validation_failed",
    });
    return res.status(503).json({
      outcome: "unavailable",
      message: "Arrival check-in is temporarily unavailable.",
      reservation: null,
    });
  }
}

export async function checkInReservationArrival(req, res) {
  const token = tokenFromRequest(req);
  if (!token) {
    return res.status(400).json({
      outcome: "invalid",
      message: "A check-in token is required.",
      reservation: null,
    });
  }
  try {
    const result = await checkInRestaurantReservationArrival({
      token,
      ip: req.ip || null,
      userAgent: req.get?.("user-agent") || null,
    });
    return respond(res, result);
  } catch (error) {
    console.error("[ReservationArrival] Check-in failed", {
      errorClass: error?.name || "Error",
      reason: error?.code || "check_in_failed",
    });
    return res.status(503).json({
      outcome: "unavailable",
      message: "Arrival check-in is temporarily unavailable.",
      reservation: null,
    });
  }
}

export { OUTCOME_HTTP_STATUS, OUTCOME_MESSAGES };
