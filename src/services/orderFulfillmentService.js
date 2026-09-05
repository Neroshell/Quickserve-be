import mongoose from "mongoose"

import {
  CUSTOMER_FULFILLMENT_EVENTS,
  FULFILLMENT_ACTIONS,
  FULFILLMENT_ACTION_VALUES,
  FULFILLMENT_BEHAVIORS,
  FULFILLMENT_STATIONS,
  FULFILLMENT_STATUSES,
  ORDER_FULFILLMENT_SCHEMA_VERSION,
} from "../constants/orderFulfillment.js"
import Order from "../models/order.js"
import { resolveOrderStartAssistanceDelayMinutes } from "../utils/customerOrderTiming.js"
import { generateOrderLineId } from "../utils/orderLineId.js"

const TERMINAL_ORDER_STATUSES = new Set(["completed", "cancelled"])
const MAX_TRANSACTION_ATTEMPTS = 3
const STATION_ROLES = Object.freeze({
  kitchen: new Set(["kitchen", "manager", "owner", "co_owner", "admin"]),
  bar: new Set(["bartender", "manager", "owner", "co_owner", "admin"]),
})
const HANDOFF_ROLES = new Set(["waiter", "manager", "owner", "co_owner"])

export class OrderFulfillmentError extends Error {
  constructor(message, code = "ORDER_FULFILLMENT_ERROR", statusCode = 400) {
    super(message)
    this.name = "OrderFulfillmentError"
    this.code = code
    this.statusCode = statusCode
  }
}

export function resolveMenuItemFulfillment(menuItem = {}) {
  const type = menuItem.type === "drinks" ? "drinks" : "food"
  const explicitStation = menuItem.fulfillmentStation
  const explicitBehavior = menuItem.fulfillmentBehavior

  if (type === "food") {
    return {
      station: FULFILLMENT_STATIONS.KITCHEN,
      behavior: FULFILLMENT_BEHAVIORS.PREPARED,
      explicit: explicitStation === FULFILLMENT_STATIONS.KITCHEN &&
        explicitBehavior === FULFILLMENT_BEHAVIORS.PREPARED,
    }
  }

  return {
    station: FULFILLMENT_STATIONS.BAR,
    behavior: explicitStation === FULFILLMENT_STATIONS.BAR &&
      explicitBehavior === FULFILLMENT_BEHAVIORS.PREPARED
      ? FULFILLMENT_BEHAVIORS.PREPARED
      : FULFILLMENT_BEHAVIORS.DIRECT,
    explicit: explicitStation === FULFILLMENT_STATIONS.BAR &&
      [FULFILLMENT_BEHAVIORS.PREPARED, FULFILLMENT_BEHAVIORS.DIRECT].includes(explicitBehavior),
  }
}

export function normalizeMenuFulfillmentConfiguration(input = {}) {
  const type = input.type === "drinks" ? "drinks" : input.type === "food" ? "food" : null
  if (!type) {
    throw new OrderFulfillmentError(
      "Fulfilment requires a valid menu item type",
      "INVALID_FULFILLMENT_TYPE",
    )
  }

  const expectedStation = type === "food"
    ? FULFILLMENT_STATIONS.KITCHEN
    : FULFILLMENT_STATIONS.BAR
  const behavior = type === "food"
    ? FULFILLMENT_BEHAVIORS.PREPARED
    : input.fulfillmentBehavior || FULFILLMENT_BEHAVIORS.DIRECT

  if (input.fulfillmentStation && input.fulfillmentStation !== expectedStation) {
    throw new OrderFulfillmentError(
      `${type === "food" ? "Food" : "Drink"} items must be fulfilled by the ${expectedStation}`,
      "INVALID_FULFILLMENT_STATION",
    )
  }
  if (![FULFILLMENT_BEHAVIORS.PREPARED, FULFILLMENT_BEHAVIORS.DIRECT].includes(behavior)) {
    throw new OrderFulfillmentError("Invalid fulfilment behavior", "INVALID_FULFILLMENT_BEHAVIOR")
  }
  if (type === "food" && behavior !== FULFILLMENT_BEHAVIORS.PREPARED) {
    throw new OrderFulfillmentError("Food items require preparation", "INVALID_FULFILLMENT_BEHAVIOR")
  }

  let prepTimeMinutes = null
  if (behavior === FULFILLMENT_BEHAVIORS.PREPARED) {
    prepTimeMinutes = Number(input.prepTimeMinutes)
    if (!Number.isInteger(prepTimeMinutes) || prepTimeMinutes < 1) {
      throw new OrderFulfillmentError(
        "Preparation time must be a whole number of minutes for prepared items",
        "INVALID_PREPARATION_TIME",
      )
    }
  }

  return {
    type,
    fulfillmentStation: expectedStation,
    fulfillmentBehavior: behavior,
    prepTimeMinutes,
  }
}

