import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"

import {
    classifyDiscoveryGeoPoint,
    DISCOVERY_GEO_POINT_REPAIR_PIPELINE,
    repairCandidateFilter,
} from "../scripts/lib/discoveryGeoPointRepair.js"

const mongoUri = process.env.INVENTORY_TEST_MONGODB_URI

test("GeoJSON repair pipeline writes each candidate's own coordinates and rejects a stale location snapshot", {
    skip: mongoUri ? false : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async () => {
    await mongoose.connect(mongoUri, { dbName: `quickserve_geo_repair_${Date.now()}` })
    try {
        const collection = mongoose.connection.db.collection("businesses")
        const candidate = {
            businessId: "candidate-business",
            addressPlaceId: "google-place-id",
            latitude: 35.9520048,
            longitude: 14.4178167,
        }
        const existing = await collection.insertOne(candidate)
        const storedCandidate = await collection.findOne({ _id: existing.insertedId })
        assert.equal(classifyDiscoveryGeoPoint(storedCandidate).action, "repair_candidate")

        const repair = await collection.updateOne(
            repairCandidateFilter(storedCandidate),
            DISCOVERY_GEO_POINT_REPAIR_PIPELINE,
        )
        assert.equal(repair.matchedCount, 1)
        assert.equal(repair.modifiedCount, 1)
        const repaired = await collection.findOne({ _id: existing.insertedId })
        assert.deepEqual(repaired.discoveryGeoPoint, {
            type: "Point",
            coordinates: [14.4178167, 35.9520048],
        })

        const concurrentSource = await collection.insertOne({
            businessId: "concurrently-moved-business",
            addressPlaceId: "google-place-id-two",
            latitude: 35.8934864,
            longitude: 14.4885396,
        })
        const beforeMove = await collection.findOne({ _id: concurrentSource.insertedId })
        await collection.updateOne(
            { _id: concurrentSource.insertedId },
            { $set: { longitude: 14.4999999 } },
        )
        const staleRepair = await collection.updateOne(
            repairCandidateFilter(beforeMove),
            DISCOVERY_GEO_POINT_REPAIR_PIPELINE,
        )
        assert.equal(staleRepair.matchedCount, 0)
        const moved = await collection.findOne({ _id: concurrentSource.insertedId })
        assert.equal(moved.discoveryGeoPoint, undefined)
    } finally {
        await mongoose.connection.dropDatabase()
        await mongoose.disconnect()
    }
})
