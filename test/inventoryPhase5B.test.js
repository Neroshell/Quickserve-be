import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import mongoose from "mongoose"

import {
    INVENTORY_LINE_ALLOCATION_STATUSES,
    INVENTORY_RESERVATION_RELEASE_EVIDENCE,
    INVENTORY_RESERVATION_SOURCE_TYPES,
    INVENTORY_RESERVATION_STATUSES,
} from "../src/constants/inventoryReservation.js"
import InventoryMovement from "../src/models/InventoryMovement.js"
import InventoryReservation from "../src/models/InventoryReservation.js"
import { toInventoryMovementDTO } from "../src/services/canonicalInventoryService.js"
import {
    commitHeldInventoryReservation,
    consumeReservedInventoryForFulfillment,
    releaseInventoryReservationWithinTransaction,
    reserveInventoryForSource,
    resolveInventoryRequirements,
} from "../src/services/inventoryReservationService.js"
import { transitionOrderFulfillment } from "../src/services/orderFulfillmentService.js"

const fingerprint = "b".repeat(64)
const session = { id: "phase5b_test_session" }
const systemActor = { staffId: "system:test", role: "system", name: "Phase 5B Test" }
const kitchenActor = { staffId: "kitchen_1", role: "kitchen", name: "Kitchen One" }
const barActor = { staffId: "bar_1", role: "bartender", name: "Bar One" }

function inventoryItem({ inventoryItemId, unit = "piece", onHand, reserved }) {
    return {
        inventoryItemId,
        trackingUnit: unit,
        onHandQuantity: onHand,
        reservedQuantity: reserved,
        isActive: true,
        saveCount: 0,
        async save() {
            this.saveCount += 1
            return this
        },
    }
}

function movementRecorder() {
    const documents = []
    return {
        documents,
        model: {
            async create(input) {
                documents.push(...input)
                return input
            },
        },
    }
}

function fulfillmentLine({
    orderLineId,
    menuItemId,
    station,
    behavior,
    status = "pending",
    quantity = 1,
}) {
    return {
        orderLineId,
        menuItemId,
        itemName: orderLineId,
        quantity,
        lineTotal: 10,
        type: station === "bar" ? "drinks" : "food",
        fulfillmentStation: station,
        fulfillmentBehavior: behavior,
        fulfillmentStatus: status,
        fulfillmentStartedAt: null,
        fulfillmentStartedBy: null,
        fulfillmentReadyAt: null,
        fulfillmentReadyBy: null,
    }
}

function allocation({
    allocationId,
    orderLineId,
    menuItemId,
    station,
    behavior,
    inventoryItemId,
    quantity,
    unit = "piece",
    status = INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED,
}) {
    return {
        allocationId,
        orderLineId,
        menuItemId,
        fulfillmentStation: station,
        fulfillmentBehavior: behavior,
        inventoryItemId,
        canonicalQuantity: quantity,
        unit,
        status,
        consumeMovementId: status === INVENTORY_LINE_ALLOCATION_STATUSES.CONSUMED
            ? `imv_consume_${allocationId}`
            : null,
        consumedAt: status === INVENTORY_LINE_ALLOCATION_STATUSES.CONSUMED
            ? new Date("2026-09-05T10:00:00.000Z")
            : null,
        releaseMovementId: status === INVENTORY_LINE_ALLOCATION_STATUSES.RELEASED
            ? `imv_release_${allocationId}`
            : null,
        releasedAt: status === INVENTORY_LINE_ALLOCATION_STATUSES.RELEASED
            ? new Date("2026-09-05T10:00:00.000Z")
            : null,
    }
}

function reservationFor({ reservationId, orderId, components, allocations, menuItemIds }) {
    return {
        reservationId,
        businessId: "biz_phase5b",
        orderId,
        sourceType: INVENTORY_RESERVATION_SOURCE_TYPES.OFFLINE_ORDER,
        status: INVENTORY_RESERVATION_STATUSES.COMMITTED,
        components,
        lineAllocations: allocations,
        legacyComponents: [],
        menuRequirements: menuItemIds.map((menuItemId) => ({
            menuItemId,
            authority: "canonical",
            mappingMode: "recipe",
            mappingVersion: 1,
        })),
        saveCount: 0,
        async save() {
            this.saveCount += 1
            return this
        },
    }
}

function consumptionDependencies({ reservation, inventoryItems, movements, logger = console }) {
    return {
        InventoryReservationModel: {
            async findOne(query) {
                return query.businessId === reservation.businessId &&
                    query.reservationId === reservation.reservationId &&
                    query.orderId === reservation.orderId
                    ? reservation
                    : null
            },
        },
        InventoryItemModel: { find: async () => inventoryItems },
        InventoryMovementModel: movements.model,
        projectSimple: async () => {},
        logger,
    }
}