export function createOrderLineFulfillmentSnapshot(menuItem) {
  const resolved = resolveMenuItemFulfillment(menuItem)
  return {
    orderLineId: generateOrderLineId(),
    fulfillmentStation: resolved.station,
    fulfillmentBehavior: resolved.behavior,
    fulfillmentStatus: FULFILLMENT_STATUSES.PENDING,
    fulfillmentStartedAt: null,
    fulfillmentStartedBy: null,
    fulfillmentReadyAt: null,
    fulfillmentReadyBy: null,
  }
}

export function hasCanonicalFulfillmentLine(item) {
  return Boolean(
    item?.orderLineId && item?.fulfillmentStation &&
    item?.fulfillmentBehavior && item?.fulfillmentStatus,
  )
}

function sameFrozenLineIdentity(orderLine, frozenLine) {
  if (orderLine?.menuItemId && frozenLine?.menuItemId) {
    return String(orderLine.menuItemId) === String(frozenLine.menuItemId)
  }
  return orderLine?.itemName === frozenLine?.itemName &&
    Number(orderLine?.quantity) === Number(frozenLine?.quantity)
}

function findSnapshotTarget(orderItems, frozenLine, frozenIndex, usedIndexes) {
  const exactLineIndex = orderItems.findIndex((item, index) =>
    !usedIndexes.has(index) &&
    item?.orderLineId &&
    String(item.orderLineId) === String(frozenLine.orderLineId),
  )
  if (exactLineIndex >= 0) return exactLineIndex

  const identityMatches = orderItems
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => !usedIndexes.has(index) && sameFrozenLineIdentity(item, frozenLine))
  if (identityMatches.length === 1) return identityMatches[0].index

  const positional = orderItems[frozenIndex]
  if (
    !usedIndexes.has(frozenIndex) &&
    positional &&
    sameFrozenLineIdentity(positional, frozenLine)
  ) {
    return frozenIndex
  }
  return -1
}

/**
 * Reconciles an existing paid Order from the frozen PendingCheckout snapshot.
 * This is recovery-only: it never reads MenuItem, never weakens prepared to
 * direct, and never regresses a line that staff have already progressed.
 */
export function reconcileFrozenCheckoutFulfillment(order, frozenItems = []) {
  const orderItems = order?.items || []
  if (orderItems.length === 0 || frozenItems.length === 0) return false

  let changed = false
  const usedIndexes = new Set()
  frozenItems.forEach((frozenLine, frozenIndex) => {
    if (!hasCanonicalFulfillmentLine(frozenLine)) return
    const targetIndex = findSnapshotTarget(orderItems, frozenLine, frozenIndex, usedIndexes)
    if (targetIndex < 0) return
    usedIndexes.add(targetIndex)
    const target = orderItems[targetIndex]
    const progressed = target.fulfillmentStatus === FULFILLMENT_STATUSES.IN_PROGRESS ||
      target.fulfillmentStatus === FULFILLMENT_STATUSES.READY ||
      Boolean(target.fulfillmentStartedAt || target.fulfillmentReadyAt)

    if (!target.orderLineId || (!progressed && String(target.orderLineId) !== String(frozenLine.orderLineId))) {
      target.orderLineId = frozenLine.orderLineId
      changed = true
    }
    if (!target.fulfillmentStation || target.fulfillmentStation !== frozenLine.fulfillmentStation) {
      target.fulfillmentStation = frozenLine.fulfillmentStation
      changed = true
    }
    if (
      target.fulfillmentBehavior !== FULFILLMENT_BEHAVIORS.PREPARED &&
      target.fulfillmentBehavior !== frozenLine.fulfillmentBehavior
    ) {
      target.fulfillmentBehavior = frozenLine.fulfillmentBehavior
      changed = true
    }
    if (!target.fulfillmentStatus) {
      target.fulfillmentStatus = frozenLine.fulfillmentStatus
      changed = true
    }

    for (const field of [
      "fulfillmentStartedAt",
      "fulfillmentStartedBy",
      "fulfillmentReadyAt",
      "fulfillmentReadyBy",
    ]) {
      if (!target[field] && frozenLine[field]) {
        target[field] = frozenLine[field]
        changed = true
      }
    }
  })

  if (changed) order.fulfillmentSchemaVersion = ORDER_FULFILLMENT_SCHEMA_VERSION
  return changed
}

