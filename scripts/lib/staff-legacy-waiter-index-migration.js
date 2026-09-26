import { CollectionMigrationError } from "./collection-name-migration.js"

export const STAFF_COLLECTION = "staff"
export const LEGACY_WAITER_INDEX_NAME = "businessId_1_waiterId_1"
export const LEGACY_WAITER_INDEX_KEY = Object.freeze({
    businessId: 1,
    waiterId: 1,
})

export const CANONICAL_STAFF_INDEXES = Object.freeze([
    Object.freeze({
        label: "businessId + staffId",
        key: Object.freeze({ businessId: 1, staffId: 1 }),
        unique: true,
    }),
    Object.freeze({
        label: "businessId + email",
        key: Object.freeze({ businessId: 1, email: 1 }),
        unique: true,
    }),
])

function safeLogger(logger = console) {
    return {
        log: typeof logger.log === "function" ? logger.log.bind(logger) : () => {},
        warn: typeof logger.warn === "function" ? logger.warn.bind(logger) : () => {},
    }
}

function fail(code, message) {
    throw new CollectionMigrationError(code, message)
}

export function hasExactIndexKey(index, expectedKey) {
    const actual = Object.entries(index?.key || {})
    const expected = Object.entries(expectedKey)
    return actual.length === expected.length && actual.every(
        ([field, direction], position) => (
            field === expected[position][0] && direction === expected[position][1]
        ),
    )
}

function verifyCanonicalIndexes(indexes) {
    const verified = []
    for (const expected of CANONICAL_STAFF_INDEXES) {
        const match = indexes.find((index) => (
            hasExactIndexKey(index, expected.key) && index.unique === expected.unique
        ))
        if (!match) {
            fail(
                "CANONICAL_STAFF_INDEX_MISSING",
                `Staff is missing the required unique index ${expected.label}. No index was removed.`,
            )
        }
        verified.push({ label: expected.label, name: String(match.name) })
    }
    return verified
}

function findLegacyWaiterIndex(indexes) {
    const expectedNameIndex = indexes.find(
        (index) => String(index?.name || "") === LEGACY_WAITER_INDEX_NAME,
    )
    if (expectedNameIndex && !hasExactIndexKey(expectedNameIndex, LEGACY_WAITER_INDEX_KEY)) {
        fail(
            "LEGACY_INDEX_NAME_CONFLICT",
            `Index ${LEGACY_WAITER_INDEX_NAME} exists but does not have the expected businessId + waiterId key. No index was removed.`,
        )
    }

    const matches = indexes.filter(
        (index) => hasExactIndexKey(index, LEGACY_WAITER_INDEX_KEY),
    )
    if (matches.length > 1) {
        fail(
            "MULTIPLE_LEGACY_WAITER_INDEXES",
            "More than one businessId + waiterId index exists on staff. No index was removed.",
        )
    }

    const candidate = matches[0] || null
    if (candidate && candidate.unique !== true) {
        fail(
            "LEGACY_INDEX_DEFINITION_UNEXPECTED",
            `Index ${String(candidate.name)} matches businessId + waiterId but is not unique. No index was removed.`,
        )
    }
    return candidate
}

export async function inspectStaffLegacyWaiterIndex({ store }) {
    try {
        const exists = await store.collectionExists(STAFF_COLLECTION)
        if (!exists) {
            return {
                collection: STAFF_COLLECTION,
                collectionExists: false,
                legacyIndex: null,
                waiterIdDocumentCount: 0,
                canonicalIndexes: [],
            }
        }

        const indexes = await store.listIndexes(STAFF_COLLECTION)
        return {
            collection: STAFF_COLLECTION,
            collectionExists: true,
            legacyIndex: findLegacyWaiterIndex(indexes),
            waiterIdDocumentCount: await store.countDocumentsWithField(
                STAFF_COLLECTION,
                "waiterId",
            ),
            canonicalIndexes: verifyCanonicalIndexes(indexes),
        }
    } catch (error) {
        if (error instanceof CollectionMigrationError) throw error
        fail(
            "STAFF_INDEX_INSPECTION_FAILED",
            "Unable to inspect Staff indexes. No index was removed.",
        )
    }
}