function fulfillmentDependencies(order, consume) {
    order.saveCount = 0
    order.save = async function save() {
        this.saveCount += 1
        return this
    }
    return {
        OrderModel: { findOne: async () => order },
        runTransaction: async (work) => work(session),
        consumeReservedInventoryForFulfillment: consume,
        now: () => new Date("2026-09-05T12:00:00.000Z"),
    }
}

test("line allocations reconcile exactly to aggregate reservation components", async () => {
    const burgerId = new mongoose.Types.ObjectId()
    const valid = new InventoryReservation({
        reservationId: "irv_phase5b_model",
        businessId: "biz_phase5b",
        sourceType: INVENTORY_RESERVATION_SOURCE_TYPES.OFFLINE_ORDER,
        sourceId: "ord_phase5b_model",
        orderId: "ord_phase5b_model",
        status: INVENTORY_RESERVATION_STATUSES.COMMITTED,
        components: [{
            inventoryItemId: "inv_beef",
            canonicalQuantity: 200,
            unit: "g",
            reserveMovementId: "imv_reserve_beef",
        }],
        lineAllocations: [
            allocation({
                allocationId: "allocation_burger_a",
                orderLineId: "line_burger_a",
                menuItemId: burgerId,
                station: "kitchen",
                behavior: "prepared",
                inventoryItemId: "inv_beef",
                quantity: 100,
                unit: "g",
            }),
            allocation({
                allocationId: "allocation_burger_b",
                orderLineId: "line_burger_b",
                menuItemId: burgerId,
                station: "kitchen",
                behavior: "prepared",
                inventoryItemId: "inv_beef",
                quantity: 100,
                unit: "g",
            }),
        ],
        menuRequirements: [{
            menuItemId: burgerId,
            orderQuantity: 2,
            authority: "canonical",
            mappingMode: "recipe",
            mappingVersion: 1,
        }],
        idempotencyKey: "phase5b:model",
        requestFingerprint: fingerprint,
        committedAt: new Date(),
    })
    await valid.validate()

    const mismatched = new InventoryReservation(valid.toObject())
    mismatched._id = new mongoose.Types.ObjectId()
    mismatched.lineAllocations[1].canonicalQuantity = 99
    await assert.rejects(
        mismatched.validate(),
        /must exactly reconcile to aggregate components/i,
    )
})

test("CONSUME ledger entries enforce balance deltas and expose fulfilment audit linkage", async () => {
    const movement = new InventoryMovement({
        movementId: "imv_phase5b_consume",
        businessId: "biz_phase5b",
        inventoryItemId: "inv_beef",
        type: "CONSUME",
        quantityDeltaOnHand: -100,
        quantityDeltaReserved: -100,
        unit: "g",
        canonicalQuantity: 100,
        onHandBefore: 1000,
        onHandAfter: 900,
        reservedBefore: 200,
        reservedAfter: 100,
        sourceType: "inventory_reservation",
        sourceId: "irv_phase5b",
        performedBy: kitchenActor,
        idempotencyKey: "phase5b:consume",
        requestFingerprint: fingerprint,
        inventoryReservationId: "irv_phase5b",
        orderId: "ord_phase5b",
        orderLineIds: ["line_burger"],
        allocationIds: ["allocation_beef"],
        fulfillmentStation: "kitchen",
        fulfillmentAction: "start",
    })
    await movement.validate()
    assert.deepEqual(toInventoryMovementDTO(movement), {
        movementId: "imv_phase5b_consume",
        inventoryItemId: "inv_beef",
        type: "CONSUME",
        quantityDeltaOnHand: -100,
        quantityDeltaReserved: -100,
        unit: "g",
        canonicalQuantity: 100,
        onHandBefore: 1000,
        onHandAfter: 900,
        reservedBefore: 200,
        reservedAfter: 100,
        availableBefore: 800,
        availableAfter: 800,
        sourceType: "inventory_reservation",
        sourceId: "irv_phase5b",
        inventoryReservationId: "irv_phase5b",
        orderId: "ord_phase5b",
        orderLineIds: ["line_burger"],
        allocationIds: ["allocation_beef"],
        fulfillmentStation: "kitchen",
        fulfillmentAction: "start",
        reasonCode: null,
        note: null,
        performedBy: {
            staffId: kitchenActor.staffId,
            role: kitchenActor.role,
            name: kitchenActor.name,
        },
        unitCostMinor: null,
        costCurrency: null,
        createdAt: null,
    })

    movement.quantityDeltaReserved = 0
    await assert.rejects(movement.validate(), /requires a Reserved delta of -100/i)
})

