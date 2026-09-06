import crypto from "node:crypto"
import mongoose from "mongoose"
import {
    INVENTORY_ADJUSTMENT_REASONS,
    INVENTORY_MOVEMENT_TYPES,
    INVENTORY_WASTE_REASONS,
    MAX_INVENTORY_QUANTITY,
} from "../constants/inventory.js"
import InventoryItem, { generateInventoryItemId } from "../models/InventoryItem.js"
import InventoryMovement, { generateInventoryMovementId } from "../models/InventoryMovement.js"
import {
    getInventoryTrackingUnitDefinition,
    normalizeInventoryQuantity,
} from "./inventoryUomService.js"

const ITEM_CREATE_FIELDS = new Set([
    "name",
    "category",
    "trackingUnit",
    "lowStockThreshold",
    "unitCostMinor",
    "costCurrency",
    "isActive",
])
const ITEM_UPDATE_FIELDS = new Set(ITEM_CREATE_FIELDS)
const RECEIVE_FIELDS = new Set([
    "quantity",
    "unit",
    "unitCostMinor",
    "costCurrency",
    "reference",
    "note",
])
const WASTE_FIELDS = new Set([
    "quantity",
    "unit",
    "reason",
    "reference",
    "note",
])
const ADJUSTMENT_FIELDS = new Set([
    "quantity",
    "unit",
    "direction",
    "reason",
    "reference",
    "note",
])
const BALANCE_FIELDS = new Set([
    "onHandQuantity",
    "reservedQuantity",
    "availableQuantity",
])
const WASTE_REASON_SET = new Set(INVENTORY_WASTE_REASONS)
const ADJUSTMENT_REASON_SET = new Set(INVENTORY_ADJUSTMENT_REASONS)
const MAX_TRANSACTION_ATTEMPTS = 3

export class InventoryDomainError extends Error {
    constructor(message, { code = "INVENTORY_ERROR", statusCode = 400, details = null } = {}) {
        super(message)
        this.name = "InventoryDomainError"
        this.code = code
        this.statusCode = statusCode
        this.details = details
    }
}

function domainError(message, code, statusCode = 400, details = null) {
    return new InventoryDomainError(message, { code, statusCode, details })
}

function toPlain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : { ...value }
}

export function toInventoryItemDTO(value) {
    const item = toPlain(value)
    if (!item) return null

    return {
        inventoryItemId: item.inventoryItemId,
        name: item.name,
        category: item.category ?? null,
        trackingUnit: item.trackingUnit,
        baseUnitDimension: item.baseUnitDimension,
        onHandQuantity: item.onHandQuantity,
        reservedQuantity: item.reservedQuantity,
        availableQuantity: item.onHandQuantity - item.reservedQuantity,
        lowStockThreshold: item.lowStockThreshold,
        unitCostMinor: item.unitCostMinor ?? null,
        costCurrency: item.costCurrency ?? null,
        isActive: item.isActive !== false,
        isDeleted: Boolean(item.deletedAt),
        deletedAt: item.deletedAt ?? null,
        createdAt: item.createdAt ?? null,
        updatedAt: item.updatedAt ?? null,
    }
}

export function toInventoryMovementDTO(value) {
    const movement = toPlain(value)
    if (!movement) return null

    return {
        movementId: movement.movementId,
        inventoryItemId: movement.inventoryItemId,
        type: movement.type,
        quantityDeltaOnHand: movement.quantityDeltaOnHand,
        quantityDeltaReserved: movement.quantityDeltaReserved,
        unit: movement.unit,
        canonicalQuantity: movement.canonicalQuantity,
        onHandBefore: movement.onHandBefore,
        onHandAfter: movement.onHandAfter,
        reservedBefore: movement.reservedBefore,
        reservedAfter: movement.reservedAfter,
        availableBefore: movement.onHandBefore - movement.reservedBefore,
        availableAfter: movement.onHandAfter - movement.reservedAfter,
        sourceType: movement.sourceType,
        sourceId: movement.sourceId ?? null,
        inventoryReservationId: movement.inventoryReservationId ?? null,
        orderId: movement.orderId ?? null,
        orderLineIds: Array.isArray(movement.orderLineIds) ? [...movement.orderLineIds] : [],
        allocationIds: Array.isArray(movement.allocationIds) ? [...movement.allocationIds] : [],
        fulfillmentStation: movement.fulfillmentStation ?? null,
        fulfillmentAction: movement.fulfillmentAction ?? null,
        reasonCode: movement.reasonCode ?? null,
        note: movement.note ?? null,
        performedBy: movement.performedBy ? { ...movement.performedBy } : null,
        unitCostMinor: movement.unitCostMinor ?? null,
        costCurrency: movement.costCurrency ?? null,
        createdAt: movement.createdAt ?? null,
    }
}

