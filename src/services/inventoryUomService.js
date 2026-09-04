import {
    INVENTORY_DIMENSIONS,
    INVENTORY_TRACKING_UNITS,
    INVENTORY_UNIT_DEFINITIONS,
    MAX_INVENTORY_QUANTITY,
} from "../constants/inventory.js"

const MAX_DECIMAL_PLACES = 9
const MAX_SAFE_QUANTITY_BIGINT = BigInt(MAX_INVENTORY_QUANTITY)
const TRACKING_UNIT_SET = new Set(INVENTORY_TRACKING_UNITS)

export class InventoryUomError extends Error {
    constructor(message, code = "INVALID_INVENTORY_UNIT") {
        super(message)
        this.name = "InventoryUomError"
        this.code = code
        this.statusCode = 400
    }
}

export function normalizeInventoryUnitCode(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw new InventoryUomError("unit is required")
    }

    const trimmed = value.trim()
    const normalized = trimmed.toLowerCase() === "l"
        ? "L"
        : trimmed.toLowerCase()

    if (!INVENTORY_UNIT_DEFINITIONS[normalized]) {
        throw new InventoryUomError(`Unsupported inventory unit: ${trimmed}`)
    }

    return normalized
}

export function getInventoryUnitDefinition(value) {
    const code = normalizeInventoryUnitCode(value)
    return INVENTORY_UNIT_DEFINITIONS[code]
}

export function getInventoryTrackingUnitDefinition(value) {
    const code = normalizeInventoryUnitCode(value)
    if (!TRACKING_UNIT_SET.has(code)) {
        throw new InventoryUomError(
            `${code} cannot be used as a canonical tracking unit`,
            "INVALID_TRACKING_UNIT",
        )
    }
    return INVENTORY_UNIT_DEFINITIONS[code]
}

function parsePositiveDecimal(value) {
    if (typeof value !== "string" && typeof value !== "number") {
        throw new InventoryUomError("quantity must be a positive number", "INVALID_QUANTITY")
    }

    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new InventoryUomError("quantity must be a positive number", "INVALID_QUANTITY")
    }

    const raw = String(value).trim()
    const match = raw.match(/^(\d+)(?:\.(\d+))?$/)
    if (!match) {
        throw new InventoryUomError(
            "quantity must be a positive decimal without exponent notation",
            "INVALID_QUANTITY",
        )
    }

    const fraction = match[2] || ""
    if (fraction.length > MAX_DECIMAL_PLACES) {
        throw new InventoryUomError(
            `quantity cannot have more than ${MAX_DECIMAL_PLACES} decimal places`,
            "INVALID_QUANTITY",
        )
    }

    const scale = 10n ** BigInt(fraction.length)
    const numerator = BigInt(`${match[1]}${fraction}`)
    if (numerator <= 0n) {
        throw new InventoryUomError("quantity must be greater than zero", "INVALID_QUANTITY")
    }

    return { numerator, scale }
}

/**
 * Convert a submitted quantity to the item's integer canonical tracking unit.
 * No density, package-size, or semantic count conversion is inferred.
 */
export function normalizeInventoryQuantity({ quantity, unit, trackingUnit }) {
    const inputUnit = normalizeInventoryUnitCode(unit)
    const canonicalTrackingUnit = normalizeInventoryUnitCode(trackingUnit)
    const inputDefinition = INVENTORY_UNIT_DEFINITIONS[inputUnit]
    const trackingDefinition = getInventoryTrackingUnitDefinition(canonicalTrackingUnit)

    if (inputDefinition.dimension !== trackingDefinition.dimension) {
        throw new InventoryUomError(
            `Cannot convert ${inputUnit} to ${canonicalTrackingUnit}`,
            "INCOMPATIBLE_INVENTORY_UNIT",
        )
    }

    if (
        inputDefinition.dimension === INVENTORY_DIMENSIONS.COUNT &&
        inputUnit !== canonicalTrackingUnit
    ) {
        throw new InventoryUomError(
            `Count unit ${inputUnit} cannot be treated as ${canonicalTrackingUnit}`,
            "INCOMPATIBLE_INVENTORY_UNIT",
        )
    }

    const { numerator, scale } = parsePositiveDecimal(quantity)
    const convertedNumerator = numerator * BigInt(inputDefinition.factorToBase)
    const convertedDenominator = scale * BigInt(trackingDefinition.factorToBase)

    if (convertedNumerator % convertedDenominator !== 0n) {
        throw new InventoryUomError(
            `quantity must resolve to a whole ${canonicalTrackingUnit}`,
            "FRACTIONAL_CANONICAL_QUANTITY",
        )
    }

    const canonicalQuantity = convertedNumerator / convertedDenominator
    if (canonicalQuantity > MAX_SAFE_QUANTITY_BIGINT) {
        throw new InventoryUomError(
            "quantity exceeds the maximum safe inventory quantity",
            "INVENTORY_QUANTITY_OVERFLOW",
        )
    }

    return Object.freeze({
        submittedUnit: inputUnit,
        trackingUnit: canonicalTrackingUnit,
        dimension: trackingDefinition.dimension,
        canonicalQuantity: Number(canonicalQuantity),
    })
}