test("reservation-time resolution preserves quantity, duplicate-line, recipe, simple, and shared ownership", async () => {
    const burgerId = new mongoose.Types.ObjectId()
    const tacoId = new mongoose.Types.ObjectId()
    const spriteId = new mongoose.Types.ObjectId()
    const menuItems = [
        { _id: burgerId, name: "Burger", isAvailable: true },
        { _id: tacoId, name: "Taco", isAvailable: true },
        { _id: spriteId, name: "Sprite", isAvailable: true },
    ]
    const mappings = [
        {
            menuItemId: burgerId,
            mode: "recipe",
            status: "active",
            version: 4,
            components: [
                { inventoryItemId: "inv_beef", quantity: 100, unit: "g", canonicalQuantity: 100 },
                { inventoryItemId: "inv_bun", quantity: 1, unit: "piece", canonicalQuantity: 1 },
            ],
        },
        {
            menuItemId: tacoId,
            mode: "recipe",
            status: "active",
            version: 2,
            components: [
                { inventoryItemId: "inv_beef", quantity: 50, unit: "g", canonicalQuantity: 50 },
            ],
        },
        {
            menuItemId: spriteId,
            mode: "simple",
            status: "active",
            version: 1,
            components: [
                { inventoryItemId: "inv_sprite", quantity: 1, unit: "can", canonicalQuantity: 1 },
            ],
        },
    ]
    const inventoryItems = [
        inventoryItem({ inventoryItemId: "inv_beef", unit: "g", onHand: 2000, reserved: 0 }),
        inventoryItem({ inventoryItemId: "inv_bun", onHand: 20, reserved: 0 }),
        inventoryItem({ inventoryItemId: "inv_sprite", unit: "can", onHand: 20, reserved: 0 }),
    ]
    const result = await resolveInventoryRequirements({
        businessId: "biz_phase5b",
        items: [
            {
                menuItemId: burgerId,
                itemName: "Burger",
                quantity: 2,
                orderLineId: "line_burger_a",
                fulfillmentStation: "kitchen",
                fulfillmentBehavior: "prepared",
            },
            {
                menuItemId: burgerId,
                itemName: "Burger",
                quantity: 1,
                orderLineId: "line_burger_b",
                fulfillmentStation: "kitchen",
                fulfillmentBehavior: "prepared",
            },
            {
                menuItemId: tacoId,
                itemName: "Taco",
                quantity: 1,
                orderLineId: "line_taco",
                fulfillmentStation: "kitchen",
                fulfillmentBehavior: "prepared",
            },
            {
                menuItemId: spriteId,
                itemName: "Sprite",
                quantity: 2,
                orderLineId: "line_sprite",
                fulfillmentStation: "bar",
                fulfillmentBehavior: "direct",
            },
        ],
        session,
        env: {},
    }, {
        MenuItemModel: { find: async () => menuItems },
        MenuInventoryRecipeModel: { find: async () => mappings },
        InventoryItemModel: { find: async () => inventoryItems },
    })

    assert.deepEqual(result.failures, [])
    assert.deepEqual(
        result.requirements.map(({ inventoryItemId, canonicalQuantity }) => [
            inventoryItemId,
            canonicalQuantity,
        ]),
        [["inv_beef", 350], ["inv_bun", 3], ["inv_sprite", 2]],
    )
    assert.deepEqual(
        result.lineAllocationRequirements
            .filter((entry) => entry.orderLineId === "line_burger_a")
            .map(({ inventoryItemId, canonicalQuantity }) => [inventoryItemId, canonicalQuantity]),
        [["inv_beef", 200], ["inv_bun", 2]],
    )
    assert.equal(
        result.lineAllocationRequirements.find(
            (entry) => entry.orderLineId === "line_burger_b" && entry.inventoryItemId === "inv_beef",
        ).canonicalQuantity,
        100,
    )
    assert.equal(
        result.lineAllocationRequirements.find(
            (entry) => entry.orderLineId === "line_taco" && entry.inventoryItemId === "inv_beef",
        ).canonicalQuantity,
        50,
    )
    assert.equal(
        result.lineAllocationRequirements.find(
            (entry) => entry.orderLineId === "line_sprite",
        ).canonicalQuantity,
        2,
    )
})

