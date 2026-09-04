export const INVENTORY_DIMENSIONS = Object.freeze({
    WEIGHT: "weight",
    VOLUME: "volume",
    COUNT: "count",
})

export const INVENTORY_UNIT_DEFINITIONS = Object.freeze({
    g: Object.freeze({
        code: "g",
        dimension: INVENTORY_DIMENSIONS.WEIGHT,
        factorToBase: 1,
        label: "grams",
        allowsFractions: true,
    }),
    kg: Object.freeze({
        code: "kg",
        dimension: INVENTORY_DIMENSIONS.WEIGHT,
        factorToBase: 1000,
        label: "kilograms",
        allowsFractions: true,
    }),
    ml: Object.freeze({
        code: "ml",
        dimension: INVENTORY_DIMENSIONS.VOLUME,
        factorToBase: 1,
        label: "millilitres",
        allowsFractions: true,
    }),
    L: Object.freeze({
        code: "L",
        dimension: INVENTORY_DIMENSIONS.VOLUME,
        factorToBase: 1000,
        label: "litres",
        allowsFractions: true,
    }),
    piece: Object.freeze({
        code: "piece",
        dimension: INVENTORY_DIMENSIONS.COUNT,
        factorToBase: 1,
        label: "pieces",
        allowsFractions: false,
    }),
    bottle: Object.freeze({
        code: "bottle",
        dimension: INVENTORY_DIMENSIONS.COUNT,
        factorToBase: 1,
        label: "bottles",
        allowsFractions: false,
    }),
    can: Object.freeze({
        code: "can",
        dimension: INVENTORY_DIMENSIONS.COUNT,
        factorToBase: 1,
        label: "cans",
        allowsFractions: false,
    }),
    pack: Object.freeze({
        code: "pack",
        dimension: INVENTORY_DIMENSIONS.COUNT,
        factorToBase: 1,
        label: "packs",
        allowsFractions: false,
    }),
    portion: Object.freeze({
        code: "portion",
        dimension: INVENTORY_DIMENSIONS.COUNT,
        factorToBase: 1,
        label: "portions",
        allowsFractions: false,
    }),
})

export const INVENTORY_UNIT_VALUES = Object.freeze(
    Object.keys(INVENTORY_UNIT_DEFINITIONS),
)

// Weight and volume balances are always stored in their smallest canonical
// unit. Count units retain their explicit business meaning.
export const INVENTORY_TRACKING_UNITS = Object.freeze([
    "g",
    "ml",
    "piece",
    "bottle",
    "can",
    "pack",
    "portion",
])

export const INVENTORY_MOVEMENT_TYPES = Object.freeze({
    RECEIVE: "RECEIVE",
    RESERVE: "RESERVE",
    RELEASE: "RELEASE",
    CONSUME: "CONSUME",
    WASTE: "WASTE",
    ADJUSTMENT_INCREASE: "ADJUSTMENT_INCREASE",
    ADJUSTMENT_DECREASE: "ADJUSTMENT_DECREASE",
    COUNT_RECONCILIATION_INCREASE: "COUNT_RECONCILIATION_INCREASE",
    COUNT_RECONCILIATION_DECREASE: "COUNT_RECONCILIATION_DECREASE",
    // Phase 2 migration bridge only. These names deliberately describe the
    // existing order-time decrement/restore behavior without claiming that
    // stock was reserved or physically consumed.
    LEGACY_ORDER_DEDUCTION: "LEGACY_ORDER_DEDUCTION",
    LEGACY_ORDER_RESTORE: "LEGACY_ORDER_RESTORE",
})

export const INVENTORY_MOVEMENT_TYPE_VALUES = Object.freeze(
    Object.values(INVENTORY_MOVEMENT_TYPES),
)

export const PHASE_ONE_MOVEMENT_TYPES = Object.freeze([
    INVENTORY_MOVEMENT_TYPES.RECEIVE,
    INVENTORY_MOVEMENT_TYPES.WASTE,
    INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_INCREASE,
    INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_DECREASE,
])

export const INVENTORY_WASTE_REASONS = Object.freeze([
    "spoilage",
    "damaged",
    "preparation_waste",
    "staff_meal",
    "complimentary",
    "spillage",
    "other",
])

export const INVENTORY_ADJUSTMENT_REASONS = Object.freeze([
    "data_correction",
    "opening_balance_correction",
    "other",
])

export const MAX_INVENTORY_QUANTITY = Number.MAX_SAFE_INTEGER