function legacyLineStatus(orderStatus, behavior) {
  if (["ready", "completed"].includes(orderStatus)) return FULFILLMENT_STATUSES.READY
  if (orderStatus === "in_progress" && behavior === FULFILLMENT_BEHAVIORS.PREPARED) {
    return FULFILLMENT_STATUSES.IN_PROGRESS
  }
  return FULFILLMENT_STATUSES.PENDING
}

export function materializeLegacyOrderFulfillment(order, now = new Date()) {
  let changed = false
  for (const item of order.items || []) {
    if (hasCanonicalFulfillmentLine(item)) continue
    const resolved = resolveMenuItemFulfillment(item)
    const status = legacyLineStatus(order.status, resolved.behavior)
    item.orderLineId = item.orderLineId || generateOrderLineId()
    item.fulfillmentStation = resolved.station
    item.fulfillmentBehavior = resolved.behavior
    item.fulfillmentStatus = status
    item.fulfillmentStartedAt = status === FULFILLMENT_STATUSES.IN_PROGRESS
      ? item.fulfillmentStartedAt || order.updatedAt || order.createdAt || now
      : null
    item.fulfillmentStartedBy = item.fulfillmentStartedBy || null
    item.fulfillmentReadyAt = status === FULFILLMENT_STATUSES.READY
      ? item.fulfillmentReadyAt || order.readyAt || order.updatedAt || now
      : null
    item.fulfillmentReadyBy = item.fulfillmentReadyBy || null
    changed = true
  }
  if (changed) order.fulfillmentSchemaVersion = ORDER_FULFILLMENT_SCHEMA_VERSION
  return changed
}

export function deriveOrderStatusFromLines(items = []) {
  const statuses = items.map((item) => item.fulfillmentStatus).filter(Boolean)
  if (statuses.length === 0 || statuses.every((status) => status === FULFILLMENT_STATUSES.PENDING)) {
    return "placed"
  }
  if (statuses.every((status) => status === FULFILLMENT_STATUSES.READY)) return "ready"
  return "in_progress"
}

export function deriveStationStatus(items = []) {
  return deriveOrderStatusFromLines(items)
}

function validDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function positiveMinutes(value) {
  const minutes = Number(value)
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null
}

function projectCustomerStation(lines = [], now) {
  if (lines.length === 0) {
    return {
      required: false,
      state: "not_required",
      estimatedReadyAt: null,
      estimateStartedAt: null,
      etaState: "none",
    }
  }

  const allReady = lines.every((line) => line.fulfillmentStatus === FULFILLMENT_STATUSES.READY)
  const preparing = lines.some(
    (line) => line.fulfillmentStatus === FULFILLMENT_STATUSES.IN_PROGRESS,
  )
  const hasReady = lines.some((line) => line.fulfillmentStatus === FULFILLMENT_STATUSES.READY)
  // Preparation ETA describes active timed work; direct and pending lines still
  // participate in station state and readiness through the checks above.
  const activePreparedLines = lines.filter((line) => (
    line.fulfillmentBehavior === FULFILLMENT_BEHAVIORS.PREPARED &&
    line.fulfillmentStatus === FULFILLMENT_STATUSES.IN_PROGRESS &&
    validDate(line.fulfillmentStartedAt) &&
    positiveMinutes(line.prepTimeMinutes)
  ))

  let estimatedReadyAt = null
  let estimateStartedAt = null
  if (activePreparedLines.length > 0) {
    for (const line of activePreparedLines) {
      const startedAt = validDate(line.fulfillmentStartedAt)
      const minutes = positiveMinutes(line.prepTimeMinutes)
      const lineReadyAt = new Date(startedAt.getTime() + minutes * 60 * 1000)
      if (!estimatedReadyAt || lineReadyAt > estimatedReadyAt) {
        estimatedReadyAt = lineReadyAt
        estimateStartedAt = startedAt
      }
    }
  }

  return {
    required: true,
    state: allReady ? "ready" : preparing ? "preparing" : "waiting",
    hasReady,
    estimatedReadyAt,
    estimateStartedAt,
    etaState: estimatedReadyAt
      ? estimatedReadyAt.getTime() <= now.getTime() ? "extended" : "active"
      : "none",
  }
}