test("offline, waitstaff, and Stripe reservation paths persist exact line allocations", async () => {
    for (const sourceType of Object.values(INVENTORY_RESERVATION_SOURCE_TYPES)) {
        const menuItemId = new mongoose.Types.ObjectId()
        const stock = inventoryItem({
            inventoryItemId: `inv_${sourceType}`,
            unit: "g",
            onHand: 1000,
            reserved: 0,
        })
        const createdReservations = []
        const movements = movementRecorder()
        const order = sourceType === INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT
            ? null
            : {
                orderId: `ord_${sourceType}`,
                async save() { return this },
            }
        const pendingCheckoutId = sourceType === INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT
            ? new mongoose.Types.ObjectId()
            : null
        const result = await reserveInventoryForSource({
            businessId: "biz_phase5b",
            items: [{
                menuItemId,
                itemName: "Burger",
                quantity: 2,
                orderLineId: `line_${sourceType}`,
                fulfillmentStation: "kitchen",
                fulfillmentBehavior: "prepared",
            }],
            sourceType,
            sourceId: `source_${sourceType}`,
            order,
            orderId: `ord_${sourceType}`,
            pendingCheckoutId,
            expiresAt: pendingCheckoutId ? new Date(Date.now() + 60_000) : null,
            reservationId: `irv_${sourceType}`,
            idempotencyKey: `phase5b:${sourceType}`,
            requestFingerprint: fingerprint,
            actor: systemActor,
            session,
            env: {},
        }, {
            InventoryReservationModel: {
                findOne: async () => null,
                async create(documents) {
                    createdReservations.push(...documents)
                    return documents
                },
            },
            InventoryMovementModel: movements.model,
            MenuItemModel: {
                find: async () => [{ _id: menuItemId, name: "Burger", isAvailable: true }],
            },
            MenuInventoryRecipeModel: {
                find: async () => [{
                    menuItemId,
                    mode: "recipe",
                    status: "active",
                    version: 3,
                    components: [{
                        inventoryItemId: stock.inventoryItemId,
                        quantity: 100,
                        unit: "g",
                        canonicalQuantity: 100,
                    }],
                }],
            },
            InventoryItemModel: { find: async () => [stock] },
        })

        assert.equal(result.tracked, true)
        assert.equal(stock.reservedQuantity, 200)
        assert.equal(createdReservations[0].components[0].canonicalQuantity, 200)
        assert.deepEqual(createdReservations[0].lineAllocations.map((entry) => ({
            orderLineId: entry.orderLineId,
            inventoryItemId: entry.inventoryItemId,
            canonicalQuantity: entry.canonicalQuantity,
            status: entry.status,
        })), [{
            orderLineId: `line_${sourceType}`,
            inventoryItemId: stock.inventoryItemId,
            canonicalQuantity: 200,
            status: INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED,
        }])
        assert.equal(movements.documents.length, 1)
        assert.equal(
            createdReservations[0].status,
            sourceType === INVENTORY_RESERVATION_SOURCE_TYPES.STRIPE_CHECKOUT
                ? INVENTORY_RESERVATION_STATUSES.HELD
                : INVENTORY_RESERVATION_STATUSES.COMMITTED,
        )
    }
})

test("Stripe HELD to COMMITTED keeps the authoritative allocation snapshot", async () => {
    const pendingCheckoutId = new mongoose.Types.ObjectId()
    const lineAllocations = [{ allocationId: "allocation_stripe" }]
    const reservation = {
        reservationId: "irv_stripe_commit",
        pendingCheckoutId,
        stripeSessionId: "cs_phase5b",
        status: INVENTORY_RESERVATION_STATUSES.HELD,
        lineAllocations,
        async save() { return this },
    }
    await commitHeldInventoryReservation({
        businessId: "biz_phase5b",
        reservationId: reservation.reservationId,
        pendingCheckoutId,
        stripeSessionId: "cs_phase5b",
        orderId: "ord_stripe_commit",
        session,
    }, {
        InventoryReservationModel: { findOne: async () => reservation },
    })
    assert.equal(reservation.status, INVENTORY_RESERVATION_STATUSES.COMMITTED)
    assert.equal(reservation.orderId, "ord_stripe_commit")
    assert.equal(reservation.lineAllocations, lineAllocations)
})

