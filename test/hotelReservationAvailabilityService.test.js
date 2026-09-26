import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKING_STAY_STATUSES,
  buildHotelRoomEligibilityQuery,
  buildHotelStayOverlapQuery,
  findHotelRoomAvailability,
  getHotelRoomPricingPreview,
  lockHotelRoomForReservation,
  validateHotelStayWindow,
} from "../src/services/hotelReservationAvailabilityService.js";
import {
  lockHotelRoomForReservation as creationRoomLock,
} from "../src/services/reservationCreationService.js";
import {
  buildReservationPricingSnapshot,
  getCustomerReservationPricing,
} from "../src/services/reservationPricingService.js";

const business = {
  businessId: "biz_hotel_alpha",
  timezone: "Europe/Malta",
  taxRate: 18,
  platformFeeMode: "business_absorbs",
  currency: "eur",
};

const commissionCalculator = (subtotalCents) => ({
  commissionAmountCents: Math.round(subtotalCents * 0.03),
  commissionRateApplied: 3,
  planApplied: "basic",
});

function eligibleRooms(rooms, query) {
  return rooms.filter((room) => {
    if (room.businessId !== query.businessId) return false;
    if (query.servicePointId && room.servicePointId !== query.servicePointId) return false;
    if (room.isActive === false || room.reservable === false) return false;
    return room.servicePointType === "room" || room.servicePointType == null;
  });
}

function overlappingReservations(reservations, query) {
  const allowedIds = query.servicePointId?.$in || null;
  return reservations.filter((reservation) => (
    reservation.businessId === query.businessId &&
    (!allowedIds || allowedIds.includes(reservation.servicePointId)) &&
    query.status.$in.includes(reservation.status) &&
    reservation.checkInDate < query.checkInDate.$lt &&
    reservation.checkOutDate > query.checkOutDate.$gt
  ));
}

function servicePointModelFor(rooms, capture = {}) {
  return {
    find(query) {
      capture.findQuery = query;
      return {
        lean: async () => eligibleRooms(rooms, query),
      };
    },
    findOne(query) {
      capture.findOneQuery = query;
      return {
        session() {
          return this;
        },
        lean: async () => eligibleRooms(rooms, query)[0] || null,
      };
    },
    findOneAndUpdate(query, update, options) {
      capture.lockQuery = query;
      capture.lockUpdate = update;
      capture.lockOptions = options;
      return {
        lean: async () => eligibleRooms(rooms, query)[0] || null,
      };
    },
  };
}

function reservationModelFor(reservations, capture = {}) {
  return {
    find(query) {
      capture.overlapQuery = query;
      return {
        select() {
          return this;
        },
        lean: async () => overlappingReservations(reservations, query),
      };
    },
  };
}

test("hotel stay validation accepts a valid window and rejects malformed/reversed dates", () => {
  const result = validateHotelStayWindow({
    business,
    checkInDate: "2035-03-10",
    checkOutDate: "2035-03-13",
  });
  assert.equal(result.numberOfNights, 3);

  assert.throws(
    () => validateHotelStayWindow({
      business,
      checkInDate: "2035-3-10",
      checkOutDate: "2035-03-13",
    }),
    /valid ISO dates/,
  );
  assert.throws(
    () => validateHotelStayWindow({
      business,
      checkInDate: "2035-03-13",
      checkOutDate: "2035-03-13",
    }),
    /after check-in/,
  );
});

test("hotel room eligibility is tenant scoped and excludes non-room/disabled inventory", () => {
  const query = buildHotelRoomEligibilityQuery({
    businessId: business.businessId,
    servicePointId: "sp_room_1",
  });
  assert.equal(query.businessId, business.businessId);
  assert.equal(query.servicePointId, "sp_room_1");
  assert.deepEqual(query.isActive, { $ne: false });
  assert.deepEqual(query.reservable, { $ne: false });
  assert.ok(query.$or.some((condition) => condition.servicePointType === "room"));
});

