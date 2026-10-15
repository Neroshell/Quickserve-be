import assert from "node:assert/strict"
import test from "node:test"
import mongoose from "mongoose"

import Business from "../src/models/Business.js"
import CustomerJourney from "../src/models/CustomerJourney.js"
import GuestSession from "../src/models/GuestSession.js"
import InventoryItem from "../src/models/InventoryItem.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import InventoryPaymentException from "../src/models/InventoryPaymentException.js"
import InventoryReservation from "../src/models/InventoryReservation.js"
import MenuInventoryRecipe from "../src/models/MenuInventoryRecipe.js"
import MenuItem from "../src/models/menuItem.js"
import Order from "../src/models/order.js"
import PendingCheckout from "../src/models/PendingCheckout.js"
import Plan from "../src/models/Plan.js"
import ServicePoint from "../src/models/ServicePoint.js"
import {
    INVENTORY_RESERVATION_RELEASE_EVIDENCE,
    INVENTORY_RESERVATION_SOURCE_TYPES,
    INVENTORY_RESERVATION_STATUSES,
    STRIPE_INVENTORY_HOLD_LIFETIME_MS,
} from "../src/constants/inventoryReservation.js"
import {
    buildInventoryRequestFingerprint,
    recordInventoryPaymentException,
    releaseInventoryReservation,
    reserveInventoryForSource,
    resolveInventoryRequirements,
} from "../src/services/inventoryReservationService.js"
import { withCanonicalInventoryTransaction } from "../src/services/canonicalInventoryService.js"
import { finalizePaidOrderWithInventory } from "../src/services/paidOrderInventoryService.js"
import { reconcileInventoryReservation } from "../src/services/inventoryReservationRepairService.js"

const uri = process.env.INVENTORY_TEST_MONGODB_URI
const businessId = "biz_phase4"

function alwaysOpenOperatingHours() {
    return Object.fromEntries([
        "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    ].map((day) => [day, {
        enabled: true,
        openTime: "00:00",
        closeTime: "00:00",
    }]))
}

async function clearDatabase() {
    await Promise.all([
        Business.collection.deleteMany({}),
        CustomerJourney.collection.deleteMany({}),
        GuestSession.collection.deleteMany({}),
        InventoryMovement.collection.deleteMany({}),
        InventoryPaymentException.collection.deleteMany({}),
        InventoryReservation.collection.deleteMany({}),
        MenuInventoryRecipe.collection.deleteMany({}),
        MenuItem.collection.deleteMany({}),
        Order.collection.deleteMany({}),
        PendingCheckout.collection.deleteMany({}),
        Plan.collection.deleteMany({}),
        ServicePoint.collection.deleteMany({}),
        InventoryItem.collection.deleteMany({}),
    ])
}

function inventoryInput({
    inventoryItemId,
    name = inventoryItemId,
    onHandQuantity,
    trackingUnit = "piece",
    tenant = businessId,
}) {
    return {
        inventoryItemId,
        businessId: tenant,
        name,
        trackingUnit,
        baseUnitDimension: ["g"].includes(trackingUnit)
            ? "weight"
            : ["ml"].includes(trackingUnit)
                ? "volume"
                : "count",
        onHandQuantity,
        reservedQuantity: 0,
        lowStockThreshold: 0,
        isActive: true,
    }
}

function menuInput({ name, tenant = businessId, trackStock = false, stockQuantity = null }) {
    return {
        businessId: tenant,
        name,
        description: "",
        price: 10,
        prepTimeMinutes: 5,
        category: "mains",
        type: "food",
        isAvailable: true,
        manualIsAvailable: true,
        trackStock,
        stockQuantity,
    }
}