function normalizeRequiredText(value, field, maxLength) {
    if (typeof value !== "string" || !value.trim()) {
        throw domainError(`${field} is required`, "INVALID_INVENTORY_INPUT")
    }
    const normalized = value.trim().replace(/\s+/g, " ")
    if (normalized.length > maxLength) {
        throw domainError(
            `${field} cannot exceed ${maxLength} characters`,
            "INVALID_INVENTORY_INPUT",
        )
    }
    return normalized
}

function normalizeOptionalText(value, field, maxLength) {
    if (value === undefined || value === null || value === "") return null
    if (typeof value !== "string") {
        throw domainError(`${field} must be a string`, "INVALID_INVENTORY_INPUT")
    }
    const normalized = value.trim().replace(/\s+/g, " ")
    if (!normalized) return null
    if (normalized.length > maxLength) {
        throw domainError(
            `${field} cannot exceed ${maxLength} characters`,
            "INVALID_INVENTORY_INPUT",
        )
    }
    return normalized
}

export function normalizeInventoryItemName(value) {
    return normalizeRequiredText(value, "name", 120).toLocaleLowerCase("en-US")
}

export function normalizeInventoryItemCategory(value) {
    return (normalizeOptionalText(value, "category", 80) || "").toLocaleLowerCase("en-US")
}

function buildDuplicateIdentityKey({ normalizedName, normalizedCategory, trackingUnit }) {
    return `v1:${crypto.createHash("sha256").update(JSON.stringify([
        normalizedName,
        trackingUnit,
        normalizedCategory,
    ])).digest("hex")}`
}