test("hotel overlap policy blocks pending/confirmed/checked-in but permits cancelled and back-to-back", async () => {
  assert.deepEqual(BLOCKING_STAY_STATUSES, [
    "pending",
    "accepted_awaiting_payment",
    "confirmed",
    "checked_in",
  ]);
  assert.equal(BLOCKING_STAY_STATUSES.includes("cancelled"), false);

  const rooms = [
    { businessId: business.businessId, servicePointId: "sp_free", servicePointType: "room", capacity: 2, pricePerNight: 100 },
    { businessId: business.businessId, servicePointId: "sp_pending", servicePointType: "room", capacity: 2, pricePerNight: 100 },
    { businessId: business.businessId, servicePointId: "sp_confirmed", servicePointType: "room", capacity: 2, pricePerNight: 100 },
    { businessId: business.businessId, servicePointId: "sp_checked_in", servicePointType: "room", capacity: 2, pricePerNight: 100 },
    { businessId: business.businessId, servicePointId: "sp_cancelled", servicePointType: "room", capacity: 2, pricePerNight: 100 },
    { businessId: business.businessId, servicePointId: "sp_back_to_back", servicePointType: "room", capacity: 1, pricePerNight: 100 },
    { businessId: business.businessId, servicePointId: "sp_table", servicePointType: "table", capacity: 4, pricePerNight: 100 },
    { businessId: business.businessId, servicePointId: "sp_disabled", servicePointType: "room", isActive: false, capacity: 2, pricePerNight: 100 },
    { businessId: business.businessId, servicePointId: "sp_not_reservable", servicePointType: "room", reservable: false, capacity: 2, pricePerNight: 100 },
    { businessId: "biz_hotel_other", servicePointId: "sp_other_tenant", servicePointType: "room", capacity: 2, pricePerNight: 100 },
  ];
  const reservations = [
    { businessId: business.businessId, servicePointId: "sp_pending", status: "pending", checkInDate: "2035-03-11", checkOutDate: "2035-03-12" },
    { businessId: business.businessId, servicePointId: "sp_confirmed", status: "confirmed", checkInDate: "2035-03-09", checkOutDate: "2035-03-11" },
    { businessId: business.businessId, servicePointId: "sp_checked_in", status: "checked_in", checkInDate: "2035-03-10", checkOutDate: "2035-03-13" },
    { businessId: business.businessId, servicePointId: "sp_cancelled", status: "cancelled", checkInDate: "2035-03-10", checkOutDate: "2035-03-13" },
    { businessId: business.businessId, servicePointId: "sp_back_to_back", status: "confirmed", checkInDate: "2035-03-08", checkOutDate: "2035-03-10" },
  ];
  const capture = {};
  const result = await findHotelRoomAvailability({
    business,
    checkInDate: "2035-03-10",
    checkOutDate: "2035-03-13",
    guestCount: 2,
    servicePointModel: servicePointModelFor(rooms, capture),
    reservationModel: reservationModelFor(reservations, capture),
    commissionCalculator,
  });
  const byId = Object.fromEntries(result.rooms.map((room) => [room.servicePointId, room]));

  assert.equal(result.numberOfNights, 3);
  assert.equal(byId.sp_free.available, true);
  assert.equal(byId.sp_pending.available, false);
  assert.equal(byId.sp_confirmed.available, false);
  assert.equal(byId.sp_checked_in.available, false);
  assert.equal(byId.sp_cancelled.available, true);
  assert.equal(byId.sp_back_to_back.available, true);
  assert.equal(byId.sp_back_to_back.capacityExceeded, true);
  assert.equal(byId.sp_table, undefined);
  assert.equal(byId.sp_disabled, undefined);
  assert.equal(byId.sp_not_reservable, undefined);
  assert.equal(byId.sp_other_tenant, undefined);
  assert.equal(byId.sp_free.pricingSummary.nights, 3);
  assert.equal(capture.overlapQuery.status.$in.includes("pending"), true);
  assert.deepEqual(capture.overlapQuery.checkInDate, { $lt: "2035-03-13" });
  assert.deepEqual(capture.overlapQuery.checkOutDate, { $gt: "2035-03-10" });
});

test("hotel pricing preview matches the reservation creation snapshot engine", async () => {
  const room = {
    businessId: business.businessId,
    servicePointId: "sp_pricing",
    servicePointType: "room",
    capacity: 2,
    pricePerNight: 125,
  };
  const preview = await getHotelRoomPricingPreview({
    business,
    servicePointId: room.servicePointId,
    checkInDate: "2035-04-10",
    checkOutDate: "2035-04-12",
    servicePointModel: servicePointModelFor([room]),
    commissionCalculator,
  });
  const snapshot = await buildReservationPricingSnapshot({
    reservation: { pricePerNight: room.pricePerNight, numberOfNights: 2 },
    business,
    commissionCalculator,
  });

  assert.deepEqual(preview, getCustomerReservationPricing(snapshot));
});

test("reservation creation reuses the canonical room lock and eligibility query", async () => {
  assert.equal(creationRoomLock, lockHotelRoomForReservation);

  const capture = {};
  const room = {
    businessId: business.businessId,
    servicePointId: "sp_lock",
    servicePointType: "room",
  };
  await lockHotelRoomForReservation({
    businessId: business.businessId,
    servicePointId: room.servicePointId,
    session: { id: "session" },
    servicePointModel: servicePointModelFor([room], capture),
  });
  assert.equal(capture.lockQuery.businessId, business.businessId);
  assert.equal(capture.lockQuery.servicePointId, room.servicePointId);
  assert.ok(capture.lockQuery.$or);
  assert.deepEqual(capture.lockUpdate, { $currentDate: { updatedAt: true } });
});

test("hotel overlap query uses strict inequalities for back-to-back stays", () => {
  const query = buildHotelStayOverlapQuery({
    businessId: business.businessId,
    servicePointId: "sp_room",
    checkInDate: "2035-05-10",
    checkOutDate: "2035-05-12",
  });
  assert.deepEqual(query.checkInDate, { $lt: "2035-05-12" });
  assert.deepEqual(query.checkOutDate, { $gt: "2035-05-10" });
});
