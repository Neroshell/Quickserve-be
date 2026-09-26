/**
 * ARCH-010: Environment Verification
 *
 * A non-destructive pre-flight script to verify that the environment
 * is correctly configured for the application. Checks Node version,
 * mandatory environment variables, MongoDB transactions, and Redis.
 *
 * Usage: npm run verify:environment
 */
import "dotenv/config";
import mongoose from "mongoose";
import { createClient } from "redis";
import { validateEnvironment } from "../src/config/envValidation.js";

const expectedNodeMajor = 24;

async function checkNodeVersion() {
    const version = process.version;
    const major = parseInt(version.slice(1).split(".")[0], 10);

    if (major !== expectedNodeMajor) {
        console.error(`❌ Expected Node.js v${expectedNodeMajor}.x, but found ${version}`);
        return false;
    }
    console.log(`✅ Node.js version ${version}`);
    return true;
}

async function checkMongoDB() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error("❌ MONGODB_URI is not set.");
        return false;
    }

    try {
        await mongoose.connect(uri);
        console.log("✅ MongoDB connected successfully.");

        // Verify transaction support (replica set or sharded cluster)
        const admin = mongoose.connection.db.admin();
        const serverInfo = await admin.command({ isMaster: 1 });

        const canTransact = !!serverInfo.setName || serverInfo.msg === "isdbgrid";
        if (!canTransact) {
            console.error("❌ MongoDB deployment does not support transactions (must be a replica set or sharded cluster).");
            return false;
        }

        console.log(`✅ MongoDB transactions supported (${serverInfo.setName ? "Replica Set" : "Sharded Cluster"}).`);
        return true;
    } catch (err) {
        console.error("❌ Failed to connect to MongoDB:", err.message);
        return false;
    } finally {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
    }
}

async function checkRedis() {
    const url = process.env.REDIS_URL;
    if (!url) {
        console.warn("⚠️ REDIS_URL is not set. Systems will use local fallbacks where available.");
        return true; // Not strictly failing the whole script, just warning, unless production
    }

    const client = createClient({ url, socket: { connectTimeout: 5000 } });
    try {
        await client.connect();
        console.log("✅ Redis connected successfully.");
        await client.quit();
        return true;
    } catch (err) {
        console.error("❌ Failed to connect to Redis:", err.message);
        return false;
    }
}

function checkEnvironmentVariables() {
    const apiValidation = validateEnvironment("api");
    const workerValidation = validateEnvironment("worker");

    let allValid = true;

    if (!apiValidation.valid) {
        console.error("❌ API environment validation failed:");
        apiValidation.errors.forEach(e => console.error(`  - ${e}`));
        allValid = false;
    } else {
        console.log("✅ API environment variables validated.");
    }

    if (!workerValidation.valid) {
        console.error("❌ Worker environment validation failed:");
        workerValidation.errors.forEach(e => console.error(`  - ${e}`));
        allValid = false;
    } else {
        console.log("✅ Worker environment variables validated.");
    }

    // Warnings
    const allWarnings = [...apiValidation.warnings, ...workerValidation.warnings];
    const uniqueWarnings = [...new Set(allWarnings)];
    uniqueWarnings.forEach(w => console.warn(`⚠️  ${w}`));

    return allValid;
}

async function main() {
    console.log("Starting environment verification...\n");
    let success = true;

    if (!(await checkNodeVersion())) success = false;

    if (!checkEnvironmentVariables()) {
        success = false;
        if (process.env.NODE_ENV === "production") {
            console.error("\n❌ Stopping verification due to missing mandatory production configuration.");
            process.exit(1);
        }
    }

    if (!(await checkMongoDB())) success = false;
    if (!(await checkRedis())) success = false;

    console.log("\n---------------------------------------------------");
    if (success) {
        console.log("🎉 Environment verification PASSED.");
        process.exit(0);
    } else {
        console.error("💥 Environment verification FAILED.");
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Verification script encountered an unexpected error:", err);
    process.exit(1);
});
