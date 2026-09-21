import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

process.env.REDIS_URL = "";
process.env.BULLMQ_EMAILS_ENABLED = "false";

import Business from "../src/models/Business.js";
import Reservation from "../src/models/Reservation.js";
import ServicePoint from "../src/models/ServicePoint.js";
import {
  RESTAURANT_AVAILABILITY_POLICIES,
  RESTAURANT_BLOCKING_STATUSES,
  allocateRestaurantServicePoint,
} from "../src/services/restaurantReservationAvailabilityService.js";
const {
  createRestaurantReservation,
  reassignRestaurantReservationServicePoint,
} = await import("../src/services/reservationCreationService.js");

const mongoUri = process.env.INVENTORY_TEST_MONGODB_URI;
const businessId = "biz_restaurant_allocation";

async function createTable(servicePointId, capacity = 4) {
  return ServicePoint.create({
    businessId,
    servicePointId,
    label: servicePointId,
    code: servicePointId.slice(0, 20),
    servicePointType: "table",
    capacity,
    isActive: true,
    reservable: true,
  });
}

async function createBusiness() {
  const business = await Business.create({
    businessId,
    name: "Allocation Test",
    displayName: "Allocation Test",
    slug: "allocation-test",
    timezone: "UTC",
    status: "active",
    businessType: "restaurant",
  });
  return business.toObject();
}

async function attemptBooking({
  suffix,
  date = "2037-05-10",
  startTime = "19:00",
  endTime = "21:00",
  requestedServicePointId,
}) {
  const session = await mongoose.startSession();
  let reservation;
  try {
    await session.withTransaction(async () => {
      const servicePoint = await allocateRestaurantServicePoint({
        businessId,
        policy: RESTAURANT_AVAILABILITY_POLICIES.public,
        requestedServicePointId,
        partySize: 2,
        date,
        startTime,
        endTime,
        session,
      });
      [reservation] = await Reservation.create([{
        businessId,
        businessSlug: businessId,
        customerName: `Guest ${suffix}`,
        phone: `+1555${String(suffix).replace(/\D/g, "").padStart(7, "0").slice(-7)}`,
        email: `guest-${suffix}@example.test`,
        date,
        time: startTime,
        startTime,
        endTime,
        durationMinutes: 120,
        guestCount: 2,
        servicePointId: servicePoint.servicePointId,
        servicePointLabel: servicePoint.label,
        status: "pending",
        source: "online",
      }], { session });
    });
    return { outcome: "success", reservation };
  } catch (error) {
    if (error?.statusCode === 409) return { outcome: "conflict", error };
    throw error;
  } finally {
    await session.endSession();
  }
}

async function blockingCount({ date = "2037-05-10", startTime = "19:00", endTime = "21:00" } = {}) {
  return Reservation.countDocuments({
    businessId,
    status: { $in: [...RESTAURANT_BLOCKING_STATUSES] },
    date,
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
  });
}

