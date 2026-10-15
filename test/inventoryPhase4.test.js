import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import mongoose from "mongoose"

import InventoryMovement from "../src/models/InventoryMovement.js"
import InventoryReservation from "../src/models/InventoryReservation.js"
import {
    INVENTORY_RESERVATION_RELEASE_EVIDENCE,
    INVENTORY_RESERVATION_SOURCE_TYPES,
    INVENTORY_RESERVATION_STATUSES,
    STRIPE_INVENTORY_HOLD_LIFETIME_MS,
} from "../src/constants/inventoryReservation.js"
import {
    buildInventoryReconciliationJobId,
    enqueueInventoryReservationReconciliation,
    isInventorySchedulersEnabled,
} from "../src/queues/inventoryQueue.js"
import { resolveEffectiveMenuAvailability } from "../src/services/menuInventoryAvailabilityService.js"
import { reconcileInventoryReservation } from "../src/services/inventoryReservationRepairService.js"

const fingerprint = "a".repeat(64)
const actor = { staffId: "system:test", role: "system", name: "Phase 4 Test" }

function reservationInput(overrides = {}) {
    return {
        reservationId: "irv_test",
        businessId: "biz_test",
        sourceType: INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT,
        sourceId: "ord_test",
        pendingCheckoutId: new mongoose.Types.ObjectId(),
        status: INVENTORY_RESERVATION_STATUSES.HELD,
        components: [{
            inventoryItemId: "inv_test",
            canonicalQuantity: 2,
            unit: "piece",
            reserveMovementId: "imv_reserve",
        }],
        expiresAt: new Date(Date.now() + STRIPE_INVENTORY_HOLD_LIFETIME_MS),
        idempotencyKey: "inventory:test",
        requestFingerprint: fingerprint,
        ...overrides,
    }
}

test("InventoryReservation requires exact reserved components and Stripe hold linkage", async () => {
    await new InventoryReservation(reservationInput()).validate()

    await assert.rejects(
        new InventoryReservation(reservationInput({ components: [] })).validate(),
        /requires reserved stock or ingredient-tracking allocations/i,
    )
    await assert.rejects(
        new InventoryReservation(reservationInput({
            sourceType: INVENTORY_RESERVATION_SOURCE_TYPES.OFFLINE_ORDER,
            status: INVENTORY_RESERVATION_STATUSES.HELD,
        })).validate(),
        /only Stripe Checkout reservations may remain held/i,
    )
    await assert.rejects(
        new InventoryReservation(reservationInput({ pendingCheckoutId: null })).validate(),
        /require expiry and PendingCheckout linkage/i,
    )
})

test("RESERVE and RELEASE movements change Reserved only and preserve On Hand", async () => {
    const reserve = new InventoryMovement({
        movementId: "imv_reserve_test",
        businessId: "biz_test",
        inventoryItemId: "inv_test",
        type: "RESERVE",
        quantityDeltaOnHand: 0,
        quantityDeltaReserved: 2,
        unit: "piece",
        canonicalQuantity: 2,
        onHandBefore: 4,
        onHandAfter: 4,
        reservedBefore: 1,
        reservedAfter: 3,
        sourceType: "inventory_reservation",
        sourceId: "irv_test",
        performedBy: actor,
        idempotencyKey: "reserve:test",
        requestFingerprint: fingerprint,
    })
    await reserve.validate()

    const release = new InventoryMovement({
        ...reserve.toObject(),
        _id: undefined,
        movementId: "imv_release_test",
        type: "RELEASE",
        quantityDeltaReserved: -2,
        reservedBefore: 3,
        reservedAfter: 1,
        idempotencyKey: "release:test",
    })
    await release.validate()
    assert.equal(release.onHandBefore, release.onHandAfter)
})

test("Simple Stock uses available stock while recipes keep manual sales availability", () => {
    const menuItem = { manualIsAvailable: true, isAvailable: true, trackStock: false }
    const inventoryItems = [
        { inventoryItemId: "inv_a", onHandQuantity: 10, reservedQuantity: 4, isActive: true },
        { inventoryItemId: "inv_b", onHandQuantity: 9, reservedQuantity: 1, isActive: true },
    ]
    const simple = resolveEffectiveMenuAvailability({
        menuItem,
        mapping: {
            status: "active",
            mode: "simple",
            components: [{ inventoryItemId: "inv_a", canonicalQuantity: 2 }],
        },
        inventoryItems,
    })
    assert.equal(simple.availableMenuQuantity, 3)

    const recipe = resolveEffectiveMenuAvailability({
        menuItem,
        mapping: {
            status: "active",
            mode: "recipe",
            components: [
                { inventoryItemId: "inv_a", canonicalQuantity: 2 },
                { inventoryItemId: "inv_b", canonicalQuantity: 4 },
            ],
        },
        inventoryItems,
    })
    assert.equal(recipe.availableMenuQuantity, 2)
    assert.equal(recipe.effectiveIsAvailable, true)

    const recipeShortage = resolveEffectiveMenuAvailability({
        menuItem,
        mapping: {
            status: "active",
            mode: "recipe",
            components: [{ inventoryItemId: "inv_a", canonicalQuantity: 2 }],
        },
        inventoryItems: [{
            inventoryItemId: "inv_a",
            onHandQuantity: 0,
            reservedQuantity: 0,
            isActive: true,
        }],
    })
    assert.equal(recipeShortage.inventoryAvailable, false)
    assert.equal(recipeShortage.effectiveIsAvailable, true)
})