test("Kitchen recipe consumption is exact, atomic as a batch, and independently attributable", async () => {
    const burgerId = new mongoose.Types.ObjectId()
    const order = {
        orderId: "ord_kitchen_recipe",
        businessId: "biz_phase5b",
        inventoryReservationId: "irv_kitchen_recipe",
        items: [
            fulfillmentLine({
                orderLineId: "line_burger_two",
                menuItemId: burgerId,
                station: "kitchen",
                behavior: "prepared",
                quantity: 2,
            }),
            fulfillmentLine({
                orderLineId: "line_burger_one",
                menuItemId: burgerId,
                station: "kitchen",
                behavior: "prepared",
            }),
        ],
    }
    const allocations = [
        allocation({
            allocationId: "allocation_beef_two",
            orderLineId: "line_burger_two",
            menuItemId: burgerId,
            station: "kitchen",
            behavior: "prepared",
            inventoryItemId: "inv_beef",
            quantity: 200,
            unit: "g",
        }),
        allocation({
            allocationId: "allocation_bun_two",
            orderLineId: "line_burger_two",
            menuItemId: burgerId,
            station: "kitchen",
            behavior: "prepared",
            inventoryItemId: "inv_bun",
            quantity: 2,
        }),
        allocation({
            allocationId: "allocation_beef_one",
            orderLineId: "line_burger_one",
            menuItemId: burgerId,
            station: "kitchen",
            behavior: "prepared",
            inventoryItemId: "inv_beef",
            quantity: 100,
            unit: "g",
        }),
        allocation({
            allocationId: "allocation_bun_one",
            orderLineId: "line_burger_one",
            menuItemId: burgerId,
            station: "kitchen",
            behavior: "prepared",
            inventoryItemId: "inv_bun",
            quantity: 1,
        }),
    ]
    const reservation = reservationFor({
        reservationId: order.inventoryReservationId,
        orderId: order.orderId,
        components: [
            { inventoryItemId: "inv_beef", canonicalQuantity: 300, unit: "g" },
            { inventoryItemId: "inv_bun", canonicalQuantity: 3, unit: "piece" },
        ],
        allocations,
        menuItemIds: [burgerId],
    })
    const beef = inventoryItem({ inventoryItemId: "inv_beef", unit: "g", onHand: 1000, reserved: 300 })
    const buns = inventoryItem({ inventoryItemId: "inv_bun", onHand: 10, reserved: 3 })
    const movements = movementRecorder()
    const dependencies = consumptionDependencies({
        reservation,
        inventoryItems: [beef, buns],
        movements,
    })

    const first = await consumeReservedInventoryForFulfillment({
        businessId: order.businessId,
        order,
        orderLineIds: ["line_burger_two"],
        station: "kitchen",
        action: "start",
        actor: kitchenActor,
        session,
        now: new Date("2026-09-05T12:00:00.000Z"),
    }, dependencies)
    assert.equal(first.changed, true)
    assert.deepEqual([beef.onHandQuantity, beef.reservedQuantity], [800, 100])
    assert.deepEqual([buns.onHandQuantity, buns.reservedQuantity], [8, 1])
    assert.equal(beef.onHandQuantity - beef.reservedQuantity, 700)
    assert.equal(buns.onHandQuantity - buns.reservedQuantity, 7)
    assert.equal(movements.documents.length, 2)
    assert.deepEqual(
        movements.documents.map((entry) => entry.orderLineIds),
        [["line_burger_two"], ["line_burger_two"]],
    )
    assert.equal(allocations[0].status, INVENTORY_LINE_ALLOCATION_STATUSES.CONSUMED)
    assert.equal(allocations[1].status, INVENTORY_LINE_ALLOCATION_STATUSES.CONSUMED)
    assert.equal(allocations[2].status, INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED)
    assert.equal(allocations[3].status, INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED)

    const replay = await consumeReservedInventoryForFulfillment({
        businessId: order.businessId,
        order,
        orderLineIds: ["line_burger_two"],
        station: "kitchen",
        action: "start",
        actor: kitchenActor,
        session,
    }, dependencies)
    assert.equal(replay.changed, false)
    assert.equal(replay.replayed, true)
    assert.equal(movements.documents.length, 2)

    await consumeReservedInventoryForFulfillment({
        businessId: order.businessId,
        order,
        orderLineIds: ["line_burger_one"],
        station: "kitchen",
        action: "start",
        actor: kitchenActor,
        session,
    }, dependencies)
    assert.deepEqual([beef.onHandQuantity, beef.reservedQuantity], [700, 0])
    assert.deepEqual([buns.onHandQuantity, buns.reservedQuantity], [7, 0])
    assert.equal(movements.documents.length, 4)
    assert.deepEqual(movements.documents.at(-1).orderLineIds, ["line_burger_one"])
})

