/**
 * Read-only audit for globally duplicated authenticated QuickServe emails.
 *
 * Run with:
 *   npm run audit:account-emails
 *
 * The script reports duplicates across owners, staff/co-owners, pending owner
 * email changes, and pending onboarding sessions. It never modifies data.
 */
import mongoose from "mongoose"
import dotenv from "dotenv"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

import { findDuplicateAccountEmails } from "../src/utils/emailAvailability.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, "../.env") })

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/quickserve"

try {
    await mongoose.connect(uri)
    const duplicates = await findDuplicateAccountEmails()

    const summary = {
        success: duplicates.length === 0,
        duplicateEmailCount: duplicates.length,
        duplicateRecordCount: duplicates.reduce((total, item) => total + item.count, 0),
        duplicates
    }

    console.log(JSON.stringify(summary, null, 2))

    if (duplicates.length > 0) {
        process.exitCode = 1
    }
} catch (err) {
    console.error("Failed to audit account email duplicates:", err)
    process.exitCode = 1
} finally {
    await mongoose.disconnect()
}
