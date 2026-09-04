/**
 * Read-only Phase 2A Simple Stock migration audit.
 *
 * Usage:
 *   npm run audit:simple-stock -- --business-id <businessId>
 *
 * This script has no mutation mode and never creates mappings, inventory
 * records, movements, or MenuItem updates.
 */
import mongoose from "mongoose"
import dotenv from "dotenv"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { readSimpleStockMigrationDryRun } from "../src/services/simpleStockMigrationService.js"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(scriptDirectory, "../.env") })

function readBusinessId(argv) {
    const equalsArgument = argv.find((argument) => argument.startsWith("--business-id="))
    if (equalsArgument) return equalsArgument.slice("--business-id=".length).trim()
    const index = argv.indexOf("--business-id")
    return index >= 0 ? String(argv[index + 1] || "").trim() : ""
}

const businessId = readBusinessId(process.argv.slice(2))
if (!businessId) {
    console.error("Usage: npm run audit:simple-stock -- --business-id <businessId>")
    process.exitCode = 1
} else {
    const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/quickserve"
    try {
        await mongoose.connect(uri)
        const report = await readSimpleStockMigrationDryRun({ businessId })
        console.log(JSON.stringify(report, null, 2))
    } catch (error) {
        console.error("Simple Stock migration dry-run failed:", error)
        process.exitCode = 1
    } finally {
        await mongoose.disconnect()
    }
}

