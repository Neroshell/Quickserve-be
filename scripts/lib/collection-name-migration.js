const COLLECTIONS = Object.freeze({
    LEGACY_BUSINESS: "restaurants",
    BUSINESS: "businesses",
    LEGACY_STAFF: "waiters",
    STAFF: "staff",
})

const BUSINESS_REQUIREMENTS = Object.freeze({
    requiredFields: ["businessId"],
    duplicateKeys: {
        businessId: ["businessId"],
    },
    expectedIndexes: [
        { fields: ["businessId"], unique: true },
    ],
})

const STAFF_REQUIREMENTS = Object.freeze({
    requiredFields: ["businessId", "staffId", "email"],
    duplicateKeys: {
        businessIdStaffId: ["businessId", "staffId"],
        businessIdEmail: ["businessId", "email"],
    },
    expectedIndexes: [
        { fields: ["businessId", "staffId"], unique: true },
        { fields: ["businessId", "email"], unique: true },
    ],
})

export class CollectionMigrationError extends Error {
    constructor(code, message) {
        super(message)
        this.name = "CollectionMigrationError"
        this.code = code
    }
}

function safeLogger(logger = console) {
    return {
        log: typeof logger.log === "function" ? logger.log.bind(logger) : () => {},
        warn: typeof logger.warn === "function" ? logger.warn.bind(logger) : () => {},
    }
}

function normalizeIndex(index) {
    return {
        name: String(index?.name || "unnamed"),
        fields: Object.entries(index?.key || {}).map(([field, direction]) => ({
            field,
            direction,
        })),
        unique: Boolean(index?.unique),
        sparse: Boolean(index?.sparse),
    }
}

function indexHasFields(index, expectedFields) {
    const actualFields = index.fields.map(({ field }) => field)
    return actualFields.length === expectedFields.length
        && actualFields.every((field, indexPosition) => field === expectedFields[indexPosition])
}

function findMissingIndexes(collection, requirements) {
    return requirements.expectedIndexes.filter((expected) => !collection.indexes.some((index) => (
        indexHasFields(index, expected.fields)
        && index.unique === expected.unique
    )))
}

function collectionSummary(collection) {
    return {
        exists: collection.exists,
        count: collection.count,
        invalidRequiredFields: collection.invalidRequiredFields,
        duplicateGroups: Object.fromEntries(
            Object.entries(collection.duplicateChecks).map(([name, result]) => [
                name,
                {
                    groups: result.groups,
                    excessDocuments: result.excessDocuments,
                },
            ]),
        ),
        indexes: collection.indexes,
    }
}

function snapshotSummary(snapshot, state) {
    return {
        state,
        collections: {
            [COLLECTIONS.LEGACY_BUSINESS]: collectionSummary(snapshot.restaurants),
            [COLLECTIONS.BUSINESS]: collectionSummary(snapshot.businesses),
            [COLLECTIONS.LEGACY_STAFF]: collectionSummary(snapshot.waiters),
            [COLLECTIONS.STAFF]: collectionSummary(snapshot.staff),
        },
    }
}

function assertRequiredData(collection, requirements, label, { requireDocuments = false } = {}) {
    if (!collection.exists) {
        throw new CollectionMigrationError(
            "SOURCE_COLLECTION_MISSING",
            `${label} collection does not exist. No changes were made.`,
        )
    }

    if (requireDocuments && collection.count === 0) {
        throw new CollectionMigrationError(
            "SOURCE_COLLECTION_EMPTY",
            `${label} collection is unexpectedly empty. No changes were made.`,
        )
    }

    const invalidFields = Object.entries(collection.invalidRequiredFields)
        .filter(([, count]) => count > 0)
        .map(([field]) => field)

    if (invalidFields.length > 0) {
        throw new CollectionMigrationError(
            "REQUIRED_IDENTIFIERS_MISSING",
            `${label} contains records with missing or invalid required fields: ${invalidFields.join(", ")}. No changes were made.`,
        )
    }

    const duplicateChecks = Object.entries(collection.duplicateChecks)
        .filter(([, result]) => result.groups > 0)
        .map(([name]) => name)

    if (duplicateChecks.length > 0) {
        throw new CollectionMigrationError(
            "DUPLICATE_IDENTIFIERS",
            `${label} contains duplicate unique-key groups: ${duplicateChecks.join(", ")}. No changes were made.`,
        )
    }

    const missingIndexes = findMissingIndexes(collection, requirements)
    if (missingIndexes.length > 0) {
        const descriptions = missingIndexes.map(({ fields }) => fields.join(" + "))
        throw new CollectionMigrationError(
            "EXPECTED_INDEX_MISSING",
            `${label} is missing required unique indexes: ${descriptions.join(", ")}. No changes were made.`,
        )
    }
}

