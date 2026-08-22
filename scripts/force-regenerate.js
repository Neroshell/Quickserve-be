/**
 * Development Utility Script: Force Regenerate Weekly AI Analyst Report
 *
 * Rebuilds the analytics snapshot for a specified business and period,
 * then triggers the canonical V5 generation pipeline.
 *
 * Usage (Development/Local Debugging):
 *   node --env-file=.env scripts/force-regenerate.js [businessId] [periodKey]
 */

import { generateAnalystReportForPeriod } from "../src/services/ai/weeklyAnalystGenerationService.js"
import { generateWeeklySnapshot } from "../src/services/analytics/weeklyAnalystSnapshotService.js"
import mongoose from "mongoose"

async function run() {
    const businessId = process.argv[2] || "rest_4abbb2a88d3d7b"
    const periodKey = process.argv[3] || "2026-W33"

    console.log(`[force-regenerate] Connecting to database...`)
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/quickserve")
    
    console.log(`[force-regenerate] Rebuilding snapshot for ${businessId} / ${periodKey}...`)
    const snapshot = await generateWeeklySnapshot({ businessId, periodKey })
    
    const db = mongoose.connection.db
    await db.collection("weeklyanalystreports").updateOne(
        { businessId, periodKey },
        { 
            $set: { 
                analyticsSnapshot: snapshot,
                generationStatus: "snapshot_ready", 
                generatedReport: null 
            } 
        }
    )

    console.log(`[force-regenerate] Executing canonical V5 report generation...`)
    try {
        const report = await generateAnalystReportForPeriod({ businessId, periodKey })
        console.log(`[force-regenerate] Success!`)
        console.log(`  Headline: "${report.generatedReport.headline}"`)
        console.log(`  Report Version: ${report.reportVersion}`)
        console.log(`  Model Version: ${report.modelVersion}`)
    } catch (e) {
        console.error("[force-regenerate] Error during generation:", e.message)
        const doc = await db.collection("weeklyanalystreports").findOne({ businessId, periodKey })
        console.log("[force-regenerate] Failure state:", doc?.failureReason)
    }
    process.exit(0)
}

run().catch(err => {
    console.error("[force-regenerate] Fatal error:", err)
    process.exit(1)
})
