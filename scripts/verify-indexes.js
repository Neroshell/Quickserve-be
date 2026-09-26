/**
 * ARCH-010: read-only index verification.
 *
 * Connects with automatic collection/index creation disabled and compares
 * schema-declared index definitions with the database. It never calls
 * createIndex, syncIndexes, or dropIndex.
 *
 * Strict mode:
 *   NODE_ENV=production, INDEX_VERIFY_STRICT=true, or --strict
 */
import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import mongoose from "mongoose";

import "../src/models/Staff.js";
import "../src/models/Reservation.js";
import "../src/models/order.js";
import "../src/models/InventoryReservation.js";
import "../src/models/InventoryPaymentException.js";
import "../src/models/PendingCheckout.js";
import "../src/models/ServiceRequest.js";
import "../src/models/ServicePoint.js";

export const INDEX_MODELS = Object.freeze([
    "Staff",
    "Reservation",
    "Order",
    "InventoryReservation",
    "InventoryPaymentException",
    "PendingCheckout",
    "ServiceRequest",
    "ServicePoint",
]);

const VERIFIED_OPTIONS = Object.freeze([
    "unique",
    "sparse",
    "expireAfterSeconds",
    "partialFilterExpression",
    "collation",
]);

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
}

function sameValue(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export function indexMatches(actual, expectedKey, expectedOptions = {}) {
    if (!sameValue(actual.key, expectedKey)) return false;
    return VERIFIED_OPTIONS.every((option) => (
        expectedOptions[option] === undefined ||
        sameValue(actual[option], expectedOptions[option])
    ));
}

export async function verifyIndexes({
    uri = process.env.MONGODB_URI,
    strict = process.env.NODE_ENV === "production" ||
        process.env.INDEX_VERIFY_STRICT === "true" ||
        process.argv.includes("--strict"),
    logger = console,
} = {}) {
    if (!uri) throw new Error("MONGODB_URI is not set.");

    logger.log("Starting read-only index verification...\n");
    await mongoose.connect(uri, {
        autoIndex: false,
        autoCreate: false,
    });
    logger.log("MongoDB connected with autoIndex/autoCreate disabled.\n");

    let allValid = true;
    const drift = [];

    try {
        for (const modelName of INDEX_MODELS) {
            const Model = mongoose.models[modelName];
            if (!Model) {
                allValid = false;
                drift.push({ modelName, reason: "model_not_registered" });
                logger.error(`[${modelName}] Model is not registered.`);
                continue;
            }

            let actualIndexes = [];
            try {
                actualIndexes = await Model.collection.indexes();
            } catch (error) {
                if (error.codeName !== "NamespaceNotFound" && error.code !== 26) throw error;
            }

            const expectedIndexes = Model.schema.indexes();
            let missingCount = 0;
            for (const [keyPattern, options] of expectedIndexes) {
                if (!actualIndexes.some((actual) => indexMatches(actual, keyPattern, options))) {
                    missingCount += 1;
                    allValid = false;
                    drift.push({ modelName, keyPattern, options });
                    logger.error(
                        `[${modelName}] Missing/drifted index: ${JSON.stringify(keyPattern)} ` +
                        `options=${JSON.stringify(options)}`,
                    );
                }
            }

            if (missingCount === 0) {
                logger.log(
                    `[${modelName}] All expected schema indexes are present ` +
                    `(${expectedIndexes.length} custom indexes).`,
                );
            }
        }
    } finally {
        await mongoose.disconnect();
    }

    if (allValid) logger.log("\nIndex verification PASSED.");
    else if (strict) logger.error("\nIndex verification FAILED (strict mode).");
    else logger.warn("\nIndex drift detected (report-only mode).");

    return { allValid, strict, drift };
}

async function main() {
    try {
        const result = await verifyIndexes();
        if (!result.allValid && result.strict) process.exitCode = 1;
    } catch (error) {
        console.error("Index verification encountered an error:", error.message);
        process.exitCode = 1;
    }
}

const isEntrypoint = process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) await main();
