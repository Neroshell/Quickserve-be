export function getConfiguredServicePointCapacity(servicePoint) {
  const capacity = Number(servicePoint?.capacity);
  return Number.isInteger(capacity) && capacity >= 1 ? capacity : null;
}

export function getMaximumConfiguredServicePointCapacity(servicePoints = []) {
  const capacities = servicePoints
    .map(getConfiguredServicePointCapacity)
    .filter((capacity) => capacity !== null);

  return capacities.length > 0 ? Math.max(...capacities) : null;
}

export function getReservationGuestCapacity({
  servicePoints = [],
  servicePointId,
} = {}) {
  if (servicePointId) {
    const selectedServicePoint = servicePoints.find(
      (servicePoint) => servicePoint.servicePointId === servicePointId
    );
    return getConfiguredServicePointCapacity(selectedServicePoint);
  }

  return getMaximumConfiguredServicePointCapacity(servicePoints);
}

export function validateReservationGuestCapacity({
  guestCount,
  servicePoints = [],
  servicePointId,
} = {}) {
  const capacity = getReservationGuestCapacity({
    servicePoints,
    servicePointId,
  });

  return {
    capacity,
    valid: capacity === null || guestCount <= capacity,
  };
}
