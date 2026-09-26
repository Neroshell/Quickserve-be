/**
 * ARCH-006: Reservation creation idempotency — backfill migration
 *
 * Safe to run multiple times (all steps are idempotent).
 *
 * Steps:
 *   1. Audit existing indexes on the reservations collection
 *   2. Backfill creationIdempotencyKey / creationFingerprint from legacy
 *      restaurantCreation* fields for existing restaurant reservations
 *   3. Validate: no hotel docs accidentally have restaurantCreation* fields
 *   4. Ensure the new generic unique partial index exists
 *   5. Verify the index is present and unique
 *
 * Usage:  node scripts/arch-006-reservation-idempotency-migration.js
 * Env:    MONGODB_URI — required
 */

import mongoose from "mongoose";
import { config } from "dotenv";

config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log("[ARCH-006] Connected to MongoDB.");

  const db = mongoose.connection.db;
  const col = db.collection("reservations");

  // Step 1: Audit
  console.log("\n[ARCH-006] Step 1: Auditing indexes...");
  const indexes = await col.indexes();
  const indexNames = indexes.map((i) => i.name);
  console.log("  Indexes:\n  " + indexNames.join("\n  "));
  const hasLegacyIndex = indexNames.includes("uniq_restaurant_reservation_creation_request");
  const hasGenericIndex = indexNames.includes("uniq_reservation_creation_request");
  console.log(`  Legacy restaurant index: ${hasLegacyIndex}`);
  console.log(`  Generic creation index: ${hasGenericIndex}`);

  // Step 2: Backfill
  console.log("\n[ARCH-006] Step 2: Backfilling generic fields from legacy restaurant fields...");
  const toBackfill = await col
    .find({
      restaurantCreationIdempotencyKey: { $type: "string" },
      creationIdempotencyKey: { $exists: false },
    })
    .project({ _id: 1, restaurantCreationIdempotencyKey: 1, restaurantCreationFingerprint: 1 })
    .toArray();

  console.log(`  ${toBackfill.length} restaurant reservations to backfill.`);
  let backfilled = 0, skipped = 0;
  for (const doc of toBackfill) {
    const conflict = await col.findOne({
      creationIdempotencyKey: doc.restaurantCreationIdempotencyKey,
      _id: { $ne: doc._id },
    });
    if (conflict) {
      console.warn(`  [SKIP] ${doc._id} conflicts with ${conflict._id}`);
      skipped++;
      continue;
    }
    await col.updateOne(
      { _id: doc._id },
      {
        $set: {
          creationIdempotencyKey: doc.restaurantCreationIdempotencyKey,
          ...(doc.restaurantCreationFingerprint
            ? { creationFingerprint: doc.restaurantCreationFingerprint }
            : {}),
        },
      },
    );
    backfilled++;
  }
  console.log(`  Backfill done: ${backfilled} updated, ${skipped} skipped.`);

  // Step 3: Validate hotel docs
  console.log("\n[ARCH-006] Step 3: Validating hotel docs...");
  const hotelWithLegacy = await col.countDocuments({
    checkInDate: { $exists: true },
    restaurantCreationIdempotencyKey: { $type: "string" },
  });
  if (hotelWithLegacy > 0) {
    console.warn(`  WARNING: ${hotelWithLegacy} hotel reservations have restaurantCreation* fields.`);
  } else {
    console.log("  OK: No hotel reservations have restaurantCreation* fields.");
  }

  // Step 4: Ensure generic index
  console.log("\n[ARCH-006] Step 4: Ensuring generic index...");
  if (!hasGenericIndex) {
    await col.createIndex(
      { businessId: 1, creationIdempotencyKey: 1 },
      {
        unique: true,
        partialFilterExpression: { creationIdempotencyKey: { $type: "string" } },
        name: "uniq_reservation_creation_request",
        background: true,
      },
    );
    console.log("  Index created.");
  } else {
    console.log("  Index already exists.");
  }

  // Step 5: Verify
  console.log("\n[ARCH-006] Step 5: Verifying index...");
  const updatedIndexes = await col.indexes();
  const genericIdx = updatedIndexes.find((i) => i.name === "uniq_reservation_creation_request");
  if (!genericIdx || !genericIdx.unique) {
    console.error("  FAIL: generic index missing or not unique!");
    process.exit(1);
  }
  console.log("  OK: uniq_reservation_creation_request is a unique partial index.");

  console.log("\n[ARCH-006] Migration complete. Legacy restaurantCreation* fields preserved for compatibility.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[ARCH-006] Migration failed:", err);
  process.exit(1);
});
