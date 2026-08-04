/**
 * Controlled collection rename: restaurants -> businesses, waiters -> staff.
 *
 * This script is never imported by application startup. See
 * docs/COLLECTION_NAME_MIGRATION.md before applying it.
 */
import {
    hasCliFlag,
    runCollectionCli,
    withMongoCollectionStore,
} from "./lib/collection-migration-cli.js"
import { migrateCollectionNames } from "./lib/collection-name-migration.js"

await runCollectionCli(async () => {
    await withMongoCollectionStore((store) => migrateCollectionNames({
        store,
        dryRun: hasCliFlag("--dry-run"),
        confirmRename: hasCliFlag("--confirm-rename"),
        confirmProduction: hasCliFlag("--confirm-production"),
        env: process.env,
        logger: console,
    }))
})
