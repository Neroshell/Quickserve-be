import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import Reservation from "../src/models/Reservation.js";
import ServicePoint from "../src/models/ServicePoint.js";
import {
  assertNoRoomConflict,
  lockHotelRoomForReservation,
  reassignHotelReservationRoom,
} from "../src/services/reservationCreationService.js";

const mongoUri = process.env.INVENTORY_TEST_MONGODB_URI;
const BLOCKING_STATUSES = [
  "pending",
  "accepted_awaiting_payment",
  "confirmed",
  "checked_in",
];

function reservationValues({
  businessId,
  servicePointId,
  checkInDate,
  checkOutDate,
  suffix,
}) {
  return {
    businessId,
    businessSlug: businessId,
    customerName: `Guest ${suffix}`,
    phone: `+1555${String(suffix).replace(/\D/g, "").padStart(7, "0").slice(-7)}`,
    email: `guest-${suffix}@example.test`,
    guestCount: 1,
    servicePointId,
    servicePointLabel: servicePointId,
    checkInDate,
    checkOutDate,
    status: "pending",
    source: "online",
  };
}

async function createRoom({
  businessId = "biz_hotel_concurrency",
  servicePointId,
  isActive = true,
  reservable = true,
}) {
  return ServicePoint.create({
    businessId,
    servicePointId,
    label: servicePointId,
    code: servicePointId.slice(0, 20),
    servicePointType: "room",
    capacity: 2,
    pricePerNight: 100,
    isActive,
    reservable,
  });
}

