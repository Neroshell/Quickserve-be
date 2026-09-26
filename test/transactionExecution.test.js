import assert from "node:assert/strict"
import test from "node:test"

import { withCanonicalTransaction } from "../src/utils/transactionExecution.js"

const EXPECTED_OPTIONS = {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
    maxCommitTimeMS: 10_000,
}

test("canonical transaction executes work once, returns its result, passes options, and ends the session", async () => {
    const calls = []
    const expected = { committed: true }
    const session = {
        async withTransaction(work, options) {
            calls.push("withTransaction")
            assert.deepEqual(options, EXPECTED_OPTIONS)
            await work()
        },
        async endSession() {
            calls.push("endSession")
        },
    }

    const result = await withCanonicalTransaction(async (receivedSession) => {
        calls.push("work")
        assert.equal(receivedSession, session)
        return expected
    }, {
        startSession: async () => {
            calls.push("startSession")
            return session
        },
    })

    assert.equal(result, expected)
    assert.deepEqual(calls, ["startSession", "withTransaction", "work", "endSession"])
})

test("canonical transaction propagates a work failure and still ends the session", async () => {
    const failure = new Error("work failed")
    let endSessionCalls = 0
    const session = {
        async withTransaction(work) {
            return work()
        },
        async endSession() {
            endSessionCalls += 1
        },
    }

    await assert.rejects(
        withCanonicalTransaction(async () => { throw failure }, {
            startSession: async () => session,
        }),
        (error) => error === failure,
    )
    assert.equal(endSessionCalls, 1)
})

test("canonical transaction does not add an outer retry for transient driver errors", async () => {
    const failure = new Error("transient commit failure")
    failure.hasErrorLabel = (label) => label === "UnknownTransactionCommitResult"
    let startSessionCalls = 0
    let withTransactionCalls = 0
    let workCalls = 0
    let endSessionCalls = 0
    const session = {
        async withTransaction(work) {
            withTransactionCalls += 1
            await work()
            throw failure
        },
        async endSession() {
            endSessionCalls += 1
        },
    }

    await assert.rejects(
        withCanonicalTransaction(async () => {
            workCalls += 1
        }, {
            startSession: async () => {
                startSessionCalls += 1
                return session
            },
        }),
        (error) => error === failure,
    )

    assert.equal(startSessionCalls, 1)
    assert.equal(withTransactionCalls, 1)
    assert.equal(workCalls, 1)
    assert.equal(endSessionCalls, 1)
})

test("canonical transaction propagates domain errors without classifying or retrying them", async () => {
    class DomainError extends Error {}
    const failure = new DomainError("domain conflict")
    let withTransactionCalls = 0
    let workCalls = 0
    let endSessionCalls = 0
    const session = {
        async withTransaction(work) {
            withTransactionCalls += 1
            return work()
        },
        async endSession() {
            endSessionCalls += 1
        },
    }

    await assert.rejects(
        withCanonicalTransaction(async () => {
            workCalls += 1
            throw failure
        }, {
            startSession: async () => session,
        }),
        (error) => error === failure,
    )

    assert.equal(withTransactionCalls, 1)
    assert.equal(workCalls, 1)
    assert.equal(endSessionCalls, 1)
})