function escapeRegularExpression(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function legacyNormalizedNamePattern(normalizedName) {
    return new RegExp(
        `^\\s*${normalizedName.split(" ").map(escapeRegularExpression).join("\\s+")}\\s*$`,
        "iu",
    )
}

export function toInventoryDuplicateCandidate(value) {
    const item = toPlain(value)
    if (!item) return null
    return {
        inventoryItemId: item.inventoryItemId,
        name: item.name,
        category: item.category ?? null,
        trackingUnit: item.trackingUnit,
        isActive: item.isActive !== false,
        availableQuantity: item.onHandQuantity - item.reservedQuantity,
    }
}

export function createInventoryDuplicateError(item, conflictType = "strong") {
    const candidate = toInventoryDuplicateCandidate(item)
    const strong = conflictType === "strong"
    return domainError(
        strong
            ? `An inventory item named ${candidate.name} already exists with this tracking unit and category.`
            : `Another ${candidate.name} item with this tracking unit exists under a different category.`,
        strong ? "INVENTORY_ITEM_DUPLICATE" : "INVENTORY_ITEM_CATEGORY_VARIANT",
        409,
        {
            conflictType: strong ? "strong" : "category_variant",
            candidate,
            canContinue: !strong,
        },
    )
}

export async function findInventoryItemDuplicateSignal({
    businessId,
    name,
    category,
    trackingUnit,
    excludeInventoryItemId = null,
    session = null,
}, { InventoryItemModel = InventoryItem } = {}) {
    const tenantId = normalizeRequiredText(businessId, "businessId", 200)
    const normalizedName = normalizeInventoryItemName(name)
    const normalizedCategory = normalizeInventoryItemCategory(category)
    const unit = getInventoryTrackingUnitDefinition(trackingUnit).code
    if (typeof InventoryItemModel.find !== "function") {
        return { strong: null, categoryVariant: null }
    }

    const filter = {
        businessId: tenantId,
        trackingUnit: unit,
        deletedAt: null,
        $or: [
            { normalizedName },
            { normalizedName: { $exists: false }, name: legacyNormalizedNamePattern(normalizedName) },
            { normalizedName: null, name: legacyNormalizedNamePattern(normalizedName) },
        ],
    }
    if (excludeInventoryItemId) filter.inventoryItemId = { $ne: excludeInventoryItemId }
    const candidates = await InventoryItemModel.find(
        filter,
        null,
        session ? { session } : undefined,
    )
    const ordered = [...(candidates || [])].sort(
        (left, right) => Number(left.isActive === false) - Number(right.isActive === false),
    )
    const strong = ordered.find(
        (candidate) => normalizeInventoryItemCategory(candidate.category) === normalizedCategory,
    ) || null
    const categoryVariant = ordered.find(
        (candidate) => normalizeInventoryItemCategory(candidate.category) !== normalizedCategory,
    ) || null
    return { strong, categoryVariant }
}

async function enforceInventoryDuplicatePolicy({
    businessId,
    name,
    category,
    trackingUnit,
    excludeInventoryItemId = null,
    allowCategoryVariant = false,
    session = null,
}, dependencies = {}) {
    if (typeof allowCategoryVariant !== "boolean") {
        throw domainError(
            "allowCategoryVariant must be boolean",
            "INVALID_INVENTORY_INPUT",
        )
    }
    const signal = await findInventoryItemDuplicateSignal({
        businessId,
        name,
        category,
        trackingUnit,
        excludeInventoryItemId,
        session,
    }, dependencies)
    if (signal.strong) throw createInventoryDuplicateError(signal.strong, "strong")
    if (signal.categoryVariant && !allowCategoryVariant) {
        throw createInventoryDuplicateError(signal.categoryVariant, "category_variant")
    }
    return signal
}

function isStrongIdentityDuplicateKey(error) {
    return error?.code === 11000 && Boolean(
        error?.keyPattern?.duplicateIdentityKey ||
        Object.prototype.hasOwnProperty.call(error?.keyValue || {}, "duplicateIdentityKey"),
    )
}

function unresolvedInventoryDuplicateError(identity) {
    const error = domainError(
        "An inventory item with this name, tracking unit, and category already exists.",
        "INVENTORY_ITEM_DUPLICATE",
        409,
    )
    error.duplicateIdentity = identity
    return error
}

export async function enrichInventoryDuplicateError(error, identity, dependencies = {}) {
    if (error?.code !== "INVENTORY_ITEM_DUPLICATE" && !isStrongIdentityDuplicateKey(error)) {
        return error
    }
    if (error?.details?.candidate) return error
    const signal = await findInventoryItemDuplicateSignal(identity, dependencies)
    return signal.strong ? createInventoryDuplicateError(signal.strong, "strong") : error
}

function normalizeNonNegativeSafeInteger(value, field, { nullable = false } = {}) {
    if (value === undefined || value === null || value === "") {
        if (nullable) return null
        throw domainError(
            `${field} must be a non-negative safe integer`,
            "INVALID_INVENTORY_INPUT",
        )
    }
    if (typeof value !== "number" && typeof value !== "string") {
        throw domainError(
            `${field} must be a non-negative safe integer`,
            "INVALID_INVENTORY_INPUT",
        )
    }
    if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
        throw domainError(
            `${field} must be a non-negative safe integer`,
            "INVALID_INVENTORY_INPUT",
        )
    }
    const parsed = typeof value === "number" ? value : Number(value.trim())
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_INVENTORY_QUANTITY) {
        throw domainError(
            `${field} must be a non-negative safe integer`,
            "INVALID_INVENTORY_INPUT",
        )
    }
    return parsed
}

