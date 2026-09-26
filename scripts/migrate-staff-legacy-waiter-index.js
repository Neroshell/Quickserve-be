/**
 * Intentional ARCH-005 migration for the obsolete unique
 * { businessId: 1, waiterId: 1 } index on the canonical staff collection.
 * This script is never imported by API or worker startup.
 */
import {
    hasCliFlag,
    runCollectionCli,
    withMongoCollectionStore,
} from "./lib/collection-migration-cli.js"
import {
    createMongoStaffLegacyWaiterIndexStore,
    migrateStaffLegacyWaiterIndex,
} from "./lib/staff-legacy-waiter-index-migration.js"

await runCollectionCli(async () => {
    await withMongoCollectionStore(
        (store) => migrateStaffLegacyWaiterIndex({
            store,
            dryRun: hasCliFlag("--dry-run"),
            confirmDrop: hasCliFlag("--confirm-drop"),
            confirmProduction: hasCliFlag("--confirm-production"),
            env: process.env,
            logger: console,
        }),
        { createStore: createMongoStaffLegacyWaiterIndexStore },
    )
})
