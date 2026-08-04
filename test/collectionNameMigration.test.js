import test from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import Business from "../src/models/Business.js"
import Staff from "../src/models/Staff.js"
import {
    CollectionMigrationError,
    migrateCollectionNames,
    rollbackCollectionNames,
} from "../scripts/lib/collection-name-migration.js"

const BUSINESS_INDEXES = [
    { name: "_id_", key: { _id: 1 }, unique: true },
    { name: "businessId_1", key: { businessId: 1 }, unique: true },
]

const STAFF_INDEXES = [
    { name: "_id_", key: { _id: 1 }, unique: true },
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
    {
        name: "businessId_1_waiterId_1",
        key: { businessId: 1, waiterId: 1 },
        unique: true,
        sparse: true,
    },
]

const silentLogger = {
    log() {},
    warn() {},
}

function clone(value) {
    return structuredClone(value)
}

class MemoryCollectionStore {
    constructor(collections) {
        this.collections = clone(collections)
        this.mutations = []
    }

    async collectionExists(name) {
        return Object.hasOwn(this.collections, name)
    }

    async countDocuments(name) {
        return this.collections[name].documents.length
    }

    async countInvalidField(name, field) {
        return this.collections[name].documents.filter((document) => (
            typeof document[field] !== "string" || document[field].length === 0
        )).length
    }

    async countDuplicateGroups(name, fields) {
        const counts = new Map()
        for (const document of this.collections[name].documents) {
            if (fields.some((field) => typeof document[field] !== "string" || document[field].length === 0)) {
                continue
            }
            const key = JSON.stringify(fields.map((field) => document[field]))
            counts.set(key, (counts.get(key) || 0) + 1)
        }
        const duplicateCounts = [...counts.values()].filter((count) => count > 1)
        return {
            groups: duplicateCounts.length,
            excessDocuments: duplicateCounts.reduce((sum, count) => sum + count - 1, 0),
        }
    }

    async listIndexes(name) {
        return clone(this.collections[name].indexes)
    }

    async dropEmptyCollection(name) {
        assert.equal(this.collections[name].documents.length, 0)
        delete this.collections[name]
        this.mutations.push({ operation: "drop", name })
        return true
    }

    async renameCollection(source, target) {
        if (!Object.hasOwn(this.collections, source)) throw new Error("source missing")
        if (Object.hasOwn(this.collections, target)) throw new Error("target exists")
        this.collections[target] = this.collections[source]
        delete this.collections[source]
        this.mutations.push({ operation: "rename", source, target })
    }
}

function legacyStore() {
    return new MemoryCollectionStore({
        restaurants: {
            documents: [
                { businessId: "business-a" },
                { businessId: "business-b" },
            ],
            indexes: BUSINESS_INDEXES,
        },
        businesses: {
            documents: [],
            indexes: [{ name: "_id_", key: { _id: 1 }, unique: true }],
        },
        waiters: {
            documents: [
                {
                    businessId: "business-a",
                    staffId: "WTR-1001",
                    email: "one@example.test",
                },
                {
                    businessId: "business-a",
                    staffId: "KIT-1002",
                    email: "two@example.test",
                },
            ],
            indexes: STAFF_INDEXES,
        },
    })
}

function hasMigrationCode(code) {
    return (error) => error instanceof CollectionMigrationError && error.code === code
}

test("collection migration dry-run performs every validation without renaming", async () => {
    const store = legacyStore()

    const result = await migrateCollectionNames({
        store,
        dryRun: true,
        env: { NODE_ENV: "production" },
        logger: silentLogger,
    })

    assert.equal(result.status, "dry_run")
    assert.equal(store.mutations.length, 0)
    assert.equal(await store.collectionExists("restaurants"), true)
    assert.equal(await store.collectionExists("waiters"), true)
    assert.equal(await store.collectionExists("businesses"), true)
    assert.equal(await store.collectionExists("staff"), false)
})

test("collection migration requires explicit confirmation after preflight", async () => {
    const store = legacyStore()

    await assert.rejects(
        () => migrateCollectionNames({ store, logger: silentLogger, env: {} }),
        hasMigrationCode("CONFIRMATION_REQUIRED"),
    )
    assert.equal(store.mutations.length, 0)
})

test("collection migration aborts when a target collection contains documents", async () => {
    const store = legacyStore()
    store.collections.businesses.documents.push({ businessId: "unexpected-target" })

    await assert.rejects(
        () => migrateCollectionNames({ store, dryRun: true, logger: silentLogger }),
        hasMigrationCode("TARGET_NOT_EMPTY"),
    )
    assert.equal(store.mutations.length, 0)
})

test("collection migration aborts when required identifiers are missing", async () => {
    const store = legacyStore()
    delete store.collections.waiters.documents[0].staffId

    await assert.rejects(
        () => migrateCollectionNames({ store, dryRun: true, logger: silentLogger }),
        hasMigrationCode("REQUIRED_IDENTIFIERS_MISSING"),
    )
    assert.equal(store.mutations.length, 0)
})