function normalizeCurrency(value, { nullable = false } = {}) {
    if (nullable && (value === undefined || value === null || value === "")) return null
    if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value.trim())) {
        throw domainError("costCurrency must be a three-letter currency code", "INVALID_INVENTORY_INPUT")
    }
    return value.trim().toUpperCase()
}

function normalizeCostPair({ unitCostMinor, costCurrency }, { current = null } = {}) {
    const costProvided = unitCostMinor !== undefined
    const currencyProvided = costCurrency !== undefined
    if (!costProvided && !currencyProvided) return current

    const finalCost = costProvided
        ? normalizeNonNegativeSafeInteger(unitCostMinor, "unitCostMinor", { nullable: true })
        : current?.unitCostMinor ?? null
    const finalCurrency = currencyProvided
        ? normalizeCurrency(costCurrency, { nullable: true })
        : current?.costCurrency ?? null

    if ((finalCost === null) !== (finalCurrency === null)) {
        throw domainError(
            "unitCostMinor and costCurrency must be provided or cleared together",
            "INVALID_INVENTORY_COST",
        )
    }
    return { unitCostMinor: finalCost, costCurrency: finalCurrency }
}

function rejectUnknownFields(input, allowedFields) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw domainError("request body must be an object", "INVALID_INVENTORY_INPUT")
    }

    for (const field of Object.keys(input)) {
        if (BALANCE_FIELDS.has(field)) {
            throw domainError(
                `${field} can only be changed through an inventory movement`,
                "INVENTORY_BALANCE_FIELD_FORBIDDEN",
            )
        }
        if (!allowedFields.has(field)) {
            throw domainError(`Unsupported inventory field: ${field}`, "INVALID_INVENTORY_INPUT")
        }
    }
}

function normalizeItemCreateInput(input) {
    rejectUnknownFields(input, ITEM_CREATE_FIELDS)
    const trackingDefinition = getInventoryTrackingUnitDefinition(input.trackingUnit)
    const name = normalizeRequiredText(input.name, "name", 120)
    const category = normalizeOptionalText(input.category, "category", 80)
    const normalizedName = normalizeInventoryItemName(name)
    const normalizedCategory = normalizeInventoryItemCategory(category)
    const cost = normalizeCostPair(input, { current: { unitCostMinor: null, costCurrency: null } })
    if (input.isActive !== undefined && typeof input.isActive !== "boolean") {
        throw domainError("isActive must be a boolean", "INVALID_INVENTORY_INPUT")
    }

    return {
        name,
        normalizedName,
        category,
        normalizedCategory,
        trackingUnit: trackingDefinition.code,
        duplicateIdentityKey: buildDuplicateIdentityKey({
            normalizedName,
            normalizedCategory,
            trackingUnit: trackingDefinition.code,
        }),
        baseUnitDimension: trackingDefinition.dimension,
        lowStockThreshold: input.lowStockThreshold === undefined
            ? 0
            : normalizeNonNegativeSafeInteger(input.lowStockThreshold, "lowStockThreshold"),
        unitCostMinor: cost?.unitCostMinor ?? null,
        costCurrency: cost?.costCurrency ?? null,
        isActive: input.isActive ?? true,
    }
}

function isDuplicateKeyError(error) {
    return error?.code === 11000
}