async function attemptBooking({
  businessId = "biz_hotel_concurrency",
  servicePointId,
  checkInDate,
  checkOutDate,
  suffix,
  failAfterLock = false,
}) {
  const session = await mongoose.startSession();
  let reservation;

  try {
    await session.withTransaction(async () => {
      await lockHotelRoomForReservation({
        businessId,
        servicePointId,
        session,
      });

      if (failAfterLock) {
        const error = new Error("simulated failure after allocation lock");
        error.code = "SIMULATED_AFTER_LOCK_FAILURE";
        throw error;
      }

      await assertNoRoomConflict({
        businessId,
        servicePointId,
        checkInDate,
        checkOutDate,
        session,
      });

      [reservation] = await Reservation.create([
        reservationValues({
          businessId,
          servicePointId,
          checkInDate,
          checkOutDate,
          suffix,
        }),
      ], { session });
    });

    return { outcome: "success", reservation };
  } catch (error) {
    if (error?.statusCode === 409) {
      return { outcome: "conflict", error };
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function blockingCount({
  businessId = "biz_hotel_concurrency",
  servicePointId,
  checkInDate,
  checkOutDate,
}) {
  return Reservation.countDocuments({
    businessId,
    servicePointId,
    status: { $in: BLOCKING_STATUSES },
    checkInDate: { $lt: checkOutDate },
    checkOutDate: { $gt: checkInDate },
  });
}

test("SEC-L001 hotel allocation is serialized by MongoDB", {
  skip: mongoUri
    ? false
    : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async (t) => {
  const dbName = `quickserve_hotel_concurrency_${Date.now()}`;
  await mongoose.connect(mongoUri, { dbName });

  try {
    await Promise.all([
      ServicePoint.syncIndexes(),
      Reservation.syncIndexes(),
    ]);

    t.beforeEach(async () => {
      await Promise.all([
        Reservation.deleteMany({}),
        ServicePoint.deleteMany({}),
      ]);
    });

    await t.test("sequential non-overlapping bookings succeed", async () => {
      await createRoom({ servicePointId: "sp_seq_non_overlap" });

      const first = await attemptBooking({
        servicePointId: "sp_seq_non_overlap",
        checkInDate: "2035-10-10",
        checkOutDate: "2035-10-12",
        suffix: "seq-1",
      });
      const second = await attemptBooking({
        servicePointId: "sp_seq_non_overlap",
        checkInDate: "2035-10-14",
        checkOutDate: "2035-10-16",
        suffix: "seq-2",
      });

      assert.equal(first.outcome, "success");
      assert.equal(second.outcome, "success");
      assert.equal(await Reservation.countDocuments({}), 2);
    });

    await t.test("sequential overlapping booking is denied", async () => {
      await createRoom({ servicePointId: "sp_seq_overlap" });
      await attemptBooking({
        servicePointId: "sp_seq_overlap",
        checkInDate: "2035-10-10",
        checkOutDate: "2035-10-15",
        suffix: "seq-overlap-1",
      });

      const blocked = await attemptBooking({
        servicePointId: "sp_seq_overlap",
        checkInDate: "2035-10-11",
        checkOutDate: "2035-10-13",
        suffix: "seq-overlap-2",
      });

      assert.equal(blocked.outcome, "conflict");
      assert.equal(await Reservation.countDocuments({}), 1);
    });

    await t.test("20 identical concurrent attempts produce one winner", async () => {
      const servicePointId = "sp_identical_race";
      await createRoom({ servicePointId });

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, index) => attemptBooking({
          servicePointId,
          checkInDate: "2035-11-10",
          checkOutDate: "2035-11-12",
          suffix: `race-${index}`,
        })),
      );

      assert.equal(outcomes.filter(({ outcome }) => outcome === "success").length, 1);
      assert.equal(outcomes.filter(({ outcome }) => outcome === "conflict").length, 19);
      assert.equal(await blockingCount({
        servicePointId,
        checkInDate: "2035-11-10",
        checkOutDate: "2035-11-12",
      }), 1);
    });

    await t.test("partial overlaps all lose against one committed stay", async () => {
      const servicePointId = "sp_partial_overlap";
      await createRoom({ servicePointId });
      await attemptBooking({
        servicePointId,
        checkInDate: "2035-12-10",
        checkOutDate: "2035-12-15",
        suffix: "partial-existing",
      });

      const outcomes = await Promise.all([
        ["2035-12-09", "2035-12-11", "partial-leading"],
        ["2035-12-14", "2035-12-16", "partial-trailing"],
        ["2035-12-11", "2035-12-13", "partial-contained"],
      ].map(([checkInDate, checkOutDate, suffix]) => attemptBooking({
        servicePointId,
        checkInDate,
        checkOutDate,
        suffix,
      })));

      assert.deepEqual(outcomes.map(({ outcome }) => outcome), [
        "conflict",
        "conflict",
        "conflict",
      ]);
      assert.equal(await Reservation.countDocuments({}), 1);
    });

    await t.test("back-to-back half-open stays both commit", async () => {
      const servicePointId = "sp_boundary";
      await createRoom({ servicePointId });

      const outcomes = await Promise.all([
        attemptBooking({
          servicePointId,
          checkInDate: "2036-01-10",
          checkOutDate: "2036-01-12",
          suffix: "boundary-a",
        }),
        attemptBooking({
          servicePointId,
          checkInDate: "2036-01-12",
          checkOutDate: "2036-01-14",
          suffix: "boundary-b",
        }),
      ]);

      assert.deepEqual(outcomes.map(({ outcome }) => outcome), ["success", "success"]);
      assert.equal(await Reservation.countDocuments({}), 2);

      await assert.rejects(
        attemptBooking({
          businessId: "biz_hotel_a",
          servicePointId: "sp_tenant_b_401",
          checkInDate: "2036-03-14",
          checkOutDate: "2036-03-16",
          suffix: "tenant-substitution",
        }),
        (error) => error?.statusCode === 400,
      );
      assert.equal(await Reservation.countDocuments({}), 2);
    });

    await t.test("different rooms book concurrently", async () => {
      await Promise.all([
        createRoom({ servicePointId: "sp_independent_401" }),
        createRoom({ servicePointId: "sp_independent_402" }),
      ]);

      const outcomes = await Promise.all([
        attemptBooking({
          servicePointId: "sp_independent_401",
          checkInDate: "2036-02-10",
          checkOutDate: "2036-02-12",
          suffix: "room-401",
        }),
        attemptBooking({
          servicePointId: "sp_independent_402",
          checkInDate: "2036-02-10",
          checkOutDate: "2036-02-12",
          suffix: "room-402",
        }),
      ]);

      assert.deepEqual(outcomes.map(({ outcome }) => outcome), ["success", "success"]);
    });

    await t.test("different businesses remain isolated", async () => {
      await Promise.all([
        createRoom({ businessId: "biz_hotel_a", servicePointId: "sp_tenant_a_401" }),
        createRoom({ businessId: "biz_hotel_b", servicePointId: "sp_tenant_b_401" }),
      ]);

      const outcomes = await Promise.all([
        attemptBooking({
          businessId: "biz_hotel_a",
          servicePointId: "sp_tenant_a_401",
          checkInDate: "2036-03-10",
          checkOutDate: "2036-03-12",
          suffix: "tenant-a",
        }),
        attemptBooking({
          businessId: "biz_hotel_b",
          servicePointId: "sp_tenant_b_401",
          checkInDate: "2036-03-10",
          checkOutDate: "2036-03-12",
          suffix: "tenant-b",
        }),
      ]);

      assert.deepEqual(outcomes.map(({ outcome }) => outcome), ["success", "success"]);
      assert.equal(await Reservation.countDocuments({}), 2);
    });

    await t.test("inactive and reservation-disabled rooms are denied", async () => {
      await Promise.all([
        createRoom({ servicePointId: "sp_inactive", isActive: false }),
        createRoom({ servicePointId: "sp_not_reservable", reservable: false }),
      ]);

      await assert.rejects(
        attemptBooking({
          servicePointId: "sp_inactive",
          checkInDate: "2036-04-10",
          checkOutDate: "2036-04-12",
          suffix: "inactive",
        }),
        (error) => error?.statusCode === 400,
      );
      await assert.rejects(
        attemptBooking({
          servicePointId: "sp_not_reservable",
          checkInDate: "2036-04-10",
          checkOutDate: "2036-04-12",
          suffix: "not-reservable",
        }),
        (error) => error?.statusCode === 400,
      );
      assert.equal(await Reservation.countDocuments({}), 0);
    });

    await t.test("housekeeping readiness does not block future occupancy", async () => {
      const servicePointId = "sp_needs_cleaning";
      await createRoom({ servicePointId });
      await ServicePoint.updateOne(
        { businessId: "biz_hotel_concurrency", servicePointId },
        {
          $set: {
            roomReadiness: {
              state: "needs_cleaning",
              changedAt: new Date(),
              changedBy: "checkout",
            },
          },
        },
      );

      const futureStay = await attemptBooking({
        servicePointId,
        checkInDate: "2036-04-20",
        checkOutDate: "2036-04-22",
        suffix: "readiness-independent",
      });

      assert.equal(futureStay.outcome, "success");
    });

    await t.test("transaction rollback leaves no stale room allocation", async () => {
      const servicePointId = "sp_rollback";
      const room = await createRoom({ servicePointId });

      await assert.rejects(
        attemptBooking({
          servicePointId,
          checkInDate: "2036-05-10",
          checkOutDate: "2036-05-12",
          suffix: "rollback-failure",
          failAfterLock: true,
        }),
        (error) => error?.code === "SIMULATED_AFTER_LOCK_FAILURE",
      );

      const afterRollback = await ServicePoint.findById(room._id).lean();
      assert.equal(afterRollback.updatedAt.getTime(), room.updatedAt.getTime());
      assert.equal(await Reservation.countDocuments({}), 0);

      const retry = await attemptBooking({
        servicePointId,
        checkInDate: "2036-05-10",
        checkOutDate: "2036-05-12",
        suffix: "rollback-retry",
      });
      assert.equal(retry.outcome, "success");
    });

    await t.test("same request retry cannot duplicate the reservation", async () => {
      const servicePointId = "sp_request_retry";
      await createRoom({ servicePointId });
      const input = {
        servicePointId,
        checkInDate: "2036-06-10",
        checkOutDate: "2036-06-12",
        suffix: "request-retry",
      };

      const first = await attemptBooking(input);
      const retry = await attemptBooking(input);

      assert.equal(first.outcome, "success");
      assert.equal(retry.outcome, "conflict");
      assert.equal(await Reservation.countDocuments({}), 1);
    });

    await t.test("cancellation releases the stay interval", async () => {
      const servicePointId = "sp_cancellation";
      await createRoom({ servicePointId });
      const first = await attemptBooking({
        servicePointId,
        checkInDate: "2036-07-10",
        checkOutDate: "2036-07-12",
        suffix: "cancelled-original",
      });

      await Reservation.updateOne(
        { _id: first.reservation._id, businessId: "biz_hotel_concurrency" },
        { $set: { status: "cancelled", cancelledAt: new Date() } },
      );

      const replacement = await attemptBooking({
        servicePointId,
        checkInDate: "2036-07-10",
        checkOutDate: "2036-07-12",
        suffix: "cancelled-replacement",
      });

      assert.equal(replacement.outcome, "success");
      assert.equal(await Reservation.countDocuments({}), 2);
      assert.equal(await blockingCount({
        servicePointId,
        checkInDate: "2036-07-10",
        checkOutDate: "2036-07-12",
      }), 1);
    });

    await t.test("room reassignment races through the destination lock", async () => {
      await Promise.all([
        createRoom({ servicePointId: "sp_reassign_source" }),
        createRoom({ servicePointId: "sp_reassign_destination" }),
      ]);
      const source = await attemptBooking({
        servicePointId: "sp_reassign_source",
        checkInDate: "2036-08-10",
        checkOutDate: "2036-08-12",
        suffix: "reassign-source",
      });

      const reassign = reassignHotelReservationRoom({
        businessId: "biz_hotel_concurrency",
        reservationId: source.reservation._id,
        newServicePointId: "sp_reassign_destination",
      }).then(() => ({ outcome: "success" })).catch((error) => ({
        outcome: error?.statusCode === 409 ? "conflict" : "error",
        error,
      }));
      const competingBooking = attemptBooking({
        servicePointId: "sp_reassign_destination",
        checkInDate: "2036-08-10",
        checkOutDate: "2036-08-12",
        suffix: "reassign-competitor",
      });

      const outcomes = await Promise.all([reassign, competingBooking]);
      assert.equal(outcomes.filter(({ outcome }) => outcome === "success").length, 1);
      assert.equal(outcomes.filter(({ outcome }) => outcome === "conflict").length, 1);
      assert.equal(await blockingCount({
        servicePointId: "sp_reassign_destination",
        checkInDate: "2036-08-10",
        checkOutDate: "2036-08-12",
      }), 1);
    });
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