function projectExtendedPreparationCopy(food, drinks) {
  const foodExtended = food.etaState === "extended"
  const drinksExtended = drinks.etaState === "extended"

  if (foodExtended && drinksExtended) {
    return {
      headline: "Still being prepared",
      secondaryMessage: "Your food and drinks are still being prepared.",
    }
  }
  if (foodExtended) {
    return {
      headline: "Still being prepared",
      secondaryMessage: "Your food is still being prepared.",
    }
  }
  return {
    headline: "Still being prepared",
    secondaryMessage: "Your drinks are still being prepared.",
  }
}

function projectWaitingForStartAssistance(order, items, options, now) {
  const unavailable = {
    assistanceAvailable: false,
    assistanceAvailableAt: null,
    assistanceReason: null,
    assistanceStations: [],
  }
  if (options.assistanceEnabled === false) return unavailable
  if (["ready", "completed", "cancelled", "served"].includes(order?.status)) return unavailable

  // Legacy/incomplete snapshots may support safe progress copy, but they must
  // never trigger station-specific escalation.
  if (items.length === 0 || !items.every(hasCanonicalFulfillmentLine)) return unavailable

  const assistanceStations = Array.from(new Set(items
    .filter((item) => (
      item.fulfillmentBehavior === FULFILLMENT_BEHAVIORS.PREPARED &&
      item.fulfillmentStatus === FULFILLMENT_STATUSES.PENDING &&
      !validDate(item.fulfillmentStartedAt)
    ))
    .map((item) => item.fulfillmentStation)))

  if (assistanceStations.length === 0) return unavailable
  const createdAt = validDate(order?.createdAt)
  if (!createdAt) return unavailable

  const delayMinutes = resolveOrderStartAssistanceDelayMinutes(
    options.orderStartAssistanceDelayMinutes,
  )
  const assistanceAvailableAt = new Date(
    createdAt.getTime() + delayMinutes * 60 * 1000,
  )

  return {
    assistanceAvailable: now.getTime() >= assistanceAvailableAt.getTime(),
    assistanceAvailableAt,
    assistanceReason: "prepared_fulfillment_not_started",
    assistanceStations,
  }
}

function projectInProgressCopy(food, drinks) {
  if (food.state === "preparing" && drinks.state === "preparing") {
    return {
      headline: "Your food and drinks are being prepared.",
      secondaryMessage: null,
    }
  }
  if (food.state === "preparing" && drinks.state === "ready") {
    return {
      headline: "Your drinks are ready. Your food is still being prepared.",
      secondaryMessage: null,
    }
  }
  if (food.state === "ready" && drinks.state === "preparing") {
    return {
      headline: "Your food is ready. Your drinks are still being prepared.",
      secondaryMessage: null,
    }
  }
  if (food.state === "preparing") {
    return {
      headline: "Your food is being prepared.",
      secondaryMessage: drinks.required && drinks.state === "waiting"
        ? "Waiting for the bar to start your drinks."
        : null,
    }
  }
  if (drinks.state === "preparing") {
    return {
      headline: "Your drinks are being prepared.",
      secondaryMessage: food.required && food.state === "waiting"
        ? "Waiting for the kitchen to start your food."
        : null,
    }
  }
  if (food.state === "ready") {
    return {
      headline: "Your food is ready.",
      secondaryMessage: drinks.required && drinks.state === "waiting"
        ? "Waiting for the bar to start your drinks."
        : null,
    }
  }
  if (drinks.state === "ready") {
    return {
      headline: "Your drinks are ready.",
      secondaryMessage: food.required && food.state === "waiting"
        ? "Waiting for the kitchen to start your food."
        : null,
    }
  }
  if (food.hasReady || drinks.hasReady) {
    return {
      headline: "Some items are ready.",
      secondaryMessage: "We're still working on the rest of your order.",
    }
  }
  return {
    headline: "Your order is in progress.",
    secondaryMessage: "We're getting everything ready for you.",
  }
}

