import assert from "node:assert/strict"
import test from "node:test"

import Staff from "../src/models/Staff.js"
import { CollectionMigrationError } from "../scripts/lib/collection-name-migration.js"
import {
    LEGACY_WAITER_INDEX_NAME,
    migrateStaffLegacyWaiterIndex,
} from "../scripts/lib/staff-legacy-waiter-index-migration.js"

const CANONICAL_INDEXES = [
    { name: "_id_", key: { _id: 1 }, unique: true },
    { name: "businessId_1", key: { businessId: 1 } },
    {
        name: "businessId_1_staffId_1",
        key: { businessId: 1, staffId: 1 },
        unique: true,
    },
    {
        name: "businessId_1_email_1",
        key: { businessId: 1, email: 1 },
        unique: true,
    },
]

const LEGACY_INDEX = {
    name: LEGACY_WAITER_INDEX_NAME,
    key: { businessId: 1, waiterId: 1 },
    unique: true,
}

const silentLogger = {
    log() {},
    warn() {},
}

function clone(value) {
    return structuredClone(value)
}

class MemoryStaffIndexStore {
    constructor({ exists = true, indexes = CANONICAL_INDEXES, documents = [] } = {}) {
        this.exists = exists
        this.indexes = clone(indexes)
        this.documents = clone(documents)
        this.mutations = []
    }

    async collectionExists(name) {
        assert.equal(name, "staff")
        return this.exists
    }

    async listIndexes(name) {
        assert.equal(name, "staff")
        return clone(this.indexes)
    }

    async countDocumentsWithField(name, field) {
        assert.equal(name, "staff")
        return this.documents.filter((document) => Object.hasOwn(document, field)).length
    }

    async dropIndex(name, indexName) {
        assert.equal(name, "staff")
        const position = this.indexes.findIndex((index) => index.name === indexName)
        if (position < 0) throw new Error("index missing")
        this.indexes.splice(position, 1)
        this.mutations.push({ operation: "dropIndex", name, indexName })
    }
}

function hasMigrationCode(code) {
    return (error) => error instanceof CollectionMigrationError && error.code === code
}

function schemaHasIndex(expectedKey, unique) {
    const expected = Object.entries(expectedKey)
    return Staff.schema.indexes().some(([fields, options]) => {
        const actual = Object.entries(fields)
        return actual.length === expected.length &&
            actual.every(([field, direction], position) => (
                field === expected[position][0] && direction === expected[position][1]
            )) &&
            Boolean(options.unique) === unique
    })
}

test("Staff schema contains only canonical identity indexes", () => {
    assert.equal(Staff.schema.path("waiterId"), undefined)
    assert.equal(schemaHasIndex({ businessId: 1, waiterId: 1 }, true), false)
    assert.equal(schemaHasIndex({ businessId: 1, staffId: 1 }, true), true)
    assert.equal(schemaHasIndex({ businessId: 1, email: 1 }, true), true)
})

test("legacy waiter index is removed exactly once and repeated execution is safe", async () => {
    const unrelated = { name: "role_1", key: { role: 1 } }
    const store = new MemoryStaffIndexStore({
        indexes: [...CANONICAL_INDEXES, unrelated, LEGACY_INDEX],
    })

    const dryRun = await migrateStaffLegacyWaiterIndex({
        store,
        dryRun: true,
        logger: silentLogger,
    })
    assert.equal(dryRun.status, "dry_run")
    assert.equal(store.mutations.length, 0)

    const first = await migrateStaffLegacyWaiterIndex({
        store,
        confirmDrop: true,
        env: { NODE_ENV: "test" },
        logger: silentLogger,
    })
    assert.equal(first.status, "removed")
    assert.equal(first.removedIndexName, LEGACY_WAITER_INDEX_NAME)
    assert.deepEqual(store.mutations, [{
        operation: "dropIndex",
        name: "staff",
        indexName: LEGACY_WAITER_INDEX_NAME,
    }])
    assert.ok(store.indexes.some((index) => index.name === unrelated.name))
    assert.ok(store.indexes.some((index) => index.name === "businessId_1_staffId_1"))
    assert.ok(store.indexes.some((index) => index.name === "businessId_1_email_1"))

    const second = await migrateStaffLegacyWaiterIndex({
        store,
        confirmDrop: true,
        env: { NODE_ENV: "test" },
        logger: silentLogger,
    })
    assert.equal(second.status, "not_present")
    assert.equal(store.mutations.length, 1)
})