function printInspection(output, inspection) {
    output.log(`Collection inspected: ${inspection.collection}`)
    output.log("Staff legacy waiter index:")
    output.log(inspection.legacyIndex ? "FOUND" : "NOT PRESENT")
    if (inspection.legacyIndex) {
        output.log(`Index: ${String(inspection.legacyIndex.name)}`)
        output.log("Key: businessId:1, waiterId:1")
        output.log("Unique: true")
    }
    output.log(`Documents containing waiterId: ${inspection.waiterIdDocumentCount}`)
    output.log(
        inspection.collectionExists
            ? `Canonical Staff indexes: VERIFIED (${inspection.canonicalIndexes.map(({ name }) => name).join(", ")})`
            : "Canonical Staff indexes: NOT APPLICABLE (staff collection does not exist)",
    )
}

function assertConfirmation({ confirmDrop, confirmProduction, env }) {
    if (!confirmDrop) {
        fail(
            "CONFIRMATION_REQUIRED",
            "Legacy waiter index removal requires --confirm-drop. No index was removed.",
        )
    }
    if (env.NODE_ENV === "production" && !confirmProduction) {
        fail(
            "PRODUCTION_CONFIRMATION_REQUIRED",
            "Production index removal requires --confirm-production. No index was removed.",
        )
    }
}

export async function migrateStaffLegacyWaiterIndex({
    store,
    dryRun = false,
    confirmDrop = false,
    confirmProduction = false,
    env = process.env,
    logger = console,
}) {
    const output = safeLogger(logger)
    const initial = await inspectStaffLegacyWaiterIndex({ store })
    printInspection(output, initial)

    if (!initial.legacyIndex) {
        if (initial.waiterIdDocumentCount > 0) {
            output.warn(
                `Legacy waiterId fields remain in ${initial.waiterIdDocumentCount} Staff documents. They were not changed because no legacy index removal is required.`,
            )
        }
        output.log("Action: NO CHANGE")
        return { status: "not_present", inspection: initial }
    }

    if (initial.waiterIdDocumentCount > 0) {
        fail(
            "LEGACY_WAITER_DATA_PRESENT",
            `Legacy waiterId fields remain in ${initial.waiterIdDocumentCount} Staff documents. No index was removed.`,
        )
    }

    if (dryRun) {
        output.log("Action: WOULD REMOVE")
        return { status: "dry_run", inspection: initial }
    }

    assertConfirmation({ confirmDrop, confirmProduction, env })

    const immediate = await inspectStaffLegacyWaiterIndex({ store })
    if (
        !immediate.legacyIndex ||
        String(immediate.legacyIndex.name) !== String(initial.legacyIndex.name)
    ) {
        fail(
            "LEGACY_INDEX_STATE_CHANGED",
            "The legacy Staff index changed after preflight. No index was removed; stop writers and retry.",
        )
    }
    if (immediate.waiterIdDocumentCount > 0) {
        fail(
            "LEGACY_WAITER_DATA_PRESENT",
            `Legacy waiterId fields appeared after preflight in ${immediate.waiterIdDocumentCount} Staff documents. No index was removed.`,
        )
    }

    const indexName = String(immediate.legacyIndex.name || "")
    if (!indexName) {
        fail(
            "LEGACY_INDEX_NAME_MISSING",
            "The exact legacy Staff index name could not be determined. No index was removed.",
        )
    }

    output.log(`Action: REMOVING ${indexName}`)
    try {
        await store.dropIndex(STAFF_COLLECTION, indexName)
    } catch {
        fail(
            "LEGACY_INDEX_DROP_FAILED",
            `Failed to remove Staff index ${indexName}. Verify database state before retrying.`,
        )
    }

    const after = await inspectStaffLegacyWaiterIndex({ store })
    if (after.legacyIndex) {
        fail(
            "LEGACY_INDEX_STILL_PRESENT",
            "The businessId + waiterId index is still present after removal was requested.",
        )
    }

    output.log("Action: REMOVED")
    output.log(
        `Canonical Staff indexes after removal: VERIFIED (${after.canonicalIndexes.map(({ name }) => name).join(", ")})`,
    )
    return {
        status: "removed",
        removedIndexName: indexName,
        before: immediate,
        after,
    }
}

export function createMongoStaffLegacyWaiterIndexStore(database) {
    if (!database) {
        throw new TypeError("A MongoDB database handle is required")
    }

    return {
        async collectionExists(name) {
            return Boolean(await database
                .listCollections({ name }, { nameOnly: true })
                .hasNext())
        },

        async listIndexes(name) {
            return database.collection(name).indexes()
        },

        async countDocumentsWithField(name, field) {
            return database.collection(name).countDocuments({
                [field]: { $exists: true },
            })
        },

        async dropIndex(name, indexName) {
            return database.collection(name).dropIndex(indexName)
        },
    }
}