test("Bar prepared START and Bar direct READY consume independently in a mixed order", async () => {
    const negroniId = new mongoose.Types.ObjectId()
    const spriteId = new mongoose.Types.ObjectId()
    const order = {
        orderId: "ord_bar_mixed",
        businessId: "biz_phase5b",
        inventoryReservationId: "irv_bar_mixed",
        items: [
            fulfillmentLine({
                orderLineId: "line_negroni",
                menuItemId: negroniId,
                station: "bar",
                behavior: "prepared",
            }),
            fulfillmentLine({
                orderLineId: "line_sprite",
                menuItemId: spriteId,
                station: "bar",
                behavior: "direct",
            }),
        ],
    }
    const allocations = [
        allocation({
            allocationId: "allocation_spirit",
            orderLineId: "line_negroni",
            menuItemId: negroniId,
            station: "bar",
            behavior: "prepared",
            inventoryItemId: "inv_spirit",
            quantity: 50,
            unit: "ml",
        }),
        allocation({
            allocationId: "allocation_sprite",
            orderLineId: "line_sprite",
            menuItemId: spriteId,
            station: "bar",
            behavior: "direct",
            inventoryItemId: "inv_sprite",
            quantity: 1,
            unit: "can",
        }),
    ]
    const reservation = reservationFor({
        reservationId: order.inventoryReservationId,
        orderId: order.orderId,
        components: [
            { inventoryItemId: "inv_spirit", canonicalQuantity: 50, unit: "ml" },
            { inventoryItemId: "inv_sprite", canonicalQuantity: 1, unit: "can" },
        ],
        allocations,
        menuItemIds: [negroniId, spriteId],
    })
    const spirit = inventoryItem({ inventoryItemId: "inv_spirit", unit: "ml", onHand: 500, reserved: 50 })
    const sprite = inventoryItem({ inventoryItemId: "inv_sprite", unit: "can", onHand: 8, reserved: 1 })
    const movements = movementRecorder()
    const dependencies = consumptionDependencies({
        reservation,
        inventoryItems: [spirit, sprite],
        movements,
    })

    await consumeReservedInventoryForFulfillment({
        businessId: order.businessId,
        order,
        orderLineIds: ["line_negroni"],
        station: "bar",
        action: "start",
        actor: barActor,
        session,
    }, dependencies)
    assert.deepEqual([spirit.onHandQuantity, spirit.reservedQuantity], [450, 0])
    assert.deepEqual([sprite.onHandQuantity, sprite.reservedQuantity], [8, 1])
    assert.equal(allocations[1].status, INVENTORY_LINE_ALLOCATION_STATUSES.RESERVED)

    await consumeReservedInventoryForFulfillment({
        businessId: order.businessId,
        order,
        orderLineIds: ["line_sprite"],
        station: "bar",
        action: "ready",
        actor: barActor,
        session,
    }, dependencies)
    assert.deepEqual([sprite.onHandQuantity, sprite.reservedQuantity], [7, 0])
    assert.equal(allocations[1].status, INVENTORY_LINE_ALLOCATION_STATUSES.CONSUMED)
    assert.equal(movements.documents.length, 2)
})

test("Phase 5A invokes inventory only for the first legal consumption transition", async () => {
    const scenarios = [
        {
            orderId: "ord_offline_kitchen",
            paymentChannel: "offline",
            orderSource: "self",
            station: "kitchen",
            behavior: "prepared",
            action: "start",
            actor: kitchenActor,
        },
        {
            orderId: "ord_waitstaff_bar_prepared",
            paymentChannel: "offline",
            orderSource: "waitstaff",
            station: "bar",
            behavior: "prepared",
            action: "start",
            actor: barActor,
        },
        {
            orderId: "ord_online_bar_direct",
            paymentChannel: "online",
            orderSource: "self",
            station: "bar",
            behavior: "direct",
            action: "ready",
            actor: barActor,
        },
    ]

    for (const scenario of scenarios) {
        const calls = []
        const order = {
            orderId: scenario.orderId,
            businessId: "biz_phase5b",
            status: "placed",
            paymentChannel: scenario.paymentChannel,
            orderSource: scenario.orderSource,
            inventoryReservationId: `irv_${scenario.orderId}`,
            items: [fulfillmentLine({
                orderLineId: `line_${scenario.orderId}`,
                menuItemId: new mongoose.Types.ObjectId(),
                station: scenario.station,
                behavior: scenario.behavior,
            })],
        }
        const dependencies = fulfillmentDependencies(order, async (command) => {
            calls.push(command)
            return { changed: true }
        })
        const first = await transitionOrderFulfillment({
            businessId: order.businessId,
            orderId: order.orderId,
            station: scenario.station,
            action: scenario.action,
            actor: scenario.actor,
        }, dependencies)
        assert.equal(first.inventoryChanged, true)
        assert.equal(calls.length, 1)
        assert.deepEqual(calls[0].orderLineIds, [`line_${scenario.orderId}`])
        assert.equal(calls[0].session, session)

        const replay = await transitionOrderFulfillment({
            businessId: order.businessId,
            orderId: order.orderId,
            station: scenario.station,
            action: scenario.action,
            actor: scenario.actor,
        }, dependencies)
        assert.equal(replay.inventoryChanged, false)
        assert.equal(calls.length, 1)

        if (scenario.behavior === "prepared") {
            await transitionOrderFulfillment({
                businessId: order.businessId,
                orderId: order.orderId,
                station: scenario.station,
                action: "ready",
                actor: scenario.actor,
            }, dependencies)
            assert.equal(calls.length, 1)
        }
    }
})

