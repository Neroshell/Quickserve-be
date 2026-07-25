/**
 * Backfill the canonical Business.modules array for legacy businesses.
 *
 * Dry run (default):
 *   npm run modules:backfill
 *
 * Apply after reviewing the dry-run summary:
 *   npm run modules:backfill -- --apply
 */
import mongoose from "mongoose"
import dotenv from "dotenv"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

import Business from "../src/models/Business.js"
import { getDefaultBusinessModules } from "../src/services/businessCapabilityService.js"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(scriptDirectory, "../.env") })

const applyChanges = process.argv.includes("--apply")
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/quickserve"

try {
    await mongoose.connect(uri)

    const businesses = await Business.find({
        $or: [
            { modules: { $exists: false } },
            { modules: null },
            { modules: { $size: 0 } },
        ],
    }).select("_id businessId businessType").lean()

    const plannedUpdates = businesses.map((business) => ({
        businessObjectId: business._id,
        businessId: business.businessId,
        businessType: business.businessType || "restaurant",
        modules: getDefaultBusinessModules(business.businessType),
    }))

    if (applyChanges && plannedUpdates.length > 0) {
        await Business.bulkWrite(plannedUpdates.map((update) => ({
            updateOne: {
                filter: { _id: update.businessObjectId },
                update: { $set: { modules: update.modules } },
            },
        })))
    }

    console.log(JSON.stringify({
        mode: applyChanges ? "apply" : "dry-run",
        businessCount: plannedUpdates.length,
        updates: plannedUpdates.map(({ businessId, businessType, modules }) => ({ businessId, businessType, modules })),
    }, null, 2))
} catch (err) {
    console.error("Failed to backfill business modules:", err)
    process.exitCode = 1
} finally {
    await mongoose.disconnect()
}
