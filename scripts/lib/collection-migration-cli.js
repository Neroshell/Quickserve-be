import "dotenv/config"
import mongoose from "mongoose"

import {
    CollectionMigrationError,
    createMongoCollectionMigrationStore,
} from "./collection-name-migration.js"

const MONGODB_URI_PATTERN = /mongodb(?:\+srv)?:\/\/[^\s]+/gi
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

export function hasCliFlag(flag, argv = process.argv.slice(2)) {
    return argv.includes(flag)
}

export function formatSafeCliError(error) {
    const code = typeof error?.code === "string" || typeof error?.code === "number"
        ? String(error.code)
        : "COLLECTION_MIGRATION_FAILED"
    const rawMessage = error instanceof CollectionMigrationError
        ? error.message
        : "The database operation failed. Inspect database logs without sharing credentials or document contents."
    const message = String(rawMessage)
        .replace(MONGODB_URI_PATTERN, "[redacted MongoDB URI]")
        .replace(EMAIL_PATTERN, "[redacted email]")
    return `[${code}] ${message}`
}

export async function withMongoCollectionStore(task, { env = process.env } = {}) {
    if (!env.MONGODB_URI) {
        throw new CollectionMigrationError(
            "MONGODB_URI_MISSING",
            "MONGODB_URI is not configured. No database connection was attempted.",
        )
    }

    try {
        await mongoose.connect(env.MONGODB_URI)
    } catch {
        throw new CollectionMigrationError(
            "DATABASE_CONNECTION_FAILED",
            "Unable to connect to MongoDB using the configured MONGODB_URI. No connection details were printed.",
        )
    }

    try {
        const store = createMongoCollectionMigrationStore(mongoose.connection.db)
        return await task(store)
    } finally {
        await mongoose.disconnect()
    }
}

export async function runCollectionCli(task) {
    try {
        await task()
    } catch (error) {
        console.error(formatSafeCliError(error))
        process.exitCode = 1
    }
}
