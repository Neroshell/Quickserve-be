/**
 * Backfill hotelRoomTypes for existing hotel businesses.
 *
 * Dry run (default):
 *   node scripts/backfill-hotel-room-types.js
 *
 * Apply changes:
 *   node scripts/backfill-hotel-room-types.js --apply
 */
import mongoose from "mongoose"
import dotenv from "dotenv"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

import Business from "../src/models/Business.js"
import { DEFAULT_HOTEL_ROOM_TYPES } from "../src/constants/hotelConstants.js"
import { normalizeRoomType } from "../src/models/ServicePoint.js"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(scriptDirectory, "../.env") })

const applyChanges = process.argv.includes("--apply")
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/quickserve"

export function buildBackfillRoomTypes(existingTypes = []) {
    const currentTypes = Array.isArray(existingTypes) ? existingTypes : []
    const merged = currentTypes.map(rt => ({
        name: rt.name,
        sortOrder: rt.sortOrder,
        active: rt.active,
        isDefault: rt.isDefault
    }))
    const existingByName = new Map(
        merged.map((rt, index) => [normalizeRoomType(rt.name)?.toLowerCase(), index])
    )
    let maxSortOrder = merged.reduce((max, rt) => Math.max(max, rt.sortOrder || 0), 0)

    for (const defaultType of DEFAULT_HOTEL_ROOM_TYPES) {
        const normalizedDefaultName = normalizeRoomType(defaultType.name).toLowerCase()
        const existingIndex = existingByName.get(normalizedDefaultName)

        if (existingIndex === undefined) {
            maxSortOrder += 1
            merged.push({
                name: defaultType.name,
                sortOrder: maxSortOrder,
                active: defaultType.active !== false,
                isDefault: true
            })
            existingByName.set(normalizedDefaultName, merged.length - 1)
        } else {
            merged[existingIndex] = {
                ...merged[existingIndex],
                active: true,
                isDefault: true
            }
        }
    }

    return merged
}

export async function runBackfill({ apply = false } = {}) {
    const hotelBusinesses = await Business.find({
        businessType: { $in: ["hotel", "hotel_apartment", "apartment"] }
    })

    const updates = []

    for (const biz of hotelBusinesses) {
        const mergedRoomTypes = buildBackfillRoomTypes(biz.hotelRoomTypes)
        
        const currentRoomTypes = (biz.hotelRoomTypes || []).map(rt => ({
            name: rt.name,
            sortOrder: rt.sortOrder,
            active: rt.active,
            isDefault: rt.isDefault
        }))
        const currentLength = currentRoomTypes.length
        if (JSON.stringify(mergedRoomTypes) !== JSON.stringify(currentRoomTypes)) {
            updates.push({
                businessObjectId: biz._id,
                businessId: biz.businessId,
                name: biz.name,
                previousCount: currentLength,
                newCount: mergedRoomTypes.length,
                hotelRoomTypes: mergedRoomTypes
            })
        }
    }

    if (apply && updates.length > 0) {
        await Business.bulkWrite(updates.map(u => ({
            updateOne: {
                filter: { _id: u.businessObjectId },
                update: { $set: { hotelRoomTypes: u.hotelRoomTypes } }
            }
        })))
    }

    return {
        mode: apply ? "apply" : "dry-run",
        affectedBusinesses: updates.length,
        updates: updates.map(({ businessId, name, previousCount, newCount }) => ({
            businessId,
            name,
            previousCount,
            newCount
        }))
    }
}

// Execute CLI script if run directly
if (process.argv[1] && process.argv[1].endsWith("backfill-hotel-room-types.js")) {
    try {
        await mongoose.connect(uri)
        const summary = await runBackfill({ apply: applyChanges })
        console.log(JSON.stringify(summary, null, 2))
    } catch (err) {
        console.error("Failed to backfill hotel room types:", err)
        process.exitCode = 1
    } finally {
        await mongoose.disconnect()
    }
}
