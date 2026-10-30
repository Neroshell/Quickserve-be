export const RESERVATION_MODES = Object.freeze(["stay", "timeslot"]);

export class ReservationModeError extends Error {
  constructor(message, { statusCode = 400, code = "RESERVATION_MODE_INVALID" } = {}) {
    super(message);
    this.name = "ReservationModeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || "");
}

function hasAnyValue(reservation, fields) {
  return fields.some((field) => isNonEmptyString(reservation?.[field]));
}

/**
 * Returns a mode only for an unambiguous, valid persisted reservation shape.
 * Ambiguous and incomplete legacy records intentionally return null so callers
 * never infer type from ServicePoints, labels, or the business shell.
 */
export function getReservationMode(reservation) {
  const hasStayFields = hasAnyValue(reservation, ["checkInDate", "checkOutDate"]);
  const hasTimeslotFields = hasAnyValue(reservation, ["date", "startTime", "endTime"]);
  if (hasStayFields && hasTimeslotFields) return null;

  if (
    isIsoDate(reservation?.checkInDate) &&
    isIsoDate(reservation?.checkOutDate) &&
    !hasTimeslotFields
  ) {
    return "stay";
  }

  if (
    isIsoDate(reservation?.date) &&
    isTime(reservation?.startTime) &&
    isTime(reservation?.endTime) &&
    !hasStayFields
  ) {
    return "timeslot";
  }

  return null;
}

function noValuePredicate(field) {
  return {
    $or: [
      { [field]: { $exists: false } },
      { [field]: null },
      { [field]: "" },
    ],
  };
}

function stringDatePredicate(field) {
  return { [field]: { $type: "string", $regex: /^\d{4}-\d{2}-\d{2}$/ } };
}

function validDatePredicate(field) {
  const parsedDate = {
    $dateFromString: {
      dateString: `$${field}`,
      format: "%Y-%m-%d",
      onError: null,
      onNull: null,
    },
  };
  return {
    $expr: {
      $eq: [
        {
          $dateToString: {
            date: parsedDate,
            format: "%Y-%m-%d",
            timezone: "UTC",
            onNull: null,
          },
        },
        `$${field}`,
      ],
    },
  };
}

function stringTimePredicate(field) {
  return { [field]: { $type: "string", $regex: /^(?:[01]\d|2[0-3]):[0-5]\d$/ } };
}

/**
 * Query predicate mirroring getReservationMode. It deliberately excludes
 * mixed/incomplete historical records rather than guessing their mode.
 */
export function buildReservationModeQuery(mode) {
  if (mode === "stay") {
    return {
      $and: [
        stringDatePredicate("checkInDate"),
        stringDatePredicate("checkOutDate"),
        validDatePredicate("checkInDate"),
        validDatePredicate("checkOutDate"),
        noValuePredicate("date"),
        noValuePredicate("startTime"),
        noValuePredicate("endTime"),
      ],
    };
  }

  if (mode === "timeslot") {
    return {
      $and: [
        stringDatePredicate("date"),
        validDatePredicate("date"),
        stringTimePredicate("startTime"),
        stringTimePredicate("endTime"),
        noValuePredicate("checkInDate"),
        noValuePredicate("checkOutDate"),
      ],
    };
  }

  throw new ReservationModeError("mode must be stay or timeslot");
}

export function resolveReservationMode({ requestedMode, capabilities }) {
  const modes = capabilities?.reservations?.modes || [];
  const primaryMode = capabilities?.reservations?.primaryMode;
  const modeWasRequested = requestedMode !== undefined && requestedMode !== null && requestedMode !== "";

  if (modeWasRequested && (typeof requestedMode !== "string" || !RESERVATION_MODES.includes(requestedMode))) {
    throw new ReservationModeError("mode must be stay or timeslot");
  }

  const resolvedMode = modeWasRequested ? requestedMode : primaryMode;
  if (!RESERVATION_MODES.includes(resolvedMode) || !modes.includes(resolvedMode)) {
    throw new ReservationModeError("Reservation mode is not available for this business.", {
      statusCode: 404,
      code: "RESERVATION_MODE_UNAVAILABLE",
    });
  }

  return resolvedMode;
}