export async function createInventoryItem({
    businessId,
    input,
    allowCategoryVariant = false,
    session = null,
}, {
    InventoryItemModel = InventoryItem,
    generateId = generateInventoryItemId,
} = {}) {
    const tenantId = normalizeRequiredText(businessId, "businessId", 200)
    const normalized = normalizeItemCreateInput(input)

    await enforceInventoryDuplicatePolicy({
        businessId: tenantId,
        name: normalized.name,
        category: normalized.category,
        trackingUnit: normalized.trackingUnit,
        allowCategoryVariant,
        session,
    }, { InventoryItemModel })

    const maximumAttempts = session ? 1 : 3
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        try {
            const itemInput = {
                inventoryItemId: generateId(),
                businessId: tenantId,
                ...normalized,
                onHandQuantity: 0,
                reservedQuantity: 0,
            }
            const item = session
                ? (await InventoryItemModel.create([itemInput], { session }))[0]
                : await InventoryItemModel.create(itemInput)
            return toInventoryItemDTO(item)
        } catch (error) {
            if (isStrongIdentityDuplicateKey(error)) {
                const identity = {
                    businessId: tenantId,
                    name: normalized.name,
                    category: normalized.category,
                    trackingUnit: normalized.trackingUnit,
                }
                if (session) throw unresolvedInventoryDuplicateError(identity)
                throw await enrichInventoryDuplicateError(error, identity, { InventoryItemModel })
            }
            if (isDuplicateKeyError(error) && attempt < maximumAttempts - 1) continue
            throw error
        }
    }

    throw domainError("Unable to generate an inventory item ID", "INVENTORY_ID_COLLISION", 500)
}

export async function updateInventoryItem({
    businessId,
    inventoryItemId,
    input,
    allowCategoryVariant = false,
    session = null,
}, {
    InventoryItemModel = InventoryItem,
    InventoryMovementModel = InventoryMovement,
} = {}) {
    const tenantId = normalizeRequiredText(businessId, "businessId", 200)
    const itemId = normalizeRequiredText(inventoryItemId, "inventoryItemId", 100)
    rejectUnknownFields(input, ITEM_UPDATE_FIELDS)
    if (Object.keys(input).length === 0) {
        throw domainError("No inventory fields were provided", "INVALID_INVENTORY_INPUT")
    }

    const item = await InventoryItemModel.findOne({
        businessId: tenantId,
        inventoryItemId: itemId,
    }, null, session ? { session } : undefined)
    if (!item) {
        throw domainError("Inventory item not found", "INVENTORY_ITEM_NOT_FOUND", 404)
    }
    if (item.deletedAt) {
        throw domainError(
            "Deleted inventory items cannot be changed",
            "INVENTORY_ITEM_DELETED",
            409,
        )
    }

    const requestedName = input.name === undefined
        ? item.name
        : normalizeRequiredText(input.name, "name", 120)
    const requestedCategory = input.category === undefined
        ? item.category ?? null
        : normalizeOptionalText(input.category, "category", 80)
    let requestedTrackingUnit = item.trackingUnit

    if (input.trackingUnit !== undefined) {
        const definition = getInventoryTrackingUnitDefinition(input.trackingUnit)
        if (definition.code !== item.trackingUnit) {
            const hasMovement = await InventoryMovementModel.exists(
                { businessId: tenantId, inventoryItemId: itemId },
                session ? { session } : undefined,
            )
            if (item.onHandQuantity !== 0 || item.reservedQuantity !== 0 || hasMovement) {
                throw domainError(
                    "trackingUnit cannot change after balances or movements exist",
                    "INVENTORY_TRACKING_UNIT_LOCKED",
                    409,
                )
            }
            requestedTrackingUnit = definition.code
        }
    }

    const currentNormalizedName = normalizeInventoryItemName(item.name)
    const currentNormalizedCategory = normalizeInventoryItemCategory(item.category)
    const requestedNormalizedName = normalizeInventoryItemName(requestedName)
    const requestedNormalizedCategory = normalizeInventoryItemCategory(requestedCategory)
    const identitySignalChanged = requestedNormalizedName !== currentNormalizedName ||
        requestedNormalizedCategory !== currentNormalizedCategory ||
        requestedTrackingUnit !== item.trackingUnit

    if (identitySignalChanged) {
        await enforceInventoryDuplicatePolicy({
            businessId: tenantId,
            name: requestedName,
            category: requestedCategory,
            trackingUnit: requestedTrackingUnit,
            excludeInventoryItemId: itemId,
            allowCategoryVariant,
            session,
        }, { InventoryItemModel })
        item.normalizedName = requestedNormalizedName
        item.normalizedCategory = requestedNormalizedCategory
        item.duplicateIdentityKey = buildDuplicateIdentityKey({
            normalizedName: requestedNormalizedName,
            normalizedCategory: requestedNormalizedCategory,
            trackingUnit: requestedTrackingUnit,
        })
    }

    if (input.name !== undefined) item.name = requestedName
    if (input.category !== undefined) item.category = requestedCategory
    if (input.lowStockThreshold !== undefined) {
        item.lowStockThreshold = normalizeNonNegativeSafeInteger(
            input.lowStockThreshold,
            "lowStockThreshold",
        )
    }
    if (input.isActive !== undefined) {
        if (typeof input.isActive !== "boolean") {
            throw domainError("isActive must be a boolean", "INVALID_INVENTORY_INPUT")
        }
        item.isActive = input.isActive
    }

    const cost = normalizeCostPair(input, { current: item })
    if (cost) {
        item.unitCostMinor = cost.unitCostMinor
        item.costCurrency = cost.costCurrency
    }

    if (requestedTrackingUnit !== item.trackingUnit) {
        const definition = getInventoryTrackingUnitDefinition(requestedTrackingUnit)
        item.trackingUnit = definition.code
        item.baseUnitDimension = definition.dimension
    }

    try {
        await item.save(session ? { session } : undefined)
    } catch (error) {
        if (!isStrongIdentityDuplicateKey(error)) throw error
        const identity = {
            businessId: tenantId,
            name: requestedName,
            category: requestedCategory,
            trackingUnit: requestedTrackingUnit,
            excludeInventoryItemId: itemId,
        }
        if (session) throw unresolvedInventoryDuplicateError(identity)
        throw await enrichInventoryDuplicateError(error, identity, { InventoryItemModel })
    }
    return toInventoryItemDTO(item)
}