function assertLegacyPreflight(snapshot) {
    if (!snapshot.restaurants.exists) {
        throw new CollectionMigrationError(
            "SOURCE_COLLECTION_MISSING",
            "restaurants does not exist and the database is not in a complete migrated state. No changes were made.",
        )
    }
    if (snapshot.restaurants.count === 0) {
        throw new CollectionMigrationError(
            "SOURCE_COLLECTION_EMPTY",
            "restaurants is unexpectedly empty. No changes were made.",
        )
    }
    if (snapshot.businesses.count > 0) {
        throw new CollectionMigrationError(
            "TARGET_NOT_EMPTY",
            "businesses contains documents. Refusing to replace or merge it.",
        )
    }
    if (!snapshot.waiters.exists) {
        throw new CollectionMigrationError(
            "SOURCE_COLLECTION_MISSING",
            "waiters does not exist. No changes were made.",
        )
    }
    if (snapshot.staff.count > 0) {
        throw new CollectionMigrationError(
            "TARGET_NOT_EMPTY",
            "staff contains documents. Refusing to replace or merge it.",
        )
    }

    assertRequiredData(snapshot.restaurants, BUSINESS_REQUIREMENTS, "restaurants", {
        requireDocuments: true,
    })
    assertRequiredData(snapshot.waiters, STAFF_REQUIREMENTS, "waiters")
}

function assertMigratedState(snapshot) {
    if (snapshot.restaurants.count > 0 || snapshot.waiters.count > 0) {
        throw new CollectionMigrationError(
            "LEGACY_COLLECTION_CONFLICT",
            "Legacy collections contain documents alongside migrated collections.",
        )
    }

    assertRequiredData(snapshot.businesses, BUSINESS_REQUIREMENTS, "businesses", {
        requireDocuments: true,
    })
    assertRequiredData(snapshot.staff, STAFF_REQUIREMENTS, "staff")
}

function detectState(snapshot) {
    const legacyBusinessHasData = snapshot.restaurants.count > 0
    const targetBusinessHasData = snapshot.businesses.count > 0
    const legacyStaffHasData = snapshot.waiters.count > 0
    const targetStaffHasData = snapshot.staff.count > 0

    const looksMigrated = targetBusinessHasData
        && snapshot.staff.exists
        && !legacyBusinessHasData
        && !legacyStaffHasData

    if (looksMigrated) return "migrated"

    const looksLegacy = legacyBusinessHasData
        && snapshot.waiters.exists
        && !targetBusinessHasData
        && !targetStaffHasData

    if (looksLegacy) return "legacy"
    return "conflict"
}

async function inspectCollection(store, name, requirements) {
    const exists = await store.collectionExists(name)
    if (!exists) {
        return {
            name,
            exists: false,
            count: 0,
            invalidRequiredFields: Object.fromEntries(
                requirements.requiredFields.map((field) => [field, 0]),
            ),
            duplicateChecks: Object.fromEntries(
                Object.keys(requirements.duplicateKeys).map((key) => [key, {
                    groups: 0,
                    excessDocuments: 0,
                }]),
            ),
            indexes: [],
        }
    }

    const count = await store.countDocuments(name)
    const invalidEntries = await Promise.all(requirements.requiredFields.map(async (field) => [
        field,
        await store.countInvalidField(name, field),
    ]))
    const duplicateEntries = await Promise.all(
        Object.entries(requirements.duplicateKeys).map(async ([key, fields]) => [
            key,
            await store.countDuplicateGroups(name, fields),
        ]),
    )
    const indexes = (await store.listIndexes(name)).map(normalizeIndex)

    return {
        name,
        exists: true,
        count,
        invalidRequiredFields: Object.fromEntries(invalidEntries),
        duplicateChecks: Object.fromEntries(duplicateEntries),
        indexes,
    }
}

