/**
 * DEPRECATED AND INTENTIONALLY DISABLED.
 *
 * A mechanical rename corrupted this historical field migration. Do not run
 * it. Use `npm run audit:collections` for the safe read-only replacement.
 */
throw new Error("Deprecated migration disabled. Run npm run audit:collections instead.")

/**
 * migrate-businessId-to-businessId.js
 *
 * One-time migration script to rename the `businessId` field to `businessId`
 * across all relevant MongoDB collections.
 *
 * Safe to run multiple times — skips documents that already have `businessId`.
 *
 * Usage:
 *   node scripts/migrate-businessId-to-businessId.js
 *
 * Requires MONGODB_URI in environment (or .env file).
 */

import "dotenv/config"
import mongoose from "mongoose"

const MONGO_URI = process.env.MONGODB_URI

if (!MONGO_URI) {
    console.error("❌ MONGODB_URI environment variable is not set.")
    process.exit(1)
}

const COLLECTIONS = [
    "restaurants",   // Restaurant model
    "waiters",       // Staff model (stored in "waiters" collection)
    "orders",        // Order model
    "tablesessions", // GuestSession model
    "waitercalls",   // ServiceRequest model
    "menuitems",     // MenuItem model
    "pendingcheckouts" // PendingCheckout model
]

async function migrateCollection(db, collectionName) {
    const collection = db.collection(collectionName)

    // Count documents that still only have businessId (no businessId yet)
    const pending = await collection.countDocuments({
        businessId: { $exists: true },
        businessId: { $exists: false }
    })

    if (pending === 0) {
        console.log(`  ✅ ${collectionName}: already migrated (no pending docs)`)
        return { migrated: 0, skipped: 0 }
    }

    console.log(`  🔄 ${collectionName}: ${pending} document(s) to migrate...`)

    // Rename businessId → businessId for all docs where businessId doesn't exist yet
    const result = await collection.updateMany(
        {
            businessId: { $exists: true },
            businessId: { $exists: false }
        },
        [
            {
                $set: {
                    businessId: "$businessId"
                }
            }
        ]
    )

    console.log(`  ✅ ${collectionName}: migrated ${result.modifiedCount} document(s)`)
    return { migrated: result.modifiedCount, skipped: pending - result.modifiedCount }
}

async function run() {
    console.log("\n🚀 QuickServe Migration: businessId → businessId\n")
    console.log(`Connecting to MongoDB...`)

    await mongoose.connect(MONGO_URI)
    const db = mongoose.connection.db
    console.log(`Connected to database: ${db.databaseName}\n`)

    let totalMigrated = 0

    for (const col of COLLECTIONS) {
        try {
            const { migrated } = await migrateCollection(db, col)
            totalMigrated += migrated
        } catch (err) {
            console.error(`  ❌ Error migrating collection "${col}":`, err.message)
        }
    }

    console.log(`\n✅ Migration complete. Total documents updated: ${totalMigrated}`)
    console.log("ℹ️  The legacy businessId field has been kept in all documents for backward compatibility.")
    console.log("ℹ️  You may remove it later by running a follow-up script once all code has been deployed.\n")

    await mongoose.disconnect()
    process.exit(0)
}

run().catch((err) => {
    console.error("❌ Migration failed:", err)
    process.exit(1)
})