async function createMappedMenu({ name, mode, components, tenant = businessId }) {
    const menuItem = await MenuItem.create(menuInput({
        name,
        tenant,
        trackStock: mode === "simple",
        stockQuantity: mode === "simple" ? 0 : null,
    }))
    const mapping = await MenuInventoryRecipe.create({
        menuInventoryRecipeId: `mir_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        businessId: tenant,
        menuItemId: menuItem._id,
        mode,
        status: "active",
        version: 1,
        components,
    })
    return { menuItem, mapping }
}

let requestLineSequence = 0
function requestItem(menuItem, quantity = 1) {
    requestLineSequence += 1
    return {
        orderLineId: `phase4-line-${requestLineSequence}`,
        menuItemId: menuItem._id,
        itemName: menuItem.name,
        quantity,
        fulfillmentStation: "kitchen",
        fulfillmentBehavior: "prepared",
    }
}

async function reserve({
    items,
    key,
    sourceType = INVENTORY_RESERVATION_SOURCE_TYPES.OFFLINE_ORDER,
    status = INVENTORY_RESERVATION_STATUSES.COMMITTED,
    pendingCheckoutId = null,
    orderId = `ord_${key}`,
    dependencies,
}) {
    const requestFingerprint = buildInventoryRequestFingerprint({
        businessId,
        items: items.map(({ menuItemId, itemName, quantity }) => ({
            menuItemId: String(menuItemId),
            itemName,
            quantity,
        })),
    })
    return withCanonicalInventoryTransaction((session) => reserveInventoryForSource({
        businessId,
        items,
        sourceType,
        sourceId: orderId,
        orderId,
        pendingCheckoutId,
        status,
        expiresAt: sourceType === INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT
            ? new Date(Date.now() + STRIPE_INVENTORY_HOLD_LIFETIME_MS)
            : null,
        reservationId: `irv_${key}`,
        idempotencyKey: `inventory:${key}`,
        requestFingerprint,
        session,
    }, dependencies))
}

function responseRecorder() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this },
        json(body) { this.body = body; return this },
        send(body) { this.body = body; return this },
    }
}

async function setupCheckoutRestaurant({ menuName, inventoryItemId, onHandQuantity = 1 }) {
    await Plan.create({
        name: "Basic Phase 4",
        slug: "basic",
        level: 1,
        commissionPercentage: 2,
        offlineCommissionRate: 2,
        monthlyPrice: 0,
    })
    await Business.create({
        businessId,
        name: "Phase 4 Restaurant",
        displayName: "Phase 4 Restaurant",
        slug: "phase-4-restaurant",
        status: "active",
        billingStatus: "active",
        operatingHours: alwaysOpenOperatingHours(),
        businessType: "restaurant",
        currentPlan: "basic",
        currency: "EUR",
        stripeAccountId: "acct_phase4",
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
        defaultPaymentMethodId: "pm_phase4",
        paymentPreferences: { acceptOnlinePayments: true },
        orderingPreferences: { dineInEnabled: true },
    })
    await ServicePoint.create({
        servicePointId: "sp_phase4",
        businessId,
        label: "Table 4",
        code: "T4",
        servicePointType: "table",
        isActive: true,
    })
    await GuestSession.create({
        businessId,
        servicePointId: "sp_phase4",
        token: "guest-phase4-checkout-token",
        boundSessionId: null,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    await InventoryItem.create(inventoryInput({ inventoryItemId, onHandQuantity }))
    return createMappedMenu({
        name: menuName,
        mode: "simple",
        components: [{
            inventoryItemId,
            quantity: 1,
            unit: "piece",
            canonicalQuantity: 1,
        }],
    })
}

function checkoutRequest({
    idempotencyKey,
    menuName,
    stripeClient,
    enqueueInventoryReservationReconciliation = async () => ({ queued: false }),
}) {
    return {
        body: {
            servicePointId: "sp_phase4",
            sessionId: `session_${idempotencyKey}`,
            tableSessionToken: "guest-phase4-checkout-token",
            orderType: "dine-in",
            items: [{ itemName: menuName, quantity: 1 }],
        },
        headers: { "idempotency-key": idempotencyKey },
        get(name) { return this.headers[name.toLowerCase()] },
        session: { user: { id: "owner_phase4", role: "owner", businessId } },
        app: {
            locals: {
                stripe: stripeClient,
                enqueueInventoryReservationReconciliation,
            },
        },
    }
}

test("Phase 4 reservations are atomic under a real replica set", {
    skip: uri ? false : "Set INVENTORY_TEST_MONGODB_URI to a disposable replica-set MongoDB URI",
}, async (t) => {
    await mongoose.connect(uri, { dbName: `quickserve_inventory_phase4_${Date.now()}` })
    try {
        await Promise.all([
            Business.syncIndexes(),
            CustomerJourney.syncIndexes(),
            GuestSession.syncIndexes(),
            InventoryItem.syncIndexes(),
            InventoryMovement.syncIndexes(),
            InventoryPaymentException.syncIndexes(),
            InventoryReservation.syncIndexes(),
            MenuInventoryRecipe.syncIndexes(),
            MenuItem.syncIndexes(),
            Order.syncIndexes(),
            PendingCheckout.syncIndexes(),
            Plan.syncIndexes(),
            ServicePoint.syncIndexes(),
        ])

        await t.test("two last-portion attempts create exactly one reservation", async () => {
            await clearDatabase()
            await InventoryItem.create(inventoryInput({
                inventoryItemId: "inv_last_portion",
                onHandQuantity: 1,
                trackingUnit: "portion",
            }))
            const { menuItem } = await createMappedMenu({
                name: "Last Portion",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_last_portion",
                    quantity: 1,
                    unit: "portion",
                    canonicalQuantity: 1,
                }],
            })

            const attempts = await Promise.allSettled([
                reserve({ items: [requestItem(menuItem)], key: "last_a" }),
                reserve({ items: [requestItem(menuItem)], key: "last_b" }),
            ])
            assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1)
            assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1)
            assert.equal(attempts.find(({ status }) => status === "rejected").reason.code, "INSUFFICIENT_STOCK")

            const inventory = await InventoryItem.findOne({ inventoryItemId: "inv_last_portion" }).lean()
            assert.equal(inventory.onHandQuantity, 1)
            assert.equal(inventory.reservedQuantity, 1)
            assert.equal(await InventoryReservation.countDocuments({}), 1)
            assert.equal(await InventoryMovement.countDocuments({ type: "RESERVE" }), 1)
        })

        await t.test("shared recipe ingredients are frozen as non-reserving usage snapshots", async () => {
            await clearDatabase()
            await InventoryItem.create(inventoryInput({
                inventoryItemId: "inv_shared_flour",
                onHandQuantity: 20,
                trackingUnit: "g",
            }))
            const first = await createMappedMenu({
                name: "Flour Item A",
                mode: "recipe",
                components: [{
                    inventoryItemId: "inv_shared_flour",
                    quantity: 2,
                    unit: "g",
                    canonicalQuantity: 2,
                }],
            })
            const second = await createMappedMenu({
                name: "Flour Item B",
                mode: "recipe",
                components: [{
                    inventoryItemId: "inv_shared_flour",
                    quantity: 3,
                    unit: "g",
                    canonicalQuantity: 3,
                }],
            })
            const result = await reserve({
                key: "shared_recipe",
                items: [requestItem(first.menuItem, 2), requestItem(second.menuItem, 1)],
            })
            assert.deepEqual(result.reservation.components, [])
            assert.equal(
                result.reservation.sidecarAllocations.reduce(
                    (total, allocation) => total + allocation.canonicalQuantity,
                    0,
                ),
                7,
            )
            const inventory = await InventoryItem.findOne({ inventoryItemId: "inv_shared_flour" }).lean()
            assert.equal(inventory.onHandQuantity, 20)
            assert.equal(inventory.reservedQuantity, 0)
        })

        await t.test("different MenuItems do not contend for one shared recipe ingredient", async () => {
            await clearDatabase()
            await InventoryItem.create(inventoryInput({
                inventoryItemId: "inv_shared_contention",
                onHandQuantity: 1,
            }))
            const first = await createMappedMenu({
                name: "Shared Contention A",
                mode: "recipe",
                components: [{
                    inventoryItemId: "inv_shared_contention",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            const second = await createMappedMenu({
                name: "Shared Contention B",
                mode: "recipe",
                components: [{
                    inventoryItemId: "inv_shared_contention",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })

            const attempts = await Promise.allSettled([
                reserve({ items: [requestItem(first.menuItem)], key: "shared_contention_a" }),
                reserve({ items: [requestItem(second.menuItem)], key: "shared_contention_b" }),
            ])
            assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 2)
            assert.equal(attempts.filter(({ status }) => status === "rejected").length, 0)
            assert.equal((await InventoryItem.findOne({
                inventoryItemId: "inv_shared_contention",
            })).reservedQuantity, 0)
        })

        await t.test("recipe shortages remain orderable while Simple Stock movement failures roll back every write", async () => {
            await clearDatabase()
            await InventoryItem.create([
                inventoryInput({ inventoryItemId: "inv_atomic_a", onHandQuantity: 5 }),
                inventoryInput({ inventoryItemId: "inv_atomic_b", onHandQuantity: 1 }),
            ])
            const shortage = await createMappedMenu({
                name: "Atomic Shortage",
                mode: "recipe",
                components: [
                    { inventoryItemId: "inv_atomic_a", quantity: 2, unit: "piece", canonicalQuantity: 2 },
                    { inventoryItemId: "inv_atomic_b", quantity: 2, unit: "piece", canonicalQuantity: 2 },
                ],
            })
            const recipeOrder = await reserve({
                items: [requestItem(shortage.menuItem)],
                key: "atomic_shortage",
            })
            assert.deepEqual(recipeOrder.reservation.components, [])
            assert.equal(recipeOrder.reservation.sidecarAllocations.length, 2)
            assert.deepEqual(
                (await InventoryItem.find({}).sort({ inventoryItemId: 1 }).lean())
                    .map(({ reservedQuantity }) => reservedQuantity),
                [0, 0],
            )
            assert.equal(await InventoryMovement.countDocuments({}), 0)

            await clearDatabase()
            await InventoryItem.create([
                inventoryInput({ inventoryItemId: "inv_atomic_simple_a", onHandQuantity: 5 }),
                inventoryInput({ inventoryItemId: "inv_atomic_simple_b", onHandQuantity: 5 }),
            ])
            const simpleA = await createMappedMenu({
                name: "Atomic Simple A",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_atomic_simple_a",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            const simpleB = await createMappedMenu({
                name: "Atomic Simple B",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_atomic_simple_b",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            let movementWrites = 0
            await assert.rejects(
                reserve({
                    items: [requestItem(simpleA.menuItem), requestItem(simpleB.menuItem)],
                    key: "atomic_injected",
                    dependencies: {
                        InventoryMovementModel: {
                            async create(documents, options) {
                                movementWrites += 1
                                if (movementWrites === 2) throw new Error("injected movement failure")
                                return InventoryMovement.create(documents, options)
                            },
                        },
                    },
                }),
                /injected movement failure/,
            )
            assert.deepEqual(
                (await InventoryItem.find({}).sort({ inventoryItemId: 1 }).lean())
                    .map(({ reservedQuantity }) => reservedQuantity),
                [0, 0],
            )
            assert.equal(await InventoryMovement.countDocuments({}), 0)
            assert.equal(await InventoryReservation.countDocuments({}), 0)
        })

        await t.test("idempotency, tenant isolation, manual availability, and untracked bypass fail safely", async () => {
            await clearDatabase()
            await InventoryItem.create(inventoryInput({ inventoryItemId: "inv_idempotent", onHandQuantity: 4 }))
            const mapped = await createMappedMenu({
                name: "Idempotent Item",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_idempotent",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            const first = await reserve({ items: [requestItem(mapped.menuItem, 2)], key: "same_key" })
            const replay = await reserve({ items: [requestItem(mapped.menuItem, 2)], key: "same_key" })
            assert.equal(first.replayed, false)
            assert.equal(replay.replayed, true)
            assert.equal((await InventoryItem.findOne({ inventoryItemId: "inv_idempotent" })).reservedQuantity, 2)
            assert.equal(await InventoryMovement.countDocuments({ type: "RESERVE" }), 1)

            await assert.rejects(
                reserve({ items: [requestItem(mapped.menuItem, 1)], key: "same_key" }),
                (error) => error.code === "INVENTORY_IDEMPOTENCY_CONFLICT",
            )

            mapped.menuItem.manualIsAvailable = false
            await mapped.menuItem.save()
            const manual = await resolveInventoryRequirements({
                businessId,
                items: [requestItem(mapped.menuItem)],
            })
            assert.equal(manual.failures[0].reason, "MANUALLY_UNAVAILABLE")

            const untracked = await MenuItem.create(menuInput({ name: "Untracked Item" }))
            const bypass = await reserve({ items: [requestItem(untracked)], key: "untracked" })
            assert.equal(bypass.tracked, false)
            assert.equal(bypass.reservation, null)

            await InventoryItem.create(inventoryInput({
                inventoryItemId: "inv_other_tenant",
                onHandQuantity: 10,
                tenant: "biz_other",
            }))
            const broken = await createMappedMenu({
                name: "Broken Tenant Mapping",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_other_tenant",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            const brokenResolution = await resolveInventoryRequirements({
                businessId,
                items: [requestItem(broken.menuItem)],
            })
            assert.equal(brokenResolution.failures[0].reason, "MISSING_CANONICAL_INVENTORY_ITEM")
        })

        await t.test("pre-fulfilment release is exact and Stripe release requires provider evidence", async () => {
            await clearDatabase()
            await InventoryItem.create(inventoryInput({ inventoryItemId: "inv_release", onHandQuantity: 3 }))
            const mapped = await createMappedMenu({
                name: "Release Item",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_release",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            const committed = await reserve({ items: [requestItem(mapped.menuItem, 2)], key: "release_order" })
            const released = await releaseInventoryReservation({
                businessId,
                reservationId: committed.reservation.reservationId,
                releaseEvidence: INVENTORY_RESERVATION_RELEASE_EVIDENCE.ORDER_CANCELLED_BEFORE_FULFILMENT,
            })
            assert.equal(released.changed, true)
            assert.equal((await InventoryItem.findOne({ inventoryItemId: "inv_release" })).reservedQuantity, 0)
            assert.equal((await InventoryItem.findOne({ inventoryItemId: "inv_release" })).onHandQuantity, 3)
            assert.equal((await releaseInventoryReservation({
                businessId,
                reservationId: committed.reservation.reservationId,
                releaseEvidence: INVENTORY_RESERVATION_RELEASE_EVIDENCE.ORDER_CANCELLED_BEFORE_FULFILMENT,
            })).changed, false)

            const pendingId = new mongoose.Types.ObjectId()
            const held = await reserve({
                items: [requestItem(mapped.menuItem)],
                key: "stripe_hold",
                sourceType: INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT,
                status: INVENTORY_RESERVATION_STATUSES.HELD,
                pendingCheckoutId: pendingId,
            })
            await assert.rejects(
                releaseInventoryReservation({
                    businessId,
                    reservationId: held.reservation.reservationId,
                    releaseEvidence: INVENTORY_RESERVATION_RELEASE_EVIDENCE.ORDER_CANCELLED_BEFORE_FULFILMENT,
                }),
                (error) => error.code === "STRIPE_RELEASE_EVIDENCE_REQUIRED",
            )
            const expired = await releaseInventoryReservation({
                businessId,
                reservationId: held.reservation.reservationId,
                expectedStripeSessionId: "cs_expired",
                releaseEvidence: INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_EXPIRED_EVENT,
            })
            assert.equal(expired.reservation.status, INVENTORY_RESERVATION_STATUSES.EXPIRED)
            assert.equal((await InventoryItem.findOne({ inventoryItemId: "inv_release" })).reservedQuantity, 0)
            assert.equal(await InventoryMovement.countDocuments({ type: "RELEASE" }), 2)
        })

        await t.test("paid webhook finalization commits the existing hold without rechecking or consuming", async () => {
            await clearDatabase()
            await InventoryItem.create(inventoryInput({ inventoryItemId: "inv_paid", onHandQuantity: 1 }))
            const mapped = await createMappedMenu({
                name: "Paid Item",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_paid",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            const pendingId = new mongoose.Types.ObjectId()
            const orderId = "ord_paid_hold"
            const item = requestItem(mapped.menuItem)
            const held = await reserve({
                items: [item],
                key: "paid_hold",
                sourceType: INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT,
                status: INVENTORY_RESERVATION_STATUSES.HELD,
                pendingCheckoutId: pendingId,
                orderId,
            })
            await PendingCheckout.create({
                _id: pendingId,
                businessId,
                orderId,
                servicePointId: "sp_phase4",
                servicePointLabel: "sp_paid",
                sessionId: "session_paid",
                items: [{ ...item, lineTotal: 10 }],
                total: 10,
                grossAmount: 1000,
                currency: "EUR",
                status: "open",
                inventoryReservationId: held.reservation.reservationId,
                stripeSessionId: "cs_paid",
            })
            const orderInput = {
                businessId,
                orderId,
                servicePointId: "sp_phase4",
                servicePointLabel: "sp_paid",
                sessionId: "session_paid",
                items: [{ ...item, lineTotal: 10 }],
                total: 10,
                currency: "EUR",
                paymentChannel: "online",
                paymentStatus: "paid",
                paidVia: "online_card",
                paidAt: new Date(),
                stripeSessionId: "cs_paid",
            }
            const first = await finalizePaidOrderWithInventory({
                businessId,
                pendingCheckoutId: pendingId,
                inventoryReservationId: held.reservation.reservationId,
                stripeSessionId: "cs_paid",
                orderId,
                orderInput,
            })
            const replay = await finalizePaidOrderWithInventory({
                businessId,
                pendingCheckoutId: pendingId,
                inventoryReservationId: held.reservation.reservationId,
                stripeSessionId: "cs_paid",
                orderId,
                orderInput: { ...orderInput, createdAt: new Date(0), paidAt: new Date(0) },
            })
            assert.equal(first.created, true)
            assert.equal(replay.created, false)
            assert.equal(await Order.countDocuments({ businessId, orderId }), 1)
            const inventory = await InventoryItem.findOne({ inventoryItemId: "inv_paid" }).lean()
            assert.equal(inventory.onHandQuantity, 1)
            assert.equal(inventory.reservedQuantity, 1)
            assert.equal(await InventoryMovement.countDocuments({ type: "CONSUME" }), 0)
            assert.equal((await InventoryReservation.findOne({ reservationId: held.reservation.reservationId })).status, "committed")
        })

        await t.test("paid-after-release becomes a durable exception and never a normal order", async () => {
            await clearDatabase()
            await InventoryItem.create(inventoryInput({ inventoryItemId: "inv_exception", onHandQuantity: 1 }))
            const mapped = await createMappedMenu({
                name: "Exception Item",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_exception",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            const pendingId = new mongoose.Types.ObjectId()
            const orderId = "ord_paid_exception"
            const held = await reserve({
                items: [requestItem(mapped.menuItem)],
                key: "paid_exception",
                sourceType: INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT,
                status: INVENTORY_RESERVATION_STATUSES.HELD,
                pendingCheckoutId: pendingId,
                orderId,
            })
            await PendingCheckout.create({
                _id: pendingId,
                businessId,
                orderId,
                servicePointId: "sp_phase4",
                servicePointLabel: "sp_exception",
                sessionId: "session_exception",
                items: [{ ...requestItem(mapped.menuItem), lineTotal: 10 }],
                total: 10,
                currency: "EUR",
                status: "expired",
                inventoryReservationId: held.reservation.reservationId,
                stripeSessionId: "cs_exception",
            })
            await releaseInventoryReservation({
                businessId,
                reservationId: held.reservation.reservationId,
                expectedStripeSessionId: "cs_exception",
                releaseEvidence: INVENTORY_RESERVATION_RELEASE_EVIDENCE.STRIPE_EXPIRED_EVENT,
            })
            await assert.rejects(
                finalizePaidOrderWithInventory({
                    businessId,
                    pendingCheckoutId: pendingId,
                    inventoryReservationId: held.reservation.reservationId,
                    stripeSessionId: "cs_exception",
                    orderId,
                    orderInput: {
                        businessId,
                        orderId,
                        servicePointId: "sp_phase4",
                        servicePointLabel: "sp_exception",
                        items: [{ ...requestItem(mapped.menuItem), lineTotal: 10 }],
                    },
                }),
                (error) => error.code === "PAID_CHECKOUT_INVENTORY_RELEASED",
            )
            await recordInventoryPaymentException({
                businessId,
                orderId,
                pendingCheckoutId: pendingId,
                inventoryReservationId: held.reservation.reservationId,
                stripeSessionId: "cs_exception",
                stripeEventId: "evt_exception",
                reasonCode: "PAID_CHECKOUT_INVENTORY_RELEASED",
            })
            assert.equal(await Order.countDocuments({ businessId, orderId }), 0)
            assert.equal(await InventoryPaymentException.countDocuments({ businessId, status: "open" }), 1)
        })

        await t.test("checkout.session.expired releases once and duplicate paid webhooks commit once", async () => {
            await clearDatabase()
            const { handleStripeWebhook } = await import("../src/controllers/webhookController.js")
            await InventoryItem.create(inventoryInput({ inventoryItemId: "inv_expiry", onHandQuantity: 1 }))
            const expiryMapped = await createMappedMenu({
                name: "Expiry Item",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_expiry",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            const expiryPendingId = new mongoose.Types.ObjectId()
            const expiryOrderId = "ord_expiry_event"
            const expiryHold = await reserve({
                items: [requestItem(expiryMapped.menuItem)],
                key: "expiry_event",
                sourceType: INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT,
                status: INVENTORY_RESERVATION_STATUSES.HELD,
                pendingCheckoutId: expiryPendingId,
                orderId: expiryOrderId,
            })
            await InventoryReservation.updateOne(
                { reservationId: expiryHold.reservation.reservationId },
                { $set: { stripeSessionId: "cs_expiry_event", providerState: "open" } },
            )
            await PendingCheckout.create({
                _id: expiryPendingId,
                businessId,
                orderId: expiryOrderId,
                servicePointId: "sp_phase4",
                servicePointLabel: "sp_expiry",
                sessionId: "session_expiry",
                items: [{ ...requestItem(expiryMapped.menuItem), lineTotal: 10 }],
                total: 10,
                grossAmount: 1000,
                currency: "EUR",
                status: "open",
                inventoryReservationId: expiryHold.reservation.reservationId,
                stripeSessionId: "cs_expiry_event",
            })
            const expiryEvent = {
                id: "evt_expiry_event",
                type: "checkout.session.expired",
                data: {
                    object: {
                        id: "cs_expiry_event",
                        status: "expired",
                        expires_at: Math.floor(Date.now() / 1000),
                        metadata: {
                            pendingCheckoutId: expiryPendingId.toString(),
                            inventoryReservationId: expiryHold.reservation.reservationId,
                            businessId,
                            orderId: expiryOrderId,
                        },
                    },
                },
            }
            for (let delivery = 0; delivery < 2; delivery += 1) {
                const response = responseRecorder()
                await handleStripeWebhook({
                    stripeWebhookEvent: { ...expiryEvent, id: `${expiryEvent.id}_${delivery}` },
                    headers: {},
                    app: { locals: {} },
                }, response)
                assert.equal(response.statusCode, 200)
            }
            assert.equal((await InventoryItem.findOne({ inventoryItemId: "inv_expiry" })).reservedQuantity, 0)
            assert.equal(await InventoryMovement.countDocuments({ type: "RELEASE" }), 1)
            assert.equal((await PendingCheckout.findById(expiryPendingId)).status, "expired")

            await clearDatabase()
            await InventoryItem.create(inventoryInput({ inventoryItemId: "inv_webhook_paid", onHandQuantity: 1 }))
            const paidMapped = await createMappedMenu({
                name: "Webhook Paid Item",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_webhook_paid",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            const paidPendingId = new mongoose.Types.ObjectId()
            const paidOrderId = "ord_webhook_paid"
            const paidHold = await reserve({
                items: [requestItem(paidMapped.menuItem)],
                key: "webhook_paid",
                sourceType: INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT,
                status: INVENTORY_RESERVATION_STATUSES.HELD,
                pendingCheckoutId: paidPendingId,
                orderId: paidOrderId,
            })
            await InventoryReservation.updateOne(
                { reservationId: paidHold.reservation.reservationId },
                { $set: { stripeSessionId: "cs_webhook_paid", providerState: "open" } },
            )
            await PendingCheckout.create({
                _id: paidPendingId,
                businessId,
                orderId: paidOrderId,
                servicePointId: "sp_phase4",
                servicePointLabel: "sp_paid",
                displayLabel: "Table Paid",
                sessionId: "session_paid",
                items: [{
                    ...requestItem(paidMapped.menuItem),
                    lineTotal: 10,
                    type: "food",
                    category: "mains",
                }],
                subtotal: 10,
                total: 10,
                grossAmount: 1000,
                currency: "EUR",
                status: "open",
                inventoryReservationId: paidHold.reservation.reservationId,
                stripeSessionId: "cs_webhook_paid",
            })
            const paidEvent = {
                id: "evt_webhook_paid",
                type: "checkout.session.completed",
                data: {
                    object: {
                        id: "cs_webhook_paid",
                        status: "complete",
                        payment_status: "paid",
                        amount_total: 1000,
                        currency: "eur",
                        payment_intent: "pi_webhook_paid",
                        metadata: {
                            pendingCheckoutId: paidPendingId.toString(),
                            inventoryReservationId: paidHold.reservation.reservationId,
                            businessId,
                            orderId: paidOrderId,
                        },
                    },
                },
            }
            for (let delivery = 0; delivery < 2; delivery += 1) {
                const response = responseRecorder()
                await handleStripeWebhook({
                    stripeWebhookEvent: { ...paidEvent, id: `${paidEvent.id}_${delivery}` },
                    headers: {},
                    app: { locals: {} },
                }, response)
                assert.equal(response.statusCode, 200)
            }
            assert.equal(await Order.countDocuments({ orderId: paidOrderId }), 1)
            const webhookOrder = await Order.findOne({ orderId: paidOrderId }).lean()
            assert.equal(webhookOrder.orderSource, "self")
            assert.equal(webhookOrder.createdBy, "customer")
            assert.equal(webhookOrder.createdByStaffId, null)
            assert.equal((await InventoryReservation.findOne({ reservationId: paidHold.reservation.reservationId })).status, "committed")
            const paidInventory = await InventoryItem.findOne({ inventoryItemId: "inv_webhook_paid" }).lean()
            assert.equal(paidInventory.onHandQuantity, 1)
            assert.equal(paidInventory.reservedQuantity, 1)
            assert.equal(await InventoryMovement.countDocuments({ type: "RESERVE" }), 1)
            assert.equal(await InventoryMovement.countDocuments({ type: "CONSUME" }), 0)
        })

        await t.test("offline customer order and waitstaff order create committed reservations atomically", async () => {
            await clearDatabase()
            const offlineMapped = await setupCheckoutRestaurant({
                menuName: "Offline Reserved Item",
                inventoryItemId: "inv_offline_order",
            })
            await GuestSession.create({
                businessId,
                servicePointId: "sp_phase4",
                token: "guest-phase4-token",
                boundSessionId: null,
                expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            })
            const { createOrder } = await import("../src/controllers/orderController.js")
            const offlineResponse = responseRecorder()
            await createOrder({
                body: {
                    servicePointId: "sp_phase4",
                    servicePointLabel: "sp_phase4",
                    sessionId: "guest-device-phase4",
                    tableSessionToken: "guest-phase4-token",
                    orderType: "dine-in",
                    items: [{ itemName: offlineMapped.menuItem.name, quantity: 1 }],
                },
                headers: { "idempotency-key": "offline-phase4" },
                get(name) { return this.headers[name.toLowerCase()] },
                session: {},
            }, offlineResponse)
            assert.equal(offlineResponse.statusCode, 201, JSON.stringify(offlineResponse.body))
            let order = await Order.findOne({ orderId: offlineResponse.body.orderId }).lean()
            let reservation = await InventoryReservation.findOne({
                reservationId: order.inventoryReservationId,
            }).lean()
            assert.equal(reservation.sourceType, INVENTORY_RESERVATION_SOURCE_TYPES.OFFLINE_ORDER)
            assert.equal(reservation.status, INVENTORY_RESERVATION_STATUSES.COMMITTED)
            assert.equal((await InventoryItem.findOne({ inventoryItemId: "inv_offline_order" })).reservedQuantity, 1)

            await clearDatabase()
            const waitstaffMapped = await setupCheckoutRestaurant({
                menuName: "Waitstaff Reserved Item",
                inventoryItemId: "inv_waitstaff_order",
            })
            const {
                cancelWaiterOrder,
                createWaiterOrder,
            } = await import("../src/controllers/waitstaffOrdersController.js")
            const staffSession = {
                user: {
                    id: "staff_phase4",
                    staffId: "staff_phase4",
                    name: "Phase 4 Waiter",
                    role: "waiter",
                    businessId,
                },
            }
            const waitstaffResponse = responseRecorder()
            await createWaiterOrder({
                body: {
                    servicePointId: "sp_phase4",
                    orderType: "dine-in",
                    items: [{ itemName: waitstaffMapped.menuItem.name, quantity: 1 }],
                },
                headers: { "idempotency-key": "waitstaff-phase4" },
                get(name) { return this.headers[name.toLowerCase()] },
                session: staffSession,
            }, waitstaffResponse)
            assert.equal(waitstaffResponse.statusCode, 201)
            order = await Order.findOne({ orderId: waitstaffResponse.body.orderId }).lean()
            reservation = await InventoryReservation.findOne({ reservationId: order.inventoryReservationId }).lean()
            assert.equal(order.createdByStaffId, "staff_phase4")
            assert.equal(reservation.sourceType, INVENTORY_RESERVATION_SOURCE_TYPES.WAITSTAFF_ORDER)
            assert.equal((await InventoryItem.findOne({ inventoryItemId: "inv_waitstaff_order" })).reservedQuantity, 1)

            const cancelResponse = responseRecorder()
            await cancelWaiterOrder({
                params: { orderId: order.orderId },
                session: staffSession,
            }, cancelResponse)
            assert.equal(cancelResponse.statusCode, 200)
            assert.equal((await Order.findOne({ orderId: order.orderId })).status, "cancelled")
            assert.equal((await InventoryReservation.findOne({ reservationId: reservation.reservationId })).status, "released")
            const inventory = await InventoryItem.findOne({ inventoryItemId: "inv_waitstaff_order" }).lean()
            assert.equal(inventory.onHandQuantity, 1)
            assert.equal(inventory.reservedQuantity, 0)

            for (const paymentMethod of ["cash", "pos_card"]) {
                await clearDatabase()
                const paymentFirstMapped = await setupCheckoutRestaurant({
                    menuName: `Waitstaff ${paymentMethod} Item`,
                    inventoryItemId: `inv_waitstaff_${paymentMethod}`,
                })
                const request = {
                    body: {
                        businessId: "spoofed-business",
                        createdByStaffId: "spoofed-staff",
                        paymentStatus: "paid",
                        paidVia: "online_card",
                        servicePointId: "sp_phase4",
                        servicePointLabel: "sp_phase4",
                        orderType: "dine-in",
                        paymentMethod,
                        items: [{ itemName: paymentFirstMapped.menuItem.name, quantity: 1 }],
                    },
                    headers: { "idempotency-key": `waitstaff-${paymentMethod}-phase4` },
                    get(name) { return this.headers[name.toLowerCase()] },
                    session: staffSession,
                }
                const first = responseRecorder()
                await createWaiterOrder(request, first)
                const retry = responseRecorder()
                await createWaiterOrder(request, retry)

                assert.equal(first.statusCode, 201)
                assert.equal(retry.statusCode, 200, JSON.stringify(retry.body))
                assert.equal(retry.body.replayed, true)
                assert.equal(await Order.countDocuments({ businessId }), 1)
                const paidOrder = await Order.findOne({ orderId: first.body.orderId }).lean()
                assert.equal(paidOrder.orderSource, "waitstaff")
                assert.equal(paidOrder.createdBy, "staff")
                assert.equal(paidOrder.createdByStaffId, "staff_phase4")
                assert.equal(paidOrder.paymentChannel, "offline")
                assert.equal(paidOrder.paymentStatus, "paid")
                assert.equal(paidOrder.paidVia, paymentMethod)
                assert.ok(paidOrder.paidAt instanceof Date)
                assert.equal(paidOrder.paidByStaffId, "staff_phase4")
                assert.equal(paidOrder.paidByName, "Phase 4 Waiter")
                assert.equal(paidOrder.items[0].fulfillmentStation, "kitchen")
                assert.equal(paidOrder.items[0].fulfillmentStatus, "pending")
                assert.equal(await InventoryReservation.countDocuments({ businessId }), 1)
                assert.equal(
                    (await InventoryItem.findOne({
                        inventoryItemId: `inv_waitstaff_${paymentMethod}`,
                    })).reservedQuantity,
                    1,
                )
                assert.equal(await InventoryMovement.countDocuments({
                    businessId,
                    type: "RESERVE",
                }), 1)
            }
        })

        await t.test("unavailable Checkout never calls Stripe and leaves no partial state", async () => {
            await clearDatabase()
            const mapped = await setupCheckoutRestaurant({
                menuName: "Unavailable Checkout Item",
                inventoryItemId: "inv_checkout_unavailable",
                onHandQuantity: 0,
            })
            const { createCheckoutSession } = await import("../src/controllers/paymentController.js")
            let stripeCalls = 0
            const response = responseRecorder()
            await createCheckoutSession(checkoutRequest({
                idempotencyKey: "checkout_unavailable",
                menuName: mapped.menuItem.name,
                stripeClient: {
                    checkout: {
                        sessions: {
                            async create() {
                                stripeCalls += 1
                                return { id: "must_not_exist" }
                            },
                        },
                    },
                },
            }), response)

            assert.equal(response.statusCode, 409)
            assert.equal(response.body.code, "INSUFFICIENT_STOCK")
            assert.equal(stripeCalls, 0)
            assert.equal(await PendingCheckout.countDocuments({}), 0)
            assert.equal(await InventoryReservation.countDocuments({}), 0)
            assert.equal(await InventoryMovement.countDocuments({}), 0)
        })

        await t.test("two actual Checkout attempts for one portion call Stripe exactly once", async () => {
            await clearDatabase()
            process.env.REDIS_URL = ""
            process.env.BULLMQ_INVENTORY_SCHEDULERS_ENABLED = "false"
            await Plan.create({
                name: "Basic Phase 4",
                slug: "basic",
                level: 1,
                commissionPercentage: 2,
                offlineCommissionRate: 2,
                monthlyPrice: 0,
            })
            await Business.create({
                businessId,
                name: "Phase 4 Restaurant",
                displayName: "Phase 4 Restaurant",
                slug: "phase-4-restaurant",
                status: "active",
                billingStatus: "active",
                operatingHours: alwaysOpenOperatingHours(),
                businessType: "restaurant",
                currentPlan: "basic",
                currency: "EUR",
                stripeAccountId: "acct_phase4",
                stripeChargesEnabled: true,
                stripePayoutsEnabled: true,
                paymentPreferences: { acceptOnlinePayments: true },
                orderingPreferences: { dineInEnabled: true },
            })
            await ServicePoint.create({
                servicePointId: "sp_phase4",
                businessId,
                label: "Table 4",
                code: "T4",
                servicePointType: "table",
                isActive: true,
            })
            await GuestSession.create({
                businessId,
                servicePointId: "sp_phase4",
                token: "guest-phase4-checkout-token",
                boundSessionId: "guest-device-phase4",
                expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            })
            await InventoryItem.create(inventoryInput({ inventoryItemId: "inv_checkout_last", onHandQuantity: 1 }))
            const mapped = await createMappedMenu({
                name: "Checkout Last Item",
                mode: "simple",
                components: [{
                    inventoryItemId: "inv_checkout_last",
                    quantity: 1,
                    unit: "piece",
                    canonicalQuantity: 1,
                }],
            })
            const { createCheckoutSession } = await import("../src/controllers/paymentController.js")
            let stripeCalls = 0
            let sawHoldBeforeStripe = false
            const stripeClient = {
                checkout: {
                    sessions: {
                        async create(config) {
                            stripeCalls += 1
                            const hold = await InventoryReservation.findOne({ status: "held" }).lean()
                            const inventory = await InventoryItem.findOne({
                                inventoryItemId: "inv_checkout_last",
                            }).lean()
                            sawHoldBeforeStripe = Boolean(hold) && inventory.reservedQuantity === 1
                            return {
                                id: `cs_phase4_${stripeCalls}`,
                                url: `https://stripe.test/${stripeCalls}`,
                                status: "open",
                                expires_at: config.expires_at,
                            }
                        },
                    },
                },
            }
            function request(idempotencyKey) {
                return {
                        body: {
                            servicePointId: "sp_phase4",
                        sessionId: "guest-device-phase4",
                        tableSessionToken: "guest-phase4-checkout-token",
                        orderType: "dine-in",
                        items: [{ itemName: mapped.menuItem.name, quantity: 1 }],
                    },
                    headers: { "idempotency-key": idempotencyKey },
                    get(name) { return this.headers[name.toLowerCase()] },
                    session: { user: { id: "owner_phase4", role: "owner", businessId } },
                    app: {
                        locals: {
                            stripe: stripeClient,
                            enqueueInventoryReservationReconciliation: async () => ({ queued: false }),
                        },
                    },
                }
            }
            const responses = [responseRecorder(), responseRecorder()]
            await Promise.all([
                createCheckoutSession(request("checkout_a"), responses[0]),
                createCheckoutSession(request("checkout_b"), responses[1]),
            ])
            assert.equal(stripeCalls, 1, JSON.stringify(responses))
            assert.equal(sawHoldBeforeStripe, true)
            assert.equal(responses.filter(({ statusCode }) => statusCode === 201).length, 1)
            assert.equal(
                responses.filter(({ statusCode }) => statusCode === 409).length,
                1,
                JSON.stringify(responses),
            )
            assert.equal(await PendingCheckout.countDocuments({}), 1)
            assert.equal(await InventoryReservation.countDocuments({ status: "held" }), 1)
        })

        await t.test("definitive Stripe creation failure atomically releases the hold", async () => {
            await clearDatabase()
            const mapped = await setupCheckoutRestaurant({
                menuName: "Definitive Failure Item",
                inventoryItemId: "inv_definitive_failure",
            })
            const { createCheckoutSession } = await import("../src/controllers/paymentController.js")
            const stripeError = new Error("invalid checkout request")
            stripeError.type = "StripeInvalidRequestError"
            const stripeClient = {
                checkout: { sessions: { create: async () => { throw stripeError } } },
            }
            const response = responseRecorder()
            await createCheckoutSession(checkoutRequest({
                idempotencyKey: "definitive_failure",
                menuName: mapped.menuItem.name,
                stripeClient,
            }), response)
            assert.equal(response.statusCode, 502)
            const pending = await PendingCheckout.findOne({}).lean()
            const reservation = await InventoryReservation.findOne({}).lean()
            const inventory = await InventoryItem.findOne({ inventoryItemId: "inv_definitive_failure" }).lean()
            assert.equal(pending.status, "creation_failed")
            assert.equal(reservation.status, "released")
            assert.equal(reservation.providerState, "creation_failed")
            assert.equal(inventory.onHandQuantity, 1)
            assert.equal(inventory.reservedQuantity, 0)
            assert.equal(await InventoryMovement.countDocuments({ type: "RESERVE" }), 1)
            assert.equal(await InventoryMovement.countDocuments({ type: "RELEASE" }), 1)
        })

        await t.test("BullMQ enqueue failure does not corrupt or block a committed Stripe hold", async () => {
            await clearDatabase()
            const mapped = await setupCheckoutRestaurant({
                menuName: "Queue Failure Item",
                inventoryItemId: "inv_queue_failure",
            })
            const { createCheckoutSession } = await import("../src/controllers/paymentController.js")
            let stripeCalls = 0
            const response = responseRecorder()
            await createCheckoutSession(checkoutRequest({
                idempotencyKey: "queue_failure",
                menuName: mapped.menuItem.name,
                stripeClient: {
                    checkout: {
                        sessions: {
                            async create(config) {
                                stripeCalls += 1
                                return {
                                    id: "cs_queue_failure",
                                    url: "https://stripe.test/queue-failure",
                                    status: "open",
                                    expires_at: config.expires_at,
                                }
                            },
                        },
                    },
                },
                enqueueInventoryReservationReconciliation: async () => {
                    throw new Error("Redis unavailable")
                },
            }), response)

            assert.equal(response.statusCode, 201)
            assert.equal(stripeCalls, 1)
            assert.equal((await PendingCheckout.findOne({})).status, "open")
            assert.equal((await InventoryReservation.findOne({})).status, "held")
            assert.equal((await InventoryItem.findOne({
                inventoryItemId: "inv_queue_failure",
            })).reservedQuantity, 1)
        })

        await t.test("indeterminate Stripe disconnect keeps the hold and replays the exact request", async () => {
            await clearDatabase()
            const mapped = await setupCheckoutRestaurant({
                menuName: "Disconnect Recovery Item",
                inventoryItemId: "inv_disconnect_recovery",
            })
            const { createCheckoutSession } = await import("../src/controllers/paymentController.js")
            const connectionError = new Error("connection reset after request")
            connectionError.type = "StripeConnectionError"
            const response = responseRecorder()
            await createCheckoutSession(checkoutRequest({
                idempotencyKey: "disconnect_recovery",
                menuName: mapped.menuItem.name,
                stripeClient: {
                    checkout: { sessions: { create: async () => { throw connectionError } } },
                },
            }), response)
            assert.equal(response.statusCode, 503)
            let pending = await PendingCheckout.findOne({})
            let reservation = await InventoryReservation.findOne({})
            assert.equal(pending.status, "provider_pending")
            assert.equal(reservation.status, "held")
            assert.equal((await InventoryItem.findOne({ inventoryItemId: "inv_disconnect_recovery" })).reservedQuantity, 1)

            const createCalls = []
            const repaired = await reconcileInventoryReservation({
                businessId,
                reservationId: reservation.reservationId,
            }, {
                stripeClient: {
                    checkout: {
                        sessions: {
                            async create(config, options) {
                                createCalls.push({ config, options })
                                return {
                                    id: "cs_recovered",
                                    url: "https://stripe.test/recovered",
                                    status: "open",
                                    expires_at: Math.floor(pending.stripeExpiresAt.getTime() / 1000),
                                }
                            },
                        },
                    },
                },
            })
            assert.equal(repaired.providerState, "open")
            assert.equal(createCalls.length, 1)
            assert.deepEqual(createCalls[0].config, pending.stripeRequestSnapshot)
            assert.equal(createCalls[0].options.idempotencyKey, pending.stripeRequestIdempotencyKey)
            pending = await PendingCheckout.findById(pending._id).lean()
            reservation = await InventoryReservation.findOne({ reservationId: reservation.reservationId }).lean()
            assert.equal(pending.stripeSessionId, "cs_recovered")
            assert.equal(reservation.stripeSessionId, "cs_recovered")
            assert.equal(reservation.status, "held")
            assert.equal((await InventoryItem.findOne({ inventoryItemId: "inv_disconnect_recovery" })).reservedQuantity, 1)
        })
    } finally {
        await mongoose.connection.db.dropDatabase()
        await mongoose.disconnect()
    }
})