test("fulfilment cannot advance when required inventory consumption fails", async () => {
    const order = {
        orderId: "ord_consumption_failure",
        businessId: "biz_phase5b",
        status: "placed",
        inventoryReservationId: "irv_consumption_failure",
        items: [fulfillmentLine({
            orderLineId: "line_consumption_failure",
            menuItemId: new mongoose.Types.ObjectId(),
            station: "kitchen",
            behavior: "prepared",
        })],
    }
    const dependencies = fulfillmentDependencies(order, async () => {
        const error = new Error("Inventory write failed")
        error.code = "INVENTORY_WRITE_FAILED"
        throw error
    })
    await assert.rejects(
        transitionOrderFulfillment({
            businessId: order.businessId,
            orderId: order.orderId,
            station: "kitchen",
            action: "start",
            actor: kitchenActor,
        }, dependencies),
        { code: "INVENTORY_WRITE_FAILED" },
    )
    assert.equal(order.items[0].fulfillmentStatus, "pending")
    assert.equal(order.status, "placed")
    assert.equal(order.saveCount, 0)
})

test("a transient transaction retry leaves one logical consumption and one fulfilment transition", async () => {
    const createAttemptOrder = () => ({
        orderId: "ord_transaction_retry",
        businessId: "biz_phase5b",
        status: "placed",
        inventoryReservationId: "irv_transaction_retry",
        items: [fulfillmentLine({
            orderLineId: "line_transaction_retry",
            menuItemId: new mongoose.Types.ObjectId(),
            station: "kitchen",
            behavior: "prepared",
        })],
        async save() { return this },
    })
    const attemptOrders = [createAttemptOrder(), createAttemptOrder()]
    const committedConsumptions = []
    let activeAttempt = -1
    let sessionCount = 0
    const startSession = async () => {
        activeAttempt = sessionCount
        sessionCount += 1
        const stagedConsumptions = []
        return {
            stagedConsumptions,
            async withTransaction(work) {
                await work()
                if (activeAttempt === 0) {
                    const error = new Error("Write conflict")
                    error.hasErrorLabel = (label) => label === "TransientTransactionError"
                    throw error
                }
                committedConsumptions.push(...stagedConsumptions)
            },
            async endSession() {},
        }
    }
    const result = await transitionOrderFulfillment({
        businessId: "biz_phase5b",
        orderId: "ord_transaction_retry",
        station: "kitchen",
        action: "start",
        actor: kitchenActor,
    }, {
        startSession,
        OrderModel: { findOne: async () => attemptOrders[activeAttempt] },
        consumeReservedInventoryForFulfillment: async ({ session }) => {
            session.stagedConsumptions.push("line_transaction_retry")
            return { changed: true }
        },
        now: () => new Date("2026-09-05T12:00:00.000Z"),
    })

    assert.equal(sessionCount, 2)
    assert.deepEqual(committedConsumptions, ["line_transaction_retry"])
    assert.equal(result.order, attemptOrders[1])
    assert.equal(result.order.status, "in_progress")
    assert.equal(result.order.items[0].fulfillmentStatus, "in_progress")
})

