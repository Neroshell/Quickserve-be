const EXPECTED_STATUSES = new Set([
  "pending",
  "confirmed",
  "arrived",
  "seated",
  "completed",
  "no_show",
]);

const ARRIVED_STATUSES = new Set(["arrived", "seated", "completed"]);
const VISIBLE_TODAY_STATUSES = new Set([
  "pending",
  "confirmed",
  "arrived",
  "seated",
  "completed",
  "no_show",
]);

function timeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value || ""))) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (hours > 23 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function uniqueServicePointIds(reservations) {
  return new Set(
    reservations
      .map((reservation) => reservation.servicePointId)
      .filter(Boolean),
  );
}

function compareReservationTimes(first, second) {
  return String(first.startTime || first.time || "").localeCompare(
    String(second.startTime || second.time || ""),
  );
}

/**
 * Builds the authoritative restaurant operations summary for one business day.
 * All persistence queries remain in the controller; this function only derives
 * display metrics from already tenant-scoped Reservation and ServicePoint data.
 */
export function buildRestaurantTodayOperations({
  reservations = [],
  servicePoints = [],
  businessDate,
  currentBusinessDate,
  currentTime,
}) {
  const isCurrentBusinessDay = businessDate === currentBusinessDate;
  const parsedCurrentTime = timeToMinutes(currentTime);
  const referenceMinutes = isCurrentBusinessDay && parsedCurrentTime !== null
    ? parsedCurrentTime
    : businessDate < currentBusinessDate
      ? (24 * 60)
      : -1;

  const visibleReservations = reservations
    .filter((reservation) => VISIBLE_TODAY_STATUSES.has(reservation.status))
    .sort(compareReservationTimes);
  const expectedReservations = reservations.filter((reservation) =>
    EXPECTED_STATUSES.has(reservation.status),
  );
  const arrivedReservations = reservations.filter((reservation) =>
    ARRIVED_STATUSES.has(reservation.status),
  );
  const seatedReservations = reservations.filter(
    (reservation) => reservation.status === "seated",
  );
  const upcomingReservations = reservations.filter((reservation) => {
    const startMinutes = timeToMinutes(reservation.startTime || reservation.time);
    return (
      ["pending", "confirmed"].includes(reservation.status) &&
      startMinutes !== null &&
      startMinutes > referenceMinutes
    );
  });

  const needsAttention = [];
  for (const reservation of visibleReservations) {
    const startMinutes = timeToMinutes(reservation.startTime || reservation.time);
    if (reservation.status === "pending") {
      needsAttention.push({
        ...reservation,
        attentionReason: "pending_confirmation",
        minutesLate: 0,
      });
      continue;
    }

    if (
      isCurrentBusinessDay &&
      reservation.status === "confirmed" &&
      startMinutes !== null &&
      startMinutes < referenceMinutes
    ) {
      needsAttention.push({
        ...reservation,
        attentionReason: "late",
        minutesLate: referenceMinutes - startMinutes,
      });
      continue;
    }

    if (reservation.status === "arrived") {
      needsAttention.push({
        ...reservation,
        attentionReason: "awaiting_seating",
        minutesLate: 0,
      });
    }
  }

  needsAttention.sort((first, second) => {
    const priority = { late: 0, awaiting_seating: 1, pending_confirmation: 2 };
    const priorityDifference =
      (priority[first.attentionReason] ?? 9) -
      (priority[second.attentionReason] ?? 9);
    return priorityDifference || compareReservationTimes(first, second);
  });

  const activeServicePoints = servicePoints.filter(
    (servicePoint) =>
      servicePoint.isActive !== false &&
      servicePoint.servicePointType !== "room",
  );
  const activeServicePointIds = new Set(
    activeServicePoints.map((servicePoint) => servicePoint.servicePointId),
  );
  const occupiedIds = uniqueServicePointIds(seatedReservations);
  const reservedLaterIds = uniqueServicePointIds(upcomingReservations);

  for (const servicePointId of [...occupiedIds]) {
    if (!activeServicePointIds.has(servicePointId)) occupiedIds.delete(servicePointId);
  }
  for (const servicePointId of [...reservedLaterIds]) {
    if (!activeServicePointIds.has(servicePointId) || occupiedIds.has(servicePointId)) {
      reservedLaterIds.delete(servicePointId);
    }
  }

  const totalServicePoints = activeServicePoints.length;
  const availableServicePoints = Math.max(0, totalServicePoints - occupiedIds.size);
  const nextBusyReservation = upcomingReservations
    .slice()
    .sort(compareReservationTimes)[0];

  return {
    operations: {
      reservations: visibleReservations,
      needsAttention,
    },
    stats: {
      expectedToday: {
        total: expectedReservations.length,
        upcoming: upcomingReservations.length,
      },
      arrivedToday: {
        total: arrivedReservations.length,
        percent: expectedReservations.length > 0
          ? Math.round((arrivedReservations.length / expectedReservations.length) * 100)
          : 0,
      },
      seatedNow: {
        reservations: seatedReservations.length,
        guests: seatedReservations.reduce(
          (total, reservation) => total + Number(reservation.guestCount || 0),
          0,
        ),
      },
      tableAvailability: {
        available: availableServicePoints,
        total: totalServicePoints,
        occupied: occupiedIds.size,
        reservedLater: reservedLaterIds.size,
      },
      nextBusyTime: nextBusyReservation?.startTime || nextBusyReservation?.time || null,
    },
  };
}