test("legacy index absence is a safe no-op for fresh Staff states", async (t) => {
    await t.test("canonical collection without legacy index", async () => {
        const store = new MemoryStaffIndexStore()
        const result = await migrateStaffLegacyWaiterIndex({
            store,
            logger: silentLogger,
        })
        assert.equal(result.status, "not_present")
        assert.equal(store.mutations.length, 0)
    })

    await t.test("collection not created yet", async () => {
        const store = new MemoryStaffIndexStore({ exists: false, indexes: [] })
        const result = await migrateStaffLegacyWaiterIndex({
            store,
            logger: silentLogger,
        })
        assert.equal(result.status, "not_present")
        assert.equal(result.inspection.collectionExists, false)
        assert.equal(store.mutations.length, 0)
    })
})

test("migration requires explicit normal and production confirmations", async () => {
    const store = new MemoryStaffIndexStore({
        indexes: [...CANONICAL_INDEXES, LEGACY_INDEX],
    })
    await assert.rejects(
        () => migrateStaffLegacyWaiterIndex({ store, logger: silentLogger }),
        hasMigrationCode("CONFIRMATION_REQUIRED"),
    )
    await assert.rejects(
        () => migrateStaffLegacyWaiterIndex({
            store,
            confirmDrop: true,
            env: { NODE_ENV: "production" },
            logger: silentLogger,
        }),
        hasMigrationCode("PRODUCTION_CONFIRMATION_REQUIRED"),
    )
    assert.equal(store.mutations.length, 0)
})

test("migration stops when legacy Staff documents still contain waiterId", async () => {
    const store = new MemoryStaffIndexStore({
        indexes: [...CANONICAL_INDEXES, LEGACY_INDEX],
        documents: [{ businessId: "business-a", waiterId: "WTR-1001" }],
    })
    await assert.rejects(
        () => migrateStaffLegacyWaiterIndex({
            store,
            confirmDrop: true,
            env: { NODE_ENV: "test" },
            logger: silentLogger,
        }),
        hasMigrationCode("LEGACY_WAITER_DATA_PRESENT"),
    )
    assert.equal(store.mutations.length, 0)
})

test("migration rechecks legacy waiterId data immediately before dropping", async () => {
    const store = new MemoryStaffIndexStore({
        indexes: [...CANONICAL_INDEXES, LEGACY_INDEX],
    })
    let inspectionCount = 0
    store.countDocumentsWithField = async (name, field) => {
        assert.equal(name, "staff")
        assert.equal(field, "waiterId")
        inspectionCount += 1
        return inspectionCount === 1 ? 0 : 1
    }

    await assert.rejects(
        () => migrateStaffLegacyWaiterIndex({
            store,
            confirmDrop: true,
            env: { NODE_ENV: "test" },
            logger: silentLogger,
        }),
        hasMigrationCode("LEGACY_WAITER_DATA_PRESENT"),
    )
    assert.equal(store.mutations.length, 0)
})

test("migration refuses missing canonical indexes and legacy-name collisions", async (t) => {
    await t.test("missing canonical email index", async () => {
        const indexes = CANONICAL_INDEXES.filter(
            (index) => index.name !== "businessId_1_email_1",
        )
        const store = new MemoryStaffIndexStore({
            indexes: [...indexes, LEGACY_INDEX],
        })
        await assert.rejects(
            () => migrateStaffLegacyWaiterIndex({
                store,
                confirmDrop: true,
                logger: silentLogger,
            }),
            hasMigrationCode("CANONICAL_STAFF_INDEX_MISSING"),
        )
        assert.equal(store.mutations.length, 0)
    })

    await t.test("expected legacy name points to another key", async () => {
        const store = new MemoryStaffIndexStore({
            indexes: [
                ...CANONICAL_INDEXES,
                {
                    name: LEGACY_WAITER_INDEX_NAME,
                    key: { businessId: 1, unrelated: 1 },
                    unique: true,
                },
            ],
        })
        await assert.rejects(
            () => migrateStaffLegacyWaiterIndex({
                store,
                confirmDrop: true,
                logger: silentLogger,
            }),
            hasMigrationCode("LEGACY_INDEX_NAME_CONFLICT"),
        )
        assert.equal(store.mutations.length, 0)
    })
})

test("exact legacy key with a custom observed name is removed by that name", async () => {
    const customLegacy = { ...LEGACY_INDEX, name: "legacy_waiter_identity_unique" }
    const store = new MemoryStaffIndexStore({
        indexes: [...CANONICAL_INDEXES, customLegacy],
    })
    const result = await migrateStaffLegacyWaiterIndex({
        store,
        confirmDrop: true,
        env: { NODE_ENV: "test" },
        logger: silentLogger,
    })
    assert.equal(result.removedIndexName, customLegacy.name)
    assert.deepEqual(store.mutations[0], {
        operation: "dropIndex",
        name: "staff",
        indexName: customLegacy.name,
    })
})