test("release affects only reserved allocations and never restores consumed stock", async () => {
    const menuItemId = new mongoose.Types.ObjectId()
    const consumed = allocation({
        allocationId: "allocation_consumed",
        orderLineId: "line_consumed",
        menuItemId,
        station: "kitchen",
        behavior: "prepared",
        inventoryItemId: "inv_shared",
        quantity: 2,
        status: INVENTORY_LINE_ALLOCATION_STATUSES.CONSUMED,
    })
    const reserved = allocation({
        allocationId: "allocation_reserved",
        orderLineId: "line_reserved",
        menuItemId,
        station: "kitchen",
        behavior: "prepared",
        inventoryItemId: "inv_shared",
        quantity: 4,
    })
    const reservation = reservationFor({
        reservationId: "irv_partial_release",
        orderId: null,
        components: [{ inventoryItemId: "inv_shared", canonicalQuantity: 6, unit: "piece" }],
        allocations: [consumed, reserved],
        menuItemIds: [menuItemId],
    })
    const stock = inventoryItem({ inventoryItemId: "inv_shared", onHand: 8, reserved: 4 })
    const movements = movementRecorder()
    const first = await releaseInventoryReservationWithinTransaction({
        businessId: reservation.businessId,
        reservationId: reservation.reservationId,
        releaseEvidence: INVENTORY_RESERVATION_RELEASE_EVIDENCE.ORDER_CANCELLED_BEFORE_FULFILMENT,
        actor: systemActor,
        session,
    }, {
        InventoryReservationModel: { findOne: async () => reservation },
        InventoryItemModel: { find: async () => [stock] },
        InventoryMovementModel: movements.model,
        MenuItemModel: { find: async () => [] },
        OrderModel: { findOne: async () => null },
    })
    assert.equal(first.changed, true)
    assert.deepEqual([stock.onHandQuantity, stock.reservedQuantity], [8, 0])
    assert.equal(consumed.status, INVENTORY_LINE_ALLOCATION_STATUSES.CONSUMED)
    assert.equal(consumed.consumeMovementId, "imv_consume_allocation_consumed")
    assert.equal(consumed.releaseMovementId, null)
    assert.equal(reserved.status, INVENTORY_LINE_ALLOCATION_STATUSES.RELEASED)
    assert.ok(reserved.releaseMovementId)
    assert.equal(movements.documents.length, 1)
    assert.equal(movements.documents[0].canonicalQuantity, 4)
    assert.equal(movements.documents[0].quantityDeltaOnHand, 0)
    assert.equal(movements.documents[0].quantityDeltaReserved, -4)

    const replay = await releaseInventoryReservationWithinTransaction({
        businessId: reservation.businessId,
        reservationId: reservation.reservationId,
        releaseEvidence: INVENTORY_RESERVATION_RELEASE_EVIDENCE.ORDER_CANCELLED_BEFORE_FULFILMENT,
        actor: systemActor,
        session,
    }, {
        InventoryReservationModel: { findOne: async () => reservation },
    })
    assert.equal(replay.changed, false)
    assert.equal(movements.documents.length, 1)
})

test("legacy orders and Phase 4 reservations without allocations continue without guessing", async () => {
    const noReservation = await consumeReservedInventoryForFulfillment({
        businessId: "biz_phase5b",
        order: { orderId: "ord_legacy", items: [], inventoryReservationId: null },
        orderLineIds: ["legacy_line"],
        station: "kitchen",
        action: "start",
        actor: kitchenActor,
        session,
    })
    assert.equal(noReservation.skipped, "order_without_inventory_reservation")

    const warnings = []
    const phase4Reservation = {
        reservationId: "irv_phase4_without_allocations",
        orderId: "ord_phase4_without_allocations",
        status: INVENTORY_RESERVATION_STATUSES.COMMITTED,
        components: [{ inventoryItemId: "inv_phase4", canonicalQuantity: 1, unit: "piece" }],
        lineAllocations: [],
    }
    const phase4 = await consumeReservedInventoryForFulfillment({
        businessId: "biz_phase5b",
        order: {
            orderId: phase4Reservation.orderId,
            inventoryReservationId: phase4Reservation.reservationId,
            items: [fulfillmentLine({
                orderLineId: "line_phase4",
                menuItemId: new mongoose.Types.ObjectId(),
                station: "kitchen",
                behavior: "prepared",
            })],
        },
        orderLineIds: ["line_phase4"],
        station: "kitchen",
        action: "start",
        actor: kitchenActor,
        session,
    }, {
        InventoryReservationModel: { findOne: async () => phase4Reservation },
        InventoryItemModel: { find: async () => assert.fail("must not reconstruct inventory") },
        InventoryMovementModel: { create: async () => assert.fail("must not consume inventory") },
        logger: { warn: (...args) => warnings.push(args) },
    })
    assert.equal(phase4.skipped, "reservation_without_line_allocations")
    assert.equal(warnings.length, 1)
})

test("Kitchen and Bar controllers reuse post-commit menu invalidation and order SSE", async () => {
    for (const controller of ["kitchenController.js", "barController.js"]) {
        const source = await readFile(
            new URL(`../src/controllers/${controller}`, import.meta.url),
            "utf8",
        )
        const transition = source.indexOf("await transitionOrderFulfillment")
        const invalidation = source.indexOf("await invalidateMenuItems", transition)
        const realtime = source.indexOf("await publishOrderRealtime", transition)
        assert.ok(transition >= 0)
        assert.ok(invalidation > transition)
        assert.ok(realtime > invalidation)
        assert.match(source, /if \(result\.inventoryChanged\)/)
        assert.match(source, /if \(result\.changed\)/)
    }
})
