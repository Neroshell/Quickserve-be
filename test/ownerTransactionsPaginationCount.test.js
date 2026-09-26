import test from "node:test"
import assert from "node:assert/strict"
import mongoose from "mongoose"
import {
    MAX_OWNER_TRANSACTIONS_CURSOR_LENGTH,
    decodeCursor,
    encodeCursor,
    readOwnerTransactionsPage,
} from "../src/services/ownerTransactionsReadService.js"
import Order from "../src/models/order.js"
import Reservation from "../src/models/Reservation.js"

test("owner transaction cursor validates length, encoding, date, rank, and id before queries", async () => {
    const id = new mongoose.Types.ObjectId()
    const encoded = encodeCursor(
        new Date("2026-09-20T10:00:00.000Z"),
        "order",
        id,
    )
    const decoded = decodeCursor(encoded)
    assert.equal(decoded.transactionAt.toISOString(), "2026-09-20T10:00:00.000Z")
    assert.equal(decoded.sourceRank, 2)
    assert.equal(decoded.id, String(id))

    assert.throws(
        () => decodeCursor("a".repeat(MAX_OWNER_TRANSACTIONS_CURSOR_LENGTH + 1)),
        /Invalid pagination cursor/,
    )
    assert.throws(
        () => decodeCursor("not+base64"),
        /Invalid pagination cursor/,
    )

    const invalidDate = Buffer.from(JSON.stringify({
        t: "not-a-timestamp",
        r: 2,
        i: String(id),
    })).toString("base64url")
    assert.throws(
        () => decodeCursor(invalidDate),
        /Invalid pagination cursor/,
    )
    await assert.rejects(
        () => readOwnerTransactionsPage({
            businessId: "biz_cursor",
            cursor: invalidDate,
        }),
        (error) => error.status === 400 && /Invalid cursor format/.test(error.message),
    )
})

test("ownerTransactionsReadService totalCount", async (t) => {
    // We mock the countDocuments calls by wrapping the mongoose models
    const originalOrderCount = Order.countDocuments;
    const originalReservationCount = Reservation.countDocuments;
    const originalOrderFind = Order.find;
    const originalReservationFind = Reservation.find;

    t.after(() => {
        Order.countDocuments = originalOrderCount;
        Reservation.countDocuments = originalReservationCount;
        Order.find = originalOrderFind;
        Reservation.find = originalReservationFind;
    });

    await t.test("should correctly aggregate totalCount across collections without filters", async () => {
        Order.countDocuments = async () => 100;
        Reservation.countDocuments = async () => 41;

        Order.find = () => ({
            sort: () => ({ limit: () => ({ lean: async () => [] }) })
        });
        Reservation.find = () => ({
            sort: () => ({ limit: () => ({ lean: async () => [] }) })
        });

        const result = await readOwnerTransactionsPage({
            businessId: new mongoose.Types.ObjectId(),
            limit: 25,
            module: "overview",
            filterBy: "all"
        });

        assert.equal(result.pagination.totalCount, 141);
    });

    await t.test("should only count reservations when module=lodging", async () => {
        Order.countDocuments = async () => { throw new Error("Should not be called") };
        Reservation.countDocuments = async () => 41;

        Order.find = () => ({
            sort: () => ({ limit: () => ({ lean: async () => [] }) })
        });
        Reservation.find = () => ({
            sort: () => ({ limit: () => ({ lean: async () => [] }) })
        });

        const result = await readOwnerTransactionsPage({
            businessId: new mongoose.Types.ObjectId(),
            limit: 25,
            module: "lodging",
            filterBy: "all"
        });

        assert.equal(result.pagination.totalCount, 41);
    });

    await t.test("should only count orders when module=foodService", async () => {
        Order.countDocuments = async () => 100;
        Reservation.countDocuments = async () => { throw new Error("Should not be called") };

        Order.find = () => ({
            sort: () => ({ limit: () => ({ lean: async () => [] }) })
        });
        Reservation.find = () => ({
            sort: () => ({ limit: () => ({ lean: async () => [] }) })
        });

        const result = await readOwnerTransactionsPage({
            businessId: new mongoose.Types.ObjectId(),
            limit: 25,
            module: "foodService",
            filterBy: "all"
        });

        assert.equal(result.pagination.totalCount, 100);
    });
});