test("inventory reconciliation jobs are gated, delayed, and deterministic", async () => {
    const payload = {
        businessId: "biz_test",
        reservationId: "irv_test",
        runAt: "2026-09-04T12:30:00.000Z",
    }
    assert.equal(isInventorySchedulersEnabled({}), false)
    assert.equal(buildInventoryReconciliationJobId(payload), buildInventoryReconciliationJobId(payload))

    const calls = []
    const result = await enqueueInventoryReservationReconciliation(payload, {
        env: { BULLMQ_INVENTORY_SCHEDULERS_ENABLED: "true" },
        now: new Date("2026-09-04T12:00:00.000Z"),
        queue: {
            async add(...args) {
                calls.push(args)
                return { id: args[2].jobId }
            },
        },
    })
    assert.equal(result.queued, true)
    assert.equal(result.delay, STRIPE_INVENTORY_HOLD_LIFETIME_MS)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][2].attempts, 5)
})

test("repair replays the exact Stripe request and releases only provider-confirmed expiry", async () => {
    const reservation = reservationInput({ stripeSessionId: null })
    const pending = {
        _id: reservation.pendingCheckoutId,
        businessId: reservation.businessId,
        inventoryReservationId: reservation.reservationId,
        stripeRequestSnapshot: { mode: "payment", line_items: [{ quantity: 1 }] },
        stripeRequestIdempotencyKey: "stripe-request-test",
    }
    const calls = { creates: [], releases: [] }
    const result = await reconcileInventoryReservation({
        businessId: reservation.businessId,
        reservationId: reservation.reservationId,
    }, {
        InventoryReservationModel: { findOne: async () => reservation },
        PendingCheckoutModel: { findOne: async () => pending },
        stripeClient: {
            checkout: {
                sessions: {
                    async create(config, options) {
                        calls.creates.push({ config, options })
                        return { id: "cs_open", status: "open", url: "https://stripe.test/open" }
                    },
                },
            },
        },
        persistLink: async () => ({}),
        releaseReservation: async (command) => {
            calls.releases.push(command)
            return { changed: true }
        },
    })
    assert.equal(result.providerState, "open")
    assert.deepEqual(calls.creates[0].config, pending.stripeRequestSnapshot)
    assert.equal(calls.creates[0].options.idempotencyKey, pending.stripeRequestIdempotencyKey)
    assert.equal(calls.releases.length, 0)

    reservation.stripeSessionId = "cs_expired"
    const expired = await reconcileInventoryReservation({
        businessId: reservation.businessId,
        reservationId: reservation.reservationId,
    }, {
        InventoryReservationModel: { findOne: async () => reservation },
        PendingCheckoutModel: { findOne: async () => pending },
        stripeClient: {
            checkout: { sessions: { retrieve: async () => ({ id: "cs_expired", status: "expired" }) } },
        },
        persistLink: async () => ({}),
        releaseReservation: async (command) => {
            calls.releases.push(command)
            return { changed: true }
        },
        invalidateMenu: async () => {},
    })
    assert.equal(expired.released, true)
    assert.equal(
        calls.releases.at(-1).releaseEvidence,
        INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_VERIFIED_EXPIRED,
    )
})

test("Phase 4 source ordering reserves before Stripe and retains the canonical reservation service", async () => {
    const payment = await readFile(new URL("../src/controllers/paymentController.js", import.meta.url), "utf8")
    const offline = await readFile(new URL("../src/controllers/orderController.js", import.meta.url), "utf8")
    const waitstaff = await readFile(
        new URL("../src/controllers/waitstaffOrdersController.js", import.meta.url),
        "utf8",
    )
    const webhook = await readFile(new URL("../src/controllers/webhookController.js", import.meta.url), "utf8")
    const reservation = await readFile(
        new URL("../src/services/inventoryReservationService.js", import.meta.url),
        "utf8",
    )
    const transactionCall = payment.indexOf("pending = await withCanonicalInventoryTransaction")
    const stripeCall = payment.indexOf("stripeClient.checkout.sessions.create")
    assert.ok(transactionCall >= 0 && stripeCall > transactionCall)
    assert.ok(payment.indexOf("await invalidateMenuItems(businessIdToUse)") > transactionCall)
    assert.ok(
        offline.indexOf("await invalidateMenuItems(businessId)") >
        offline.indexOf("saved = await withCanonicalInventoryTransaction"),
    )
    assert.ok(
        waitstaff.indexOf("await invalidateMenuItems(businessId)") >
        waitstaff.indexOf("saved = await withCanonicalInventoryTransaction"),
    )
    assert.match(webhook, /finalizePaidOrderWithInventory/)
    assert.match(reservation, /reserveInventoryForSource/)
})
