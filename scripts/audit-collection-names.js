/**
 * Read-only collection-name audit. Prints counts, validation totals, and index
 * metadata only; it never reads or prints document values.
 */
import {
    runCollectionCli,
    withMongoCollectionStore,
} from "./lib/collection-migration-cli.js"
import { auditCollectionMigration } from "./lib/collection-name-migration.js"

await runCollectionCli(async () => {
    await withMongoCollectionStore((store) => auditCollectionMigration({
        store,
        logger: console,
    }))
})