const GENERIC_PLACED_COPY = Object.freeze({
  headline: "Your order is confirmed.",
  secondaryMessage: "Waiting for preparation to begin.",
})

function projectPlacedCopy(items = []) {
  const hasCompletePendingSnapshot = items.length > 0 && items.every((item) => (
    [FULFILLMENT_STATIONS.KITCHEN, FULFILLMENT_STATIONS.BAR].includes(item.fulfillmentStation) &&
    [FULFILLMENT_BEHAVIORS.PREPARED, FULFILLMENT_BEHAVIORS.DIRECT].includes(item.fulfillmentBehavior) &&
    item.fulfillmentStatus === FULFILLMENT_STATUSES.PENDING &&
    (
      item.fulfillmentStation !== FULFILLMENT_STATIONS.KITCHEN ||
      item.fulfillmentBehavior === FULFILLMENT_BEHAVIORS.PREPARED
    )
  ))
  if (!hasCompletePendingSnapshot) return GENERIC_PLACED_COPY

  const hasKitchen = items.some(
    (item) => item.fulfillmentStation === FULFILLMENT_STATIONS.KITCHEN,
  )
  const barLines = items.filter(
    (item) => item.fulfillmentStation === FULFILLMENT_STATIONS.BAR,
  )
  const hasPreparedBar = barLines.some(
    (item) => item.fulfillmentBehavior === FULFILLMENT_BEHAVIORS.PREPARED,
  )
  const hasDirectBar = barLines.some(
    (item) => item.fulfillmentBehavior === FULFILLMENT_BEHAVIORS.DIRECT,
  )

  if (hasKitchen && barLines.length === 0) {
    return {
      headline: GENERIC_PLACED_COPY.headline,
      secondaryMessage: "Waiting for the kitchen to start preparing your food.",
    }
  }
  if (hasKitchen && hasPreparedBar && !hasDirectBar) {
    return {
      headline: GENERIC_PLACED_COPY.headline,
      secondaryMessage: "Waiting for the kitchen and bar to begin preparation.",
    }
  }
  if (hasKitchen) return GENERIC_PLACED_COPY

  if (hasPreparedBar && hasDirectBar) {
    return {
      headline: GENERIC_PLACED_COPY.headline,
      secondaryMessage: "Waiting for the bar to get started.",
    }
  }
  if (hasPreparedBar) {
    return {
      headline: GENERIC_PLACED_COPY.headline,
      secondaryMessage: "Waiting for the bar to start preparing your drinks.",
    }
  }
  if (hasDirectBar) {
    return {
      headline: GENERIC_PLACED_COPY.headline,
      secondaryMessage: "Waiting for the bar to get your drinks ready.",
    }
  }
  return GENERIC_PLACED_COPY
}

export function getCustomerOrderProgress(order, options = {}) {
  const items = order?.items || []
  const now = validDate(options.now) || new Date()
  const food = projectCustomerStation(items.filter(
    (item) => item.fulfillmentStation === FULFILLMENT_STATIONS.KITCHEN,
  ), now)
  const drinks = projectCustomerStation(items.filter(
    (item) => item.fulfillmentStation === FULFILLMENT_STATIONS.BAR,
  ), now)

  let copy
  if (order?.status === "cancelled") {
    copy = { headline: "This order was cancelled.", secondaryMessage: null }
  } else if (order?.status === "completed") {
    copy = { headline: "Your order has been served.", secondaryMessage: null }
  } else if (order?.status === "ready") {
    copy = { headline: "Your order is ready to be served.", secondaryMessage: null }
  } else if (order?.status === "placed") {
    copy = projectPlacedCopy(items)
  } else {
    copy = projectInProgressCopy(food, drinks)
  }

  if (
    ["in_progress", "preparing"].includes(order?.status) &&
    items.length > 0 &&
    items.every(hasCanonicalFulfillmentLine) &&
    (food.etaState === "extended" || drinks.etaState === "extended")
  ) {
    copy = projectExtendedPreparationCopy(food, drinks)
  }

  const outstandingStations = [food, drinks].filter(
    (station) => station.required && station.state !== "ready",
  )
  const estimableStations = outstandingStations.filter((station) => station.estimatedReadyAt)
  const canEstimateWholeOrder = outstandingStations.length > 0 &&
    outstandingStations.every((station) => station.estimatedReadyAt)

  let etaMode = "none"
  let estimatedReadyAt = null
  let estimateStartedAt = null
  if (order?.status === "in_progress") {
    if (canEstimateWholeOrder) {
      etaMode = "overall"
      const latest = estimableStations.reduce((current, station) => (
        !current || station.estimatedReadyAt > current.estimatedReadyAt ? station : current
      ), null)
      estimatedReadyAt = latest?.estimatedReadyAt || null
      estimateStartedAt = latest?.estimateStartedAt || null
    } else if (estimableStations.length > 0) {
      etaMode = "station"
    }
  }

  const etaState = estimableStations.some((station) => station.etaState === "extended")
    ? "extended"
    : estimableStations.length > 0
      ? "active"
      : "none"
  const assistance = projectWaitingForStartAssistance(order, items, options, now)

  return {
    globalStatus: order?.status || "placed",
    headline: copy.headline,
    secondaryMessage: copy.secondaryMessage,
    etaMode,
    estimatedReadyAt,
    estimateStartedAt,
    etaState,
    ...assistance,
    stationContext: {
      food,
      drinks,
    },
  }
}