export async function inspectCollectionMigrationState(store) {
    const [restaurants, businesses, waiters, staff] = await Promise.all([
        inspectCollection(store, COLLECTIONS.LEGACY_BUSINESS, BUSINESS_REQUIREMENTS),
        inspectCollection(store, COLLECTIONS.BUSINESS, BUSINESS_REQUIREMENTS),
        inspectCollection(store, COLLECTIONS.LEGACY_STAFF, STAFF_REQUIREMENTS),
        inspectCollection(store, COLLECTIONS.STAFF, STAFF_REQUIREMENTS),
    ])

    return { restaurants, businesses, waiters, staff }
}

function forwardOperations(snapshot) {
    const operations = []
    if (snapshot.businesses.exists) {
        operations.push("drop empty target collection businesses")
    }
    if (snapshot.staff.exists) {
        operations.push("drop empty target collection staff")
    }
    operations.push("rename restaurants to businesses")
    operations.push("rename waiters to staff")
    operations.push("verify counts, required identifiers, and preserved unique indexes")
    return operations
}

function rollbackOperations(snapshot) {
    const operations = []
    if (snapshot.restaurants.exists) {
        operations.push("drop empty rollback target collection restaurants")
    }
    if (snapshot.waiters.exists) {
        operations.push("drop empty rollback target collection waiters")
    }
    operations.push("rename businesses to restaurants")
    operations.push("rename staff to waiters")
    operations.push("verify counts, required identifiers, and preserved unique indexes")
    return operations
}

function printInspection(logger, snapshot, state) {
    logger.log("Safe collection audit (counts and index metadata only):")
    logger.log(JSON.stringify(snapshotSummary(snapshot, state), null, 2))
}

function printOperations(logger, operations) {
    logger.log("Proposed operations:")
    operations.forEach((operation, index) => logger.log(`  ${index + 1}. ${operation}`))
    logger.log("No legacy fields or indexes will be removed by this migration.")
}

function printMaintenanceWarning(logger) {
    logger.warn("WARNING: Stop every API, BullMQ worker, and external cron process before applying a collection rename.")
    logger.warn("Do not restart any process until post-migration verification succeeds and the matching model-binding release is deployed.")
}

function assertConfirmation({
    action,
    confirmed,
    productionConfirmed,
    env,
}) {
    if (!confirmed) {
        throw new CollectionMigrationError(
            "CONFIRMATION_REQUIRED",
            `No changes were made. Re-run with --confirm-${action}.`,
        )
    }
    if (env.NODE_ENV === "production" && !productionConfirmed) {
        throw new CollectionMigrationError(
            "PRODUCTION_CONFIRMATION_REQUIRED",
            "NODE_ENV is production. No changes were made. Re-run with --confirm-production after verifying the maintenance window and backup.",
        )
    }
}

function countsChanged(before, after, names) {
    return names.some((name) => before[name].count !== after[name].count)
}

async function dropEmptyTargetIfPresent(store, collection) {
    if (!await store.collectionExists(collection)) return
    const count = await store.countDocuments(collection)
    if (count > 0) {
        throw new CollectionMigrationError(
            "TARGET_CHANGED",
            `${collection} received documents after preflight. No further changes were made.`,
        )
    }
    await store.dropEmptyCollection(collection)
}

function assertCountsMatch(actual, expected, label) {
    if (actual !== expected) {
        throw new CollectionMigrationError(
            "COUNT_MISMATCH",
            `${label} count verification failed: expected ${expected}, found ${actual}.`,
        )
    }
}

