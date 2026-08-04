/**
 * Controlled rollback: businesses -> restaurants, staff -> waiters.
 *
 * This script changes collection names only. It never changes document fields
 * or indexes and is never imported by application startup.
 */
import {
    hasCliFlag,
    runCollectionCli,
    withMongoCollectionStore,
} from "./lib/collection-migration-cli.js"
import { rollbackCollectionNames } from "./lib/collection-name-migration.js"

await runCollectionCli(async () => {
    await withMongoCollectionStore((store) => rollbackCollectionNames({
        store,
        dryRun: hasCliFlag("--dry-run"),
        confirmRollback: hasCliFlag("--confirm-rollback"),
        confirmProduction: hasCliFlag("--confirm-production"),
        env: process.env,
        logger: console,
    }))
})
