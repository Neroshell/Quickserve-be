/**
 * Preflight audit CLI for the obsolete unique
 * { businessId: 1, waiterId: 1 } index on the canonical staff collection.
 * This script is safe to run in any environment (inspection only).
 */
import {
    runCollectionCli,
    withMongoCollectionStore,
} from "./lib/collection-migration-cli.js"
import {
    createMongoStaffLegacyWaiterIndexStore,
    inspectStaffLegacyWaiterIndex,
} from "./lib/staff-legacy-waiter-index-migration.js"

await runCollectionCli(async () => {
    await withMongoCollectionStore(
        async (store) => {
            const inspection = await inspectStaffLegacyWaiterIndex({ store })
            if (inspection.legacyIndex) {
                console.log(`[AUDIT] Obsolete legacy index ${inspection.legacyIndex.name} IS PRESENT.`)
            } else {
                console.log("[AUDIT] Obsolete legacy index is NOT PRESENT.")
            }
            return inspection
        },
        { createStore: createMongoStaffLegacyWaiterIndexStore },
    )
})
