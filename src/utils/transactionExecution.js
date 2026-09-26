import mongoose from "mongoose"

const CANONICAL_TRANSACTION_OPTIONS = {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
    maxCommitTimeMS: 10_000,
}

export async function withCanonicalTransaction(work, {
    startSession = () => mongoose.startSession(),
} = {}) {
    const session = await startSession()
    try {
        let result
        await session.withTransaction(async () => {
            result = await work(session)
            return result
        }, CANONICAL_TRANSACTION_OPTIONS)
        return result
    } finally {
        await session.endSession()
    }
}
