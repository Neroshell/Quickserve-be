/**
 * One-time, sandbox-only repair for missing Business.discoveryGeoPoint values.
 *
 * Default: read-only dry run
 *   npm run repair:discovery-geo-points
 *
 * Apply is intentionally guarded and must be separately approved. It requires:
 * - NODE_ENV other than production
 * - CHILLOW_GEO_REPAIR_ALLOW_APPLY=1
 * - --apply --confirm-sandbox --expected-db <database-name>
 * - --backup <new-file-path>
 */
import "dotenv/config"
import mongoose from "mongoose"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import {
    classifyDiscoveryGeoPoint,
    DISCOVERY_GEO_POINT_REPAIR_PIPELINE,
    repairCandidateFilter,
} from "./lib/discoveryGeoPointRepair.js"

function parseArguments(argv) {
    const options = {
        apply: false,
        confirmSandbox: false,
        expectedDatabase: null,
        backupPath: null,
    }
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === "--apply") options.apply = true
        else if (argument === "--confirm-sandbox") options.confirmSandbox = true
        else if (argument === "--expected-db" || argument === "--backup") {
            const value = argv[index + 1]
            if (!value || value.startsWith("--")) {
                throw new Error(`${argument} requires a value`)
            }
            if (argument === "--expected-db") options.expectedDatabase = value
            else options.backupPath = value
            index += 1
        } else if (argument === "--dry-run") {
            // Default mode. Accept it to make operator intent explicit.
        } else {
            throw new Error(`Unsupported argument: ${argument}`)
        }
    }
    return options
}

function publicRecord(business, classification) {
    return {
        businessId: business.businessId || String(business._id),
        name: business.displayName || business.name || "(unnamed)",
        country: business.countryCode || "",
        latitude: business.latitude ?? null,
        longitude: business.longitude ?? null,
        geoJsonStatus: classification.geoJsonStatus,
        proposedAction: classification.action,
        proposedGeoPoint: classification.expectedPoint,
    }
}

function summarize(classifications) {
    return {
        total: classifications.length,
        alreadyCorrect: classifications.filter(({ classification }) => classification.geoJsonStatus === "valid").length,
        repairCandidates: classifications.filter(({ classification }) => classification.action === "repair_candidate").length,
        manualReview: classifications.filter(({ classification }) => classification.action === "manual_review").length,
    }
}

function assertApplySafety(options, databaseName) {
    if (!options.apply) return
    if (process.env.NODE_ENV === "production") {
        throw new Error("Refusing to apply this repair when NODE_ENV is production")
    }
    if (process.env.CHILLOW_GEO_REPAIR_ALLOW_APPLY !== "1") {
        throw new Error("Apply requires CHILLOW_GEO_REPAIR_ALLOW_APPLY=1")
    }
    if (!options.confirmSandbox) {
        throw new Error("Apply requires --confirm-sandbox")
    }
    if (!options.expectedDatabase || options.expectedDatabase !== databaseName) {
        throw new Error("Apply requires --expected-db matching the connected sandbox database")
    }
    if (/prod(?:uction)?/iu.test(databaseName)) {
        throw new Error("Refusing to apply to a database whose name appears to be production")
    }
    if (!options.backupPath) {
        throw new Error("Apply requires --backup <new-file-path>")
    }
}

const options = parseArguments(process.argv.slice(2))
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/quickserve"

try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 })
    const database = mongoose.connection.db
    const collection = database.collection("businesses")
    const documents = await collection.find({}).toArray()
    const classified = documents.map((business) => ({
        business,
        classification: classifyDiscoveryGeoPoint(business),
    }))
    const indexNames = (await collection.indexes()).map((index) => index.name)
    const report = {
        mode: options.apply ? "apply" : "dry-run",
        environment: process.env.NODE_ENV || "development_or_unset",
        database: database.databaseName,
        collection: collection.collectionName,
        hasDiscoveryGeoPointIndex: indexNames.includes("discoveryGeoPoint_2dsphere"),
        summary: summarize(classified),
        records: classified.map(({ business, classification }) => publicRecord(business, classification)),
    }

    if (!options.apply) {
        console.log(JSON.stringify(report, null, 2))
    } else {
        assertApplySafety(options, database.databaseName)
        const candidateIds = classified
            .filter(({ classification }) => classification.action === "repair_candidate")
            .map(({ business }) => business._id)
        const refreshedDocuments = await collection.find({ _id: { $in: candidateIds } }).toArray()
        const refreshedCandidates = refreshedDocuments.filter((business) => (
            classifyDiscoveryGeoPoint(business).action === "repair_candidate"
        ))
        const backupPath = resolve(process.cwd(), options.backupPath)
        await mkdir(dirname(backupPath), { recursive: true })
        await writeFile(backupPath, JSON.stringify({
            format: "chillow-discovery-geo-point-repair-backup-v1",
            createdAt: new Date().toISOString(),
            database: database.databaseName,
            collection: collection.collectionName,
            documents: refreshedCandidates,
        }, null, 2), { encoding: "utf8", flag: "wx" })

        let matchedCount = 0
        let modifiedCount = 0
        for (const business of refreshedCandidates) {
            const result = await collection.updateOne(
                repairCandidateFilter(business),
                DISCOVERY_GEO_POINT_REPAIR_PIPELINE,
            )
            matchedCount += result.matchedCount
            modifiedCount += result.modifiedCount
        }
        console.log(JSON.stringify({
            ...report,
            backupPath,
            revalidatedCandidateCount: refreshedCandidates.length,
            skippedDuringRevalidation: candidateIds.length - refreshedCandidates.length,
            matchedCount,
            modifiedCount,
        }, null, 2))
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : "Discovery GeoJSON repair failed")
    process.exitCode = 1
} finally {
    await mongoose.disconnect()
}
