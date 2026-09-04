import mongoose from "mongoose"

import {
    ORDER_INVENTORY_AUTHORITIES,
    ORDER_INVENTORY_AUTHORITY_VALUES,
    ORDER_INVENTORY_SEMANTICS,
    ORDER_INVENTORY_SEMANTICS_VALUES,
} from "../constants/orderInventory.js"
import { INVENTORY_UNIT_VALUES, MAX_INVENTORY_QUANTITY } from "../constants/inventory.js"

const SEMANTICS_SET = new Set(ORDER_INVENTORY_SEMANTICS_VALUES)
const AUTHORITY_SET = new Set(ORDER_INVENTORY_AUTHORITY_VALUES)
const UNIT_SET = new Set(INVENTORY_UNIT_VALUES)

export class OrderInventorySemanticsError extends Error {
    constructor(message, code = "INVALID_ORDER_INVENTORY_SEMANTICS") {
        super(message)
        this.name = "OrderInventorySemanticsError"
        this.code = code
        this.statusCode = 400
    }
}

function positiveSafeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_INVENTORY_QUANTITY) {
        throw new OrderInventorySemanticsError(`${field} must be a positive safe integer`)
    }
    return value
}

function normalizeMenuItemId(value) {
    if (!mongoose.isValidObjectId(value)) {
        throw new OrderInventorySemanticsError("menuItemId is invalid")
    }
    return String(value)
}

function optionalMovementId(value, field) {
    if (value === undefined || value === null || value === "") return null
    if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
        throw new OrderInventorySemanticsError(`${field} is invalid`)
    }
    return value.trim()
}

export function buildOrderInventoryDeductionLine({
    menuItemId,
    authority,
    orderQuantity,
    inventoryItemId = null,
    canonicalQuantity = null,
    unit = null,
    mappingVersion = null,
    deductionMovementId = null,
    restorationMovementId = null,
}) {
    if (!AUTHORITY_SET.has(authority)) {
        throw new OrderInventorySemanticsError("Inventory authority is invalid")
    }
    const canonical = authority === ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM
    const normalizedDeductionMovementId = optionalMovementId(
        deductionMovementId,
        "deductionMovementId",
    )
    const normalizedRestorationMovementId = optionalMovementId(
        restorationMovementId,
        "restorationMovementId",
    )
    if (canonical) {
        if (typeof inventoryItemId !== "string" || !inventoryItemId.trim()) {
            throw new OrderInventorySemanticsError("Canonical inventoryItemId is required")
        }
        positiveSafeInteger(canonicalQuantity, "canonicalQuantity")
        if (!UNIT_SET.has(unit)) {
            throw new OrderInventorySemanticsError("Canonical inventory unit is invalid")
        }
        positiveSafeInteger(mappingVersion, "mappingVersion")
        if (!normalizedDeductionMovementId) {
            throw new OrderInventorySemanticsError("Canonical deductionMovementId is required")
        }
    } else if (
        inventoryItemId ||
        canonicalQuantity ||
        unit ||
        mappingVersion ||
        normalizedDeductionMovementId ||
        normalizedRestorationMovementId
    ) {
        throw new OrderInventorySemanticsError(
            "Legacy deduction lines cannot contain canonical linkage",
        )
    }

    return Object.freeze({
        menuItemId: normalizeMenuItemId(menuItemId),
        authority,
        inventoryItemId: canonical ? inventoryItemId.trim() : null,
        orderQuantity: positiveSafeInteger(orderQuantity, "orderQuantity"),
        canonicalQuantity: canonical ? canonicalQuantity : null,
        unit: canonical ? unit : null,
        mappingVersion: canonical ? mappingVersion : null,
        deductionMovementId: normalizedDeductionMovementId,
        restorationMovementId: normalizedRestorationMovementId,
    })
}

export function buildOrderInventorySemanticsStamp(lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
        return Object.freeze({
            inventorySemanticsVersion: ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1,
            inventoryDeductionLines: [],
        })
    }
    const normalizedLines = lines.map(buildOrderInventoryDeductionLine)
    const authorities = new Set(normalizedLines.map((line) => line.authority))
    const inventorySemanticsVersion = authorities.size > 1
        ? ORDER_INVENTORY_SEMANTICS.MIXED_BRIDGE_V1
        : authorities.has(ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM)
            ? ORDER_INVENTORY_SEMANTICS.CANONICAL_SIMPLE_BRIDGE_V1
            : ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1
    return Object.freeze({ inventorySemanticsVersion, inventoryDeductionLines: normalizedLines })
}

export function resolveOrderInventorySemantics(orderValue) {
    const order = typeof orderValue?.toObject === "function"
        ? orderValue.toObject({ depopulate: true })
        : orderValue || {}
    const rawVersion = order.inventorySemanticsVersion
    const version = rawVersion === undefined || rawVersion === null || rawVersion === ""
        ? ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1
        : rawVersion
    if (!SEMANTICS_SET.has(version)) {
        throw new OrderInventorySemanticsError("Order inventory semantics version is invalid")
    }
    const lines = Array.isArray(order.inventoryDeductionLines)
        ? order.inventoryDeductionLines.map((line) => buildOrderInventoryDeductionLine(
            typeof line?.toObject === "function"
                ? line.toObject({ depopulate: true })
                : line,
        ))
        : []

    const authorities = new Set(lines.map((line) => line.authority))
    if (
        version === ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1 &&
        authorities.has(ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM)
    ) {
        throw new OrderInventorySemanticsError(
            "Legacy order semantics cannot contain canonical inventory deductions",
        )
    }
    if (
        version === ORDER_INVENTORY_SEMANTICS.CANONICAL_SIMPLE_BRIDGE_V1 &&
        (
            lines.length === 0 ||
            authorities.size !== 1 ||
            !authorities.has(ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM)
        )
    ) {
        throw new OrderInventorySemanticsError(
            "Canonical order semantics require only canonical inventory deductions",
        )
    }
    if (
        version === ORDER_INVENTORY_SEMANTICS.MIXED_BRIDGE_V1 &&
        (
            !authorities.has(ORDER_INVENTORY_AUTHORITIES.LEGACY_MENU_ITEM) ||
            !authorities.has(ORDER_INVENTORY_AUTHORITIES.CANONICAL_INVENTORY_ITEM)
        )
    ) {
        throw new OrderInventorySemanticsError(
            "Mixed order semantics require both legacy and canonical deductions",
        )
    }
    return Object.freeze({ version, lines })
}

export function resolveOrderRestorationAuthority(orderValue) {
    const semantics = resolveOrderInventorySemantics(orderValue)
    if (semantics.version !== ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1) {
        if (semantics.lines.length === 0) {
            throw new OrderInventorySemanticsError(
                "Canonical or mixed order inventory semantics require deduction linkage",
            )
        }
        return semantics
    }

    // The absence of a version on historical orders is an explicit legacy
    // boundary. A mapping activated later must never change this decision.
    return Object.freeze({
        version: ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1,
        lines: semantics.lines,
    })
}