export function getCustomerOrderStatusMessage(order, options = {}) {
  return getCustomerOrderProgress(order, options).headline
}

const CUSTOMER_NOTIFICATION_COPY = Object.freeze({
  [CUSTOMER_FULFILLMENT_EVENTS.KITCHEN_STARTED]: {
    title: "Food is being prepared",
    message: "We've started preparing your food.",
  },
  [CUSTOMER_FULFILLMENT_EVENTS.BAR_STARTED]: {
    title: "Drinks are being prepared",
    message: "We've started preparing your drinks.",
  },
  [CUSTOMER_FULFILLMENT_EVENTS.KITCHEN_READY]: {
    title: "Food ready",
    message: "Your food is ready.",
  },
  [CUSTOMER_FULFILLMENT_EVENTS.BAR_READY]: {
    title: "Drinks ready",
    message: "Your drinks are ready.",
  },
  [CUSTOMER_FULFILLMENT_EVENTS.ORDER_READY]: {
    title: "Order ready!",
    message: "Your order is ready to be served.",
  },
  [CUSTOMER_FULFILLMENT_EVENTS.ORDER_SERVED]: {
    title: "Order completed",
    message: "Enjoy!!",
  },
})

function buildCustomerFulfillmentNotification(order, eventType) {
  const copy = CUSTOMER_NOTIFICATION_COPY[eventType]
  if (!copy || !order?.orderId) return null
  return {
    eventId: `${order.orderId}:${eventType}`,
    eventType,
    ...copy,
  }
}

function actorSnapshot(actor = {}) {
  return {
    staffId: String(actor.staffId || actor.id || "").trim() || null,
    name: String(actor.name || "").trim() || null,
    role: String(actor.role || "").trim() || null,
  }
}

function isTransientTransactionError(error) {
  return Boolean(
    error?.hasErrorLabel?.("TransientTransactionError") ||
    error?.hasErrorLabel?.("UnknownTransactionCommitResult"),
  )
}

async function withFulfillmentTransaction(work, { startSession = () => mongoose.startSession() } = {}) {
  let lastError
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const session = await startSession()
    try {
      let result
      await session.withTransaction(async () => {
        result = await work(session)
      }, {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        maxCommitTimeMS: 10_000,
      })
      return result
    } catch (error) {
      lastError = error
      if (!isTransientTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error
    } finally {
      await session.endSession()
    }
  }
  throw lastError
}

function selectedStationLines(order, station, orderLineIds) {
  const stationLines = (order.items || []).filter((item) => item.fulfillmentStation === station)
  if (stationLines.length === 0) {
    throw new OrderFulfillmentError("Order has no lines for this station", "NO_STATION_LINES", 404)
  }
  if (!orderLineIds?.length) return stationLines

  const requested = new Set(orderLineIds.map(String))
  const allById = new Map((order.items || []).map((item) => [String(item.orderLineId), item]))
  for (const lineId of requested) {
    const line = allById.get(lineId)
    if (!line) throw new OrderFulfillmentError("Order line not found", "ORDER_LINE_NOT_FOUND", 404)
    if (line.fulfillmentStation !== station) {
      throw new OrderFulfillmentError(
        "A station cannot update another station's line",
        "CROSS_STATION_FULFILLMENT_FORBIDDEN",
        403,
      )
    }
  }
  return stationLines.filter((item) => requested.has(String(item.orderLineId)))
}