export async function auditCollectionMigration({ store, logger = console } = {}) {
    const output = safeLogger(logger)
    const snapshot = await inspectCollectionMigrationState(store)
    const state = detectState(snapshot)
    printInspection(output, snapshot, state)

    if (state === "legacy") {
        assertLegacyPreflight(snapshot)
    } else if (state === "migrated") {
        assertMigratedState(snapshot)
    } else {
        assertLegacyPreflight(snapshot)
    }

    output.log(`Collection audit passed. Detected state: ${state}.`)
    return { state, snapshot }
}

export async function migrateCollectionNames({
    store,
    dryRun = false,
    confirmRename = false,
    confirmProduction = false,
    env = process.env,
    logger = console,
} = {}) {
    const output = safeLogger(logger)
    printMaintenanceWarning(output)

    const initial = await inspectCollectionMigrationState(store)
    const initialState = detectState(initial)
    printInspection(output, initial, initialState)

    if (initialState === "migrated") {
        assertMigratedState(initial)
        output.log("Collections are already migrated and valid. No changes are required.")
        return { status: "already_migrated", snapshot: initial, operations: [] }
    }

    assertLegacyPreflight(initial)
    const operations = forwardOperations(initial)
    printOperations(output, operations)

    if (dryRun) {
        output.log("Dry-run complete. No database changes were made.")
        return { status: "dry_run", snapshot: initial, operations }
    }

    assertConfirmation({
        action: "rename",
        confirmed: confirmRename,
        productionConfirmed: confirmProduction,
        env,
    })

    const immediate = await inspectCollectionMigrationState(store)
    assertLegacyPreflight(immediate)
    if (countsChanged(initial, immediate, ["restaurants", "businesses", "waiters", "staff"])) {
        throw new CollectionMigrationError(
            "PREFLIGHT_STATE_CHANGED",
            "Collection counts changed after preflight. No changes were made; stop all writers and retry.",
        )
    }

    const originalBusinessCount = immediate.restaurants.count
    const originalStaffCount = immediate.waiters.count

    await dropEmptyTargetIfPresent(store, COLLECTIONS.BUSINESS)
    await dropEmptyTargetIfPresent(store, COLLECTIONS.STAFF)

    try {
        await store.renameCollection(COLLECTIONS.LEGACY_BUSINESS, COLLECTIONS.BUSINESS)
    } catch {
        throw new CollectionMigrationError(
            "BUSINESS_RENAME_FAILED",
            "Failed to rename restaurants to businesses. Migration stopped immediately.",
        )
    }

    try {
        await store.renameCollection(COLLECTIONS.LEGACY_STAFF, COLLECTIONS.STAFF)
    } catch {
        throw new CollectionMigrationError(
            "STAFF_RENAME_FAILED",
            "Failed to rename waiters to staff. Migration stopped immediately. The businesses rename may already be complete; inspect state before retrying or rolling back.",
        )
    }

    const migrated = await inspectCollectionMigrationState(store)
    assertMigratedState(migrated)
    assertCountsMatch(migrated.businesses.count, originalBusinessCount, "businesses")
    assertCountsMatch(migrated.staff.count, originalStaffCount, "staff")
    printInspection(output, migrated, "migrated")
    output.log("Collection rename completed and verified successfully.")

    return { status: "migrated", snapshot: migrated, operations }
}