function normalizeIdempotencyKey(value) {
    return normalizeRequiredText(value, "Idempotency-Key", 200)
}

function normalizeActor(actor) {
    if (!actor || typeof actor !== "object") {
        throw domainError("Authenticated actor is required", "INVENTORY_ACTOR_REQUIRED", 401)
    }
    return {
        staffId: normalizeRequiredText(actor.staffId, "actor.staffId", 200),
        role: normalizeRequiredText(actor.role, "actor.role", 80),
        name: normalizeRequiredText(actor.name, "actor.name", 160),
    }
}

function fingerprint(payload) {
    return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

function normalizeMovementOperation({ operation, input, item, actor }) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw domainError("request body must be an object", "INVALID_INVENTORY_INPUT")
    }

    const allowedFields = operation === "receive"
        ? RECEIVE_FIELDS
        : operation === "waste"
            ? WASTE_FIELDS
            : operation === "adjust"
                ? ADJUSTMENT_FIELDS
                : null
    if (!allowedFields) {
        throw domainError("Unsupported inventory operation", "INVALID_INVENTORY_OPERATION")
    }
    rejectUnknownFields(input, allowedFields)

    const normalizedQuantity = normalizeInventoryQuantity({
        quantity: input.quantity,
        unit: input.unit,
        trackingUnit: item.trackingUnit,
    })
    const note = normalizeOptionalText(input.note, "note", 1000)
    const sourceId = normalizeOptionalText(input.reference, "reference", 200)
    let type
    let sourceType
    let reasonCode = null
    let quantityDeltaOnHand
    let movementCost = { unitCostMinor: null, costCurrency: null }

    if (operation === "receive") {
        type = INVENTORY_MOVEMENT_TYPES.RECEIVE
        sourceType = "manual_receive"
        quantityDeltaOnHand = normalizedQuantity.canonicalQuantity
        movementCost = normalizeCostPair(input, {
            current: { unitCostMinor: null, costCurrency: null },
        }) || movementCost
    } else if (operation === "waste") {
        reasonCode = normalizeRequiredText(input.reason, "reason", 100)
        if (!WASTE_REASON_SET.has(reasonCode)) {
            throw domainError("Invalid waste reason", "INVALID_INVENTORY_WASTE_REASON")
        }
        type = INVENTORY_MOVEMENT_TYPES.WASTE
        sourceType = "manual_waste"
        quantityDeltaOnHand = -normalizedQuantity.canonicalQuantity
    } else if (operation === "adjust") {
        const direction = normalizeRequiredText(input.direction, "direction", 20).toLowerCase()
        if (!new Set(["increase", "decrease"]).has(direction)) {
            throw domainError(
                "direction must be increase or decrease",
                "INVALID_INVENTORY_ADJUSTMENT_DIRECTION",
            )
        }
        reasonCode = normalizeRequiredText(input.reason, "reason", 100)
        if (!ADJUSTMENT_REASON_SET.has(reasonCode)) {
            throw domainError("Invalid adjustment reason", "INVALID_INVENTORY_ADJUSTMENT_REASON")
        }
        const increase = direction === "increase"
        type = increase
            ? INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_INCREASE
            : INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_DECREASE
        sourceType = "manual_adjustment"
        quantityDeltaOnHand = increase
            ? normalizedQuantity.canonicalQuantity
            : -normalizedQuantity.canonicalQuantity
    }

    const fingerprintPayload = {
        businessId: item.businessId,
        inventoryItemId: item.inventoryItemId,
        operation,
        type,
        submittedUnit: normalizedQuantity.submittedUnit,
        canonicalQuantity: normalizedQuantity.canonicalQuantity,
        sourceId,
        reasonCode,
        note,
        actorStaffId: actor.staffId,
        unitCostMinor: movementCost.unitCostMinor ?? null,
        costCurrency: movementCost.costCurrency ?? null,
    }

    return {
        ...normalizedQuantity,
        type,
        sourceType,
        sourceId,
        reasonCode,
        note,
        quantityDeltaOnHand,
        quantityDeltaReserved: 0,
        unitCostMinor: movementCost.unitCostMinor ?? null,
        costCurrency: movementCost.costCurrency ?? null,
        requestFingerprint: fingerprint(fingerprintPayload),
    }
}

