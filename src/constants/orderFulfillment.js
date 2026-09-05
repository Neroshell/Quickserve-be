export const FULFILLMENT_STATIONS = Object.freeze({
  KITCHEN: "kitchen",
  BAR: "bar",
})

export const FULFILLMENT_STATION_VALUES = Object.freeze(Object.values(FULFILLMENT_STATIONS))

export const FULFILLMENT_BEHAVIORS = Object.freeze({
  PREPARED: "prepared",
  DIRECT: "direct",
})

export const FULFILLMENT_BEHAVIOR_VALUES = Object.freeze(Object.values(FULFILLMENT_BEHAVIORS))

export const FULFILLMENT_STATUSES = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  READY: "ready",
})

export const FULFILLMENT_STATUS_VALUES = Object.freeze(Object.values(FULFILLMENT_STATUSES))

export const FULFILLMENT_ACTIONS = Object.freeze({
  START: "start",
  READY: "ready",
})

export const FULFILLMENT_ACTION_VALUES = Object.freeze(Object.values(FULFILLMENT_ACTIONS))

export const CUSTOMER_FULFILLMENT_EVENTS = Object.freeze({
  KITCHEN_STARTED: "KITCHEN_STARTED",
  BAR_STARTED: "BAR_STARTED",
  KITCHEN_READY: "KITCHEN_READY",
  BAR_READY: "BAR_READY",
  ORDER_READY: "ORDER_READY",
  ORDER_SERVED: "ORDER_SERVED",
})

export const ORDER_FULFILLMENT_SCHEMA_VERSION = 1