test("ARC-001 restaurant allocation is serialized by MongoDB", {
  skip: mongoUri
    ? false
    : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async (t) => {
  const dbName = `quickserve_restaurant_allocation_${Date.now()}`;
  await mongoose.connect(mongoUri, { dbName });
  try {
    await Promise.all([
      Business.syncIndexes(),
      ServicePoint.syncIndexes(),
      Reservation.syncIndexes(),
    ]);
    t.beforeEach(async () => {
      await Promise.all([
        Business.deleteMany({}),
        Reservation.deleteMany({}),
        ServicePoint.deleteMany({}),
      ]);
    });

    await t.test("many overlapping requests for one table produce one winner", async () => {
      await createTable("table-only", 2);
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, (_, index) => attemptBooking({ suffix: `one-${index}` })),
      );
      assert.equal(outcomes.filter(({ outcome }) => outcome === "success").length, 1);
      assert.equal(outcomes.filter(({ outcome }) => outcome === "conflict").length, 11);
      assert.equal(await blockingCount(), 1);
    });

    await t.test("concurrent explicit requests cannot both acquire the selected table", async () => {
      await Promise.all([
        createTable("table-selected", 2),
        createTable("table-alternative", 2),
      ]);
      const outcomes = await Promise.all([
        attemptBooking({
          suffix: "selected-a",
          requestedServicePointId: "table-selected",
        }),
        attemptBooking({
          suffix: "selected-b",
          requestedServicePointId: "table-selected",
        }),
      ]);
      assert.equal(outcomes.filter(({ outcome }) => outcome === "success").length, 1);
      assert.equal(outcomes.filter(({ outcome }) => outcome === "conflict").length, 1);
      assert.equal(await Reservation.countDocuments({
        businessId,
        servicePointId: "table-selected",
      }), 1);
      assert.equal(await Reservation.countDocuments({
        businessId,
        servicePointId: "table-alternative",
      }), 0);
    });

    await t.test("an occupied explicit selection is not silently replaced", async () => {
      await Promise.all([
        createTable("table-requested", 2),
        createTable("table-free", 2),
      ]);
      const first = await attemptBooking({
        suffix: "requested-first",
        requestedServicePointId: "table-requested",
      });
      const second = await attemptBooking({
        suffix: "requested-second",
        requestedServicePointId: "table-requested",
      });
      assert.equal(first.outcome, "success");
      assert.equal(second.outcome, "conflict");
      assert.equal(await Reservation.countDocuments({
        businessId,
        servicePointId: "table-free",
      }), 0);
    });

    await t.test("concurrent requests use distinct eligible tables after retry", async () => {
      await Promise.all([createTable("table-a", 2), createTable("table-b", 2)]);
      const outcomes = await Promise.all([
        attemptBooking({ suffix: "multi-a" }),
        attemptBooking({ suffix: "multi-b" }),
      ]);
      assert.equal(outcomes.filter(({ outcome }) => outcome === "success").length, 2);
      const assigned = await Reservation.distinct("servicePointId", { businessId });
      assert.deepEqual(assigned.sort(), ["table-a", "table-b"]);
    });

    await t.test("half-open back-to-back intervals both commit", async () => {
      await createTable("table-boundary", 2);
      const first = await attemptBooking({
        suffix: "boundary-a",
        startTime: "17:00",
        endTime: "19:00",
      });
      const second = await attemptBooking({
        suffix: "boundary-b",
        startTime: "19:00",
        endTime: "21:00",
      });
      assert.deepEqual([first.outcome, second.outcome], ["success", "success"]);
    });

    await t.test("cancellation naturally releases the table", async () => {
      await createTable("table-cancel", 2);
      const first = await attemptBooking({ suffix: "cancel-a" });
      await Reservation.updateOne(
        { _id: first.reservation._id, businessId },
        { $set: { status: "cancelled", cancelledAt: new Date() } },
      );
      const replacement = await attemptBooking({ suffix: "cancel-b" });
      assert.equal(replacement.outcome, "success");
      assert.equal(await blockingCount(), 1);
    });

    await t.test("same logical creation retry returns one assigned reservation", async () => {
      const business = await createBusiness();
      await Promise.all([createTable("table-idempotent-a", 2), createTable("table-idempotent-b", 2)]);
      const input = {
        businessSlug: business.slug,
        business,
        customerName: "Retry Guest",
        phone: "+15550000999",
        email: "retry@example.test",
        date: "2037-05-10",
        startTime: "19:00",
        endTime: "21:00",
        durationMinutes: 120,
        guestCount: 2,
        source: "online",
        initialStatus: "pending",
        availabilityPolicy: RESTAURANT_AVAILABILITY_POLICIES.public,
        notificationMode: "none",
        idempotencyKey: "restaurant-retry-1",
      };
      const first = await createRestaurantReservation(input);
      const retry = await createRestaurantReservation(input);
      assert.equal(first.replayed, false);
      assert.equal(retry.replayed, true);
      assert.equal(String(first.reservationId), String(retry.reservationId));
      assert.equal(await Reservation.countDocuments({ businessId }), 1);
      assert.ok(first.reservation.servicePointId);
    });

    await t.test("idempotent explicit selection preserves the table and rejects a changed table", async () => {
      const business = await createBusiness();
      await Promise.all([
        createTable("table-idempotent-selected-a", 2),
        createTable("table-idempotent-selected-b", 2),
      ]);
      const input = {
        businessSlug: business.slug,
        business,
        customerName: "Selected Retry Guest",
        phone: "+15550000888",
        email: "selected-retry@example.test",
        date: "2037-05-10",
        startTime: "19:00",
        endTime: "21:00",
        durationMinutes: 120,
        guestCount: 2,
        servicePointId: "table-idempotent-selected-a",
        source: "online",
        initialStatus: "pending",
        availabilityPolicy: RESTAURANT_AVAILABILITY_POLICIES.public,
        notificationMode: "none",
        idempotencyKey: "restaurant-selected-retry-1",
      };
      const first = await createRestaurantReservation(input);
      const retry = await createRestaurantReservation(input);
      assert.equal(retry.replayed, true);
      assert.equal(String(first.reservationId), String(retry.reservationId));
      assert.equal(
        first.reservation.servicePointId,
        "table-idempotent-selected-a",
      );
      await assert.rejects(
        createRestaurantReservation({
          ...input,
          servicePointId: "table-idempotent-selected-b",
        }),
        (error) => error.statusCode === 409 && /another reservation request/i.test(error.message),
      );
      assert.equal(await Reservation.countDocuments({ businessId }), 1);
    });

    await t.test("reassignment and a competing booking cannot share the destination", async () => {
      await Promise.all([createTable("table-source", 2), createTable("table-destination", 2)]);
      const source = await attemptBooking({
        suffix: "reassign-source",
        requestedServicePointId: "table-source",
      });
      const reassign = reassignRestaurantReservationServicePoint({
        businessId,
        reservationId: source.reservation._id,
        newServicePointId: "table-destination",
      }).then(() => ({ outcome: "success" })).catch((error) => ({
        outcome: error?.statusCode === 409 ? "conflict" : "error",
        error,
      }));
      const competitor = attemptBooking({ suffix: "reassign-competitor" });
      const outcomes = await Promise.all([reassign, competitor]);
      assert.equal(outcomes.filter(({ outcome }) => outcome === "success").length, 1);
      assert.equal(outcomes.filter(({ outcome }) => outcome === "conflict").length, 1);
      assert.equal(await Reservation.countDocuments({
        businessId,
        servicePointId: "table-destination",
        status: { $in: [...RESTAURANT_BLOCKING_STATUSES] },
      }), 1);
    });
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