function isTransientTransactionError(error) {
    return Boolean(
        error?.hasErrorLabel?.("TransientTransactionError") ||
        error?.hasErrorLabel?.("UnknownTransactionCommitResult"),
    )
}

export async function withCanonicalInventoryTransaction(work, {
    startSession = () => mongoose.startSession(),
} = {}) {
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
            if (!isTransientTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS) {
                throw error
            }
        } finally {
            await session.endSession()
        }
    }
    throw lastError
}

function buildMovementResult({ item, movement, replayed }) {
    return {
        item: toInventoryItemDTO(item),
        movement: toInventoryMovementDTO(movement),
        replayed,
    }
}

async function executeMovement({
    businessId,
    inventoryItemId,
    operation,
    input,
    actor,
    idempotencyKey,
    session = null,
}, {
    InventoryItemModel = InventoryItem,
    InventoryMovementModel = InventoryMovement,
    startSession = () => mongoose.startSession(),
    generateMovementId = generateInventoryMovementId,
} = {}) {
    const tenantId = normalizeRequiredText(businessId, "businessId", 200)
    const itemId = normalizeRequiredText(inventoryItemId, "inventoryItemId", 100)
    const key = normalizeIdempotencyKey(idempotencyKey)
    const performedBy = normalizeActor(actor)

    const applyWithinTransaction = async (session) => {
        const item = await InventoryItemModel.findOne(
            { businessId: tenantId, inventoryItemId: itemId },
            null,
            { session },
        )
        if (!item) {
            throw domainError("Inventory item not found", "INVENTORY_ITEM_NOT_FOUND", 404)
        }
        if (item.deletedAt) {
            throw domainError(
                "Inventory item has been removed",
                "INVENTORY_ITEM_DELETED",
                409,
            )
        }
        if (item.isActive === false) {
            throw domainError("Inventory item is inactive", "INVENTORY_ITEM_INACTIVE", 409)
        }

        const normalized = normalizeMovementOperation({ operation, input, item, actor: performedBy })
        const existing = await InventoryMovementModel.findOne(
            { businessId: tenantId, idempotencyKey: key },
            null,
            { session },
        )
        if (existing) {
            if (existing.requestFingerprint !== normalized.requestFingerprint) {
                throw domainError(
                    "Idempotency-Key was already used with different inventory input",
                    "INVENTORY_IDEMPOTENCY_CONFLICT",
                    409,
                )
            }
            return buildMovementResult({ item, movement: existing, replayed: true })
        }

        const onHandBefore = item.onHandQuantity
        const reservedBefore = item.reservedQuantity
        const onHandAfter = onHandBefore + normalized.quantityDeltaOnHand
        const reservedAfter = reservedBefore

        if (!Number.isSafeInteger(onHandAfter) || onHandAfter > MAX_INVENTORY_QUANTITY) {
            throw domainError(
                "Inventory quantity would exceed the maximum safe value",
                "INVENTORY_QUANTITY_OVERFLOW",
                409,
            )
        }
        if (onHandAfter < 0) {
            throw domainError(
                "Insufficient On Hand inventory",
                "INSUFFICIENT_ON_HAND_INVENTORY",
                409,
            )
        }
        if (onHandAfter < reservedAfter) {
            throw domainError(
                "This change would reduce On Hand below already Reserved inventory",
                "INVENTORY_RESERVED_STOCK_CONFLICT",
                409,
            )
        }

        item.onHandQuantity = onHandAfter
        await item.save({ session })

        const [movement] = await InventoryMovementModel.create([{
            movementId: generateMovementId(),
            businessId: tenantId,
            inventoryItemId: itemId,
            type: normalized.type,
            quantityDeltaOnHand: normalized.quantityDeltaOnHand,
            quantityDeltaReserved: normalized.quantityDeltaReserved,
            unit: normalized.submittedUnit,
            canonicalQuantity: normalized.canonicalQuantity,
            onHandBefore,
            onHandAfter,
            reservedBefore,
            reservedAfter,
            sourceType: normalized.sourceType,
            sourceId: normalized.sourceId,
            reasonCode: normalized.reasonCode,
            note: normalized.note,
            performedBy,
            idempotencyKey: key,
            requestFingerprint: normalized.requestFingerprint,
            unitCostMinor: normalized.unitCostMinor,
            costCurrency: normalized.costCurrency,
        }], { session })

        return buildMovementResult({ item, movement, replayed: false })
    }

    if (session) {
        return applyWithinTransaction(session)
    }

    try {
        return await withCanonicalInventoryTransaction(applyWithinTransaction, { startSession })
    } catch (error) {
        // Concurrent requests with the same key can race before the unique index
        // is observed. The losing transaction is aborted, then resolved here.
        if (isDuplicateKeyError(error)) {
            const item = await InventoryItemModel.findOne({
                businessId: tenantId,
                inventoryItemId: itemId,
            })
            if (!item) throw error
            const normalized = normalizeMovementOperation({ operation, input, item, actor: performedBy })
            const existing = await InventoryMovementModel.findOne({
                businessId: tenantId,
                idempotencyKey: key,
            })
            if (existing) {
                if (existing.requestFingerprint !== normalized.requestFingerprint) {
                    throw domainError(
                        "Idempotency-Key was already used with different inventory input",
                        "INVENTORY_IDEMPOTENCY_CONFLICT",
                        409,
                    )
                }
                return buildMovementResult({ item, movement: existing, replayed: true })
            }
        }
        throw error
    }
}

export function receiveInventory(command, dependencies) {
    return executeMovement({ ...command, operation: "receive" }, dependencies)
}

export function recordInventoryWaste(command, dependencies) {
    return executeMovement({ ...command, operation: "waste" }, dependencies)
}

export function adjustInventory(command, dependencies) {
    return executeMovement({ ...command, operation: "adjust" }, dependencies)
}