export async function transitionOrderFulfillment({
  businessId, orderId, station, action, orderLineIds, actor,
}, dependencies = {}) {
  if (![FULFILLMENT_STATIONS.KITCHEN, FULFILLMENT_STATIONS.BAR].includes(station)) {
    throw new OrderFulfillmentError("Invalid fulfilment station", "INVALID_FULFILLMENT_STATION")
  }
  if (!FULFILLMENT_ACTION_VALUES.includes(action)) {
    throw new OrderFulfillmentError("Invalid fulfilment action", "INVALID_FULFILLMENT_ACTION")
  }
  if (orderLineIds !== undefined && (!Array.isArray(orderLineIds) || orderLineIds.length === 0)) {
    throw new OrderFulfillmentError("orderLineIds must be a non-empty array", "INVALID_ORDER_LINE_IDS")
  }

  const OrderModel = dependencies.OrderModel || Order
  const runTransaction = dependencies.runTransaction || ((work) => withFulfillmentTransaction(work, dependencies))
  const nowFactory = dependencies.now || (() => new Date())
  const performedBy = actorSnapshot(actor)
  if (!STATION_ROLES[station].has(performedBy.role)) {
    throw new OrderFulfillmentError(
      "This staff role cannot update the selected fulfilment station",
      "FULFILLMENT_ROLE_FORBIDDEN",
      403,
    )
  }

  return runTransaction(async (session) => {
    const order = await OrderModel.findOne({ businessId, orderId }, null, { session })
    if (!order) throw new OrderFulfillmentError("Order not found", "ORDER_NOT_FOUND", 404)
    if (TERMINAL_ORDER_STATUSES.has(order.status)) {
      throw new OrderFulfillmentError(
        "Completed or cancelled orders cannot be changed by a fulfilment station",
        "ORDER_FULFILLMENT_TERMINAL",
        409,
      )
    }

    const now = nowFactory()
    let changed = materializeLegacyOrderFulfillment(order, now)
    const lines = selectedStationLines(order, station, orderLineIds)
    const stationLines = (order.items || []).filter(
      (line) => line.fulfillmentStation === station,
    )
    const orderStatusBefore = order.status
    const stationWasReady = stationLines.length > 0 && stationLines.every(
      (line) => line.fulfillmentStatus === FULFILLMENT_STATUSES.READY,
    )
    const stationPreparationHadStarted = stationLines.some((line) => (
      line.fulfillmentBehavior === FULFILLMENT_BEHAVIORS.PREPARED &&
      (
        line.fulfillmentStatus !== FULFILLMENT_STATUSES.PENDING ||
        Boolean(line.fulfillmentStartedAt)
      )
    ))
    let fulfillmentChanged = false

    if (action === FULFILLMENT_ACTIONS.START) {
      if (lines.some((line) => line.fulfillmentBehavior === FULFILLMENT_BEHAVIORS.DIRECT)) {
        throw new OrderFulfillmentError(
          "Direct items move from pending straight to ready",
          "DIRECT_ITEM_CANNOT_START",
          409,
        )
      }
      for (const line of lines) {
        if (line.fulfillmentStatus !== FULFILLMENT_STATUSES.PENDING) continue
        line.fulfillmentStatus = FULFILLMENT_STATUSES.IN_PROGRESS
        line.fulfillmentStartedAt = line.fulfillmentStartedAt || now
        line.fulfillmentStartedBy = line.fulfillmentStartedBy || performedBy
        changed = true
        fulfillmentChanged = true
      }
    } else {
      if (lines.some(
        (line) => line.fulfillmentBehavior === FULFILLMENT_BEHAVIORS.PREPARED &&
          line.fulfillmentStatus === FULFILLMENT_STATUSES.PENDING,
      )) {
        throw new OrderFulfillmentError(
          "Prepared items must be started before they can be marked ready",
          "PREPARED_ITEM_NOT_STARTED",
          409,
        )
      }
      for (const line of lines) {
        if (line.fulfillmentStatus === FULFILLMENT_STATUSES.READY) continue
        line.fulfillmentStatus = FULFILLMENT_STATUSES.READY
        line.fulfillmentReadyAt = line.fulfillmentReadyAt || now
        line.fulfillmentReadyBy = line.fulfillmentReadyBy || performedBy
        changed = true
        fulfillmentChanged = true
      }
    }

    const derivedStatus = deriveOrderStatusFromLines(order.items)
    if (order.status !== derivedStatus) {
      order.status = derivedStatus
      changed = true
    }
    if (derivedStatus === "ready" && !order.readyAt) order.readyAt = now
    if (changed) await order.save({ session })
    const stationIsReady = stationLines.every(
      (line) => line.fulfillmentStatus === FULFILLMENT_STATUSES.READY,
    )
    let eventType = null
    if (
      fulfillmentChanged &&
      action === FULFILLMENT_ACTIONS.START &&
      !stationPreparationHadStarted
    ) {
      eventType = station === FULFILLMENT_STATIONS.KITCHEN
        ? CUSTOMER_FULFILLMENT_EVENTS.KITCHEN_STARTED
        : CUSTOMER_FULFILLMENT_EVENTS.BAR_STARTED
    } else if (
      fulfillmentChanged &&
      action === FULFILLMENT_ACTIONS.READY &&
      derivedStatus === "ready" &&
      orderStatusBefore !== "ready"
    ) {
      eventType = CUSTOMER_FULFILLMENT_EVENTS.ORDER_READY
    } else if (
      fulfillmentChanged &&
      action === FULFILLMENT_ACTIONS.READY &&
      !stationWasReady &&
      stationIsReady
    ) {
      eventType = station === FULFILLMENT_STATIONS.KITCHEN
        ? CUSTOMER_FULFILLMENT_EVENTS.KITCHEN_READY
        : CUSTOMER_FULFILLMENT_EVENTS.BAR_READY
    }
    return {
      order,
      changed,
      fulfillmentChanged,
      customerNotification: buildCustomerFulfillmentNotification(order, eventType),
    }
  })
}

