import {
  cancelRestaurantReservationNotComing,
  inspectReservationNotComingToken,
} from "../services/reservationNotComingService.js";

const OUTCOME_HTTP_STATUS = Object.freeze({
  ready: 200,
  cancelled: 200,
  already_cancelled: 200,
  already_arrived: 200,
  inactive: 410,
  expired: 410,
  invalid: 404,
});

const OUTCOME_MESSAGES = Object.freeze({
  ready: "Your reservation is ready for cancellation.",
  cancelled: "Your reservation has been cancelled. Thanks for letting the restaurant know. Your table has been released.",
  already_cancelled: "This reservation has already been cancelled.",
  already_arrived: "You have already been marked as arrived. Please speak with the restaurant if you need help.",
  inactive: "This reservation can no longer be changed.",
  expired: "This link is no longer active. Please contact the restaurant directly.",
  invalid: "This link is no longer active. Please contact the restaurant directly.",
});

function extractToken(req) {
  return String(
    req.params?.token || req.body?.token || req.query?.token || "",
  ).trim();
}

function respond(res, result) {
  const outcome = result?.outcome || "invalid";
  return res.status(OUTCOME_HTTP_STATUS[outcome] || 400).json({
    outcome,
    message: OUTCOME_MESSAGES[outcome] || OUTCOME_MESSAGES.invalid,
    reservation: result?.reservation || null,
  });
}

export async function validateReservationNotComing(req, res) {
  const token = extractToken(req);
  if (!token) {
    return res.status(400).json({
      outcome: "invalid",
      message: OUTCOME_MESSAGES.invalid,
      reservation: null,
    });
  }
  try {
    return respond(res, await inspectReservationNotComingToken({ token }));
  } catch (error) {
    console.error("[ReservationNotComing] Validation failed", {
      errorClass: error?.name || "Error",
      reason: error?.code || "validation_failed",
    });
    return res.status(503).json({
      outcome: "unavailable",
      message: "Cancellation inspection is temporarily unavailable.",
      reservation: null,
    });
  }
}

export async function cancelReservationNotComing(req, res) {
  const token = extractToken(req);
  if (!token) {
    return res.status(400).json({
      outcome: "invalid",
      message: OUTCOME_MESSAGES.invalid,
      reservation: null,
    });
  }
  try {
    const result = await cancelRestaurantReservationNotComing({
      token,
      ip: req.ip || null,
      userAgent: req.get?.("user-agent") || null,
    });
    return respond(res, result);
  } catch (error) {
    console.error("[ReservationNotComing] Cancellation failed", {
      errorClass: error?.name || "Error",
      reason: error?.code || "cancellation_failed",
    });
    return res.status(503).json({
      outcome: "unavailable",
      message: "Cancellation processing is temporarily unavailable.",
      reservation: null,
    });
  }
}

export { OUTCOME_HTTP_STATUS, OUTCOME_MESSAGES };