test("collection migration aborts for each required duplicate constraint", async (t) => {
    await t.test("duplicate businessId", async () => {
        const store = legacyStore()
        store.collections.restaurants.documents[1].businessId = "business-a"
        await assert.rejects(
            () => migrateCollectionNames({ store, dryRun: true, logger: silentLogger }),
            hasMigrationCode("DUPLICATE_IDENTIFIERS"),
        )
    })

    await t.test("duplicate businessId and staffId", async () => {
        const store = legacyStore()
        store.collections.waiters.documents[1].staffId = "WTR-1001"
        await assert.rejects(
            () => migrateCollectionNames({ store, dryRun: true, logger: silentLogger }),
            hasMigrationCode("DUPLICATE_IDENTIFIERS"),
        )
    })

    await t.test("duplicate businessId and email", async () => {
        const store = legacyStore()
        store.collections.waiters.documents[1].email = "one@example.test"
        await assert.rejects(
            () => migrateCollectionNames({ store, dryRun: true, logger: silentLogger }),
            hasMigrationCode("DUPLICATE_IDENTIFIERS"),
        )
    })
})

test("successful collection rename preserves documents, counts, and indexes", async () => {
    const store = legacyStore()
    const originalBusinessIndexes = clone(store.collections.restaurants.indexes)
    const originalStaffIndexes = clone(store.collections.waiters.indexes)

    const result = await migrateCollectionNames({
        store,
        confirmRename: true,
        env: { NODE_ENV: "test" },
        logger: silentLogger,
    })

    assert.equal(result.status, "migrated")
    assert.equal(await store.collectionExists("restaurants"), false)
    assert.equal(await store.collectionExists("waiters"), false)
    assert.equal(await store.countDocuments("businesses"), 2)
    assert.equal(await store.countDocuments("staff"), 2)
    assert.deepEqual(store.collections.businesses.indexes, originalBusinessIndexes)
    assert.deepEqual(store.collections.staff.indexes, originalStaffIndexes)
    assert.deepEqual(store.mutations, [
        { operation: "drop", name: "businesses" },
        { operation: "rename", source: "restaurants", target: "businesses" },
        { operation: "rename", source: "waiters", target: "staff" },
    ])

    const secondRun = await migrateCollectionNames({
        store,
        confirmRename: true,
        env: { NODE_ENV: "test" },
        logger: silentLogger,
    })
    assert.equal(secondRun.status, "already_migrated")
    assert.equal(store.mutations.length, 3)
})

test("rollback restores legacy collection names and counts", async () => {
    const store = legacyStore()
    await migrateCollectionNames({
        store,
        confirmRename: true,
        env: { NODE_ENV: "test" },
        logger: silentLogger,
    })

    const result = await rollbackCollectionNames({
        store,
        confirmRollback: true,
        env: { NODE_ENV: "test" },
        logger: silentLogger,
    })

    assert.equal(result.status, "rolled_back")
    assert.equal(await store.countDocuments("restaurants"), 2)
    assert.equal(await store.countDocuments("waiters"), 2)
    assert.equal(await store.collectionExists("businesses"), false)
    assert.equal(await store.collectionExists("staff"), false)

    const secondRun = await rollbackCollectionNames({
        store,
        confirmRollback: true,
        env: { NODE_ENV: "test" },
        logger: silentLogger,
    })
    assert.equal(secondRun.status, "already_rolled_back")
})

test("production execution requires the additional production confirmation", async () => {
    const store = legacyStore()

    await assert.rejects(
        () => migrateCollectionNames({
            store,
            confirmRename: true,
            env: { NODE_ENV: "production" },
            logger: silentLogger,
        }),
        hasMigrationCode("PRODUCTION_CONFIRMATION_REQUIRED"),
    )
    assert.equal(store.mutations.length, 0)
})

test("Business and Staff use explicit canonical collection bindings", () => {
    assert.equal(Business.collection.collectionName, "businesses")
    assert.equal(Staff.collection.collectionName, "staff")
})

async function findJavaScriptFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
            files.push(...await findJavaScriptFiles(path))
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            files.push(path)
        }
    }
    return files
}

test("no active source or script imports the abandoned Waiter model", async () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
    const files = [
        ...await findJavaScriptFiles(join(repositoryRoot, "src")),
        ...await findJavaScriptFiles(join(repositoryRoot, "scripts")),
        join(repositoryRoot, "server.js"),
        join(repositoryRoot, "test-create-manager.js"),
    ]
    const importPattern = /(?:from\s+|import\s*\()\s*["'][^"']*models[/\\]Waiter\.js["']/
    const offenders = []

    for (const file of files) {
        const content = await readFile(file, "utf8")
        if (importPattern.test(content)) {
            offenders.push(relative(repositoryRoot, file))
        }
    }

    assert.deepEqual(offenders, [])
})