export async function completeOrderForWaitstaff({ businessId, orderId, actor }, dependencies = {}) {
  const OrderModel = dependencies.OrderModel || Order
  const runTransaction = dependencies.runTransaction || ((work) => withFulfillmentTransaction(work, dependencies))
  const nowFactory = dependencies.now || (() => new Date())
  const performedBy = actorSnapshot(actor)
  if (!HANDOFF_ROLES.has(performedBy.role)) {
    throw new OrderFulfillmentError(
      "Only waitstaff or authorized management can perform final handoff",
      "HANDOFF_ROLE_FORBIDDEN",
      403,
    )
  }

  return runTransaction(async (session) => {
    const order = await OrderModel.findOne({ businessId, orderId }, null, { session })
    if (!order) throw new OrderFulfillmentError("Order not found", "ORDER_NOT_FOUND", 404)
    if (order.status === "cancelled") {
      throw new OrderFulfillmentError("Cancelled orders cannot be served", "ORDER_CANCELLED", 409)
    }
    if (order.status === "completed") {
      return { order, changed: false, replayed: true, customerNotification: null }
    }

    const now = nowFactory()
    materializeLegacyOrderFulfillment(order, now)
    const derivedStatus = deriveOrderStatusFromLines(order.items)
    if (derivedStatus !== "ready") {
      throw new OrderFulfillmentError(
        "Every order line must be ready before the order can be served",
        "ORDER_NOT_READY_TO_SERVE",
        409,
      )
    }
    if (order.paymentChannel === "offline" && order.paymentStatus !== "paid") {
      throw new OrderFulfillmentError(
        "Offline orders must be paid before being served",
        "ORDER_PAYMENT_REQUIRED",
        409,
      )
    }

    order.status = "completed"
    order.completedAt = order.completedAt || now
    order.servedAt = order.servedAt || now
    order.completedBy = order.completedBy || performedBy.name
    order.servedByStaffId = order.servedByStaffId || performedBy.staffId
    order.servedByName = order.servedByName || performedBy.name
    await order.save({ session })
    return {
      order,
      changed: true,
      replayed: false,
      customerNotification: buildCustomerFulfillmentNotification(
        order,
        CUSTOMER_FULFILLMENT_EVENTS.ORDER_SERVED,
      ),
    }
  })
}