export async function rollbackCollectionNames({
    store,
    dryRun = false,
    confirmRollback = false,
    confirmProduction = false,
    env = process.env,
    logger = console,
} = {}) {
    const output = safeLogger(logger)
    printMaintenanceWarning(output)

    const initial = await inspectCollectionMigrationState(store)
    const initialState = detectState(initial)
    printInspection(output, initial, initialState)

    if (initialState === "legacy") {
        assertLegacyPreflight(initial)
        output.log("Collections are already using the legacy names and are valid. No rollback changes are required.")
        return { status: "already_rolled_back", snapshot: initial, operations: [] }
    }

    assertMigratedState(initial)
    const operations = rollbackOperations(initial)
    printOperations(output, operations)

    if (dryRun) {
        output.log("Rollback dry-run complete. No database changes were made.")
        return { status: "dry_run", snapshot: initial, operations }
    }

    assertConfirmation({
        action: "rollback",
        confirmed: confirmRollback,
        productionConfirmed: confirmProduction,
        env,
    })

    const immediate = await inspectCollectionMigrationState(store)
    assertMigratedState(immediate)
    if (countsChanged(initial, immediate, ["restaurants", "businesses", "waiters", "staff"])) {
        throw new CollectionMigrationError(
            "PREFLIGHT_STATE_CHANGED",
            "Collection counts changed after rollback preflight. No changes were made; stop all writers and retry.",
        )
    }

    const originalBusinessCount = immediate.businesses.count
    const originalStaffCount = immediate.staff.count

    await dropEmptyTargetIfPresent(store, COLLECTIONS.LEGACY_BUSINESS)
    await dropEmptyTargetIfPresent(store, COLLECTIONS.LEGACY_STAFF)

    try {
        await store.renameCollection(COLLECTIONS.BUSINESS, COLLECTIONS.LEGACY_BUSINESS)
    } catch {
        throw new CollectionMigrationError(
            "BUSINESS_ROLLBACK_FAILED",
            "Failed to rename businesses to restaurants. Rollback stopped immediately.",
        )
    }

    try {
        await store.renameCollection(COLLECTIONS.STAFF, COLLECTIONS.LEGACY_STAFF)
    } catch {
        throw new CollectionMigrationError(
            "STAFF_ROLLBACK_FAILED",
            "Failed to rename staff to waiters. Rollback stopped immediately. The businesses rollback may already be complete; inspect state before retrying.",
        )
    }

    const rolledBack = await inspectCollectionMigrationState(store)
    assertLegacyPreflight(rolledBack)
    assertCountsMatch(rolledBack.restaurants.count, originalBusinessCount, "restaurants")
    assertCountsMatch(rolledBack.waiters.count, originalStaffCount, "waiters")
    printInspection(output, rolledBack, "legacy")
    output.log("Collection rollback completed and verified successfully.")

    return { status: "rolled_back", snapshot: rolledBack, operations }
}

export function createMongoCollectionMigrationStore(database) {
    if (!database) {
        throw new TypeError("A MongoDB database handle is required")
    }

    async function collectionExists(name) {
        const matches = await database.listCollections({ name }, { nameOnly: true }).toArray()
        return matches.some((collection) => collection.name === name)
    }

    return {
        collectionExists,

        async countDocuments(name) {
            return database.collection(name).countDocuments({})
        },

        async countInvalidField(name, field) {
            const collection = database.collection(name)
            const total = await collection.countDocuments({})
            const valid = await collection.countDocuments({
                [field]: { $type: "string", $ne: "" },
            })
            return total - valid
        },

        async countDuplicateGroups(name, fields) {
            const validFields = Object.fromEntries(fields.map((field) => [
                field,
                { $type: "string", $ne: "" },
            ]))
            const groupId = Object.fromEntries(fields.map((field) => [field, `$${field}`]))
            const [result] = await database.collection(name).aggregate([
                { $match: validFields },
                { $group: { _id: groupId, count: { $sum: 1 } } },
                { $match: { count: { $gt: 1 } } },
                {
                    $group: {
                        _id: null,
                        groups: { $sum: 1 },
                        excessDocuments: { $sum: { $subtract: ["$count", 1] } },
                    },
                },
            ]).toArray()

            return result
                ? { groups: result.groups, excessDocuments: result.excessDocuments }
                : { groups: 0, excessDocuments: 0 }
        },

        async listIndexes(name) {
            return database.collection(name).indexes()
        },

        async dropEmptyCollection(name) {
            if (!await collectionExists(name)) return false
            const count = await database.collection(name).countDocuments({})
            if (count > 0) {
                throw new CollectionMigrationError(
                    "TARGET_NOT_EMPTY",
                    `${name} contains documents. Refusing to drop it.`,
                )
            }
            return database.collection(name).drop()
        },

        async renameCollection(source, target) {
            return database.collection(source).rename(target, { dropTarget: false })
        },
    }
}

export { COLLECTIONS }
