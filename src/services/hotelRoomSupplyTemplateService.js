import Business from "../models/Business.js"
import InventoryItem from "../models/InventoryItem.js"
import ServicePoint, { normalizeRoomType } from "../models/ServicePoint.js"
import { InventoryDomainError, toInventoryItemDTO } from "./canonicalInventoryService.js"
import { resolveBusinessCapabilities } from "./businessCapabilityService.js"
import { isHotelOperationalInventoryDomain } from "./inventoryDomainService.js"
import { normalizeInventoryQuantity } from "./inventoryUomService.js"

const MAX_STANDARD_SUPPLY_LINES = 100

function templateError(message, code, statusCode = 400) {
    return new InventoryDomainError(message, { code, statusCode })
}

function requiredText(value, field, maxLength) {
    if (typeof value !== "string" || !value.trim()) {
        throw templateError(`${field} is required`, "INVALID_ROOM_SUPPLY_TEMPLATE")
    }
    const normalized = value.trim().replace(/\s+/g, " ")
    if (normalized.length > maxLength) {
        throw templateError(
            `${field} cannot exceed ${maxLength} characters`,
            "INVALID_ROOM_SUPPLY_TEMPLATE",
        )
    }
    return normalized
}

function resolveLean(value) {
    return typeof value?.lean === "function" ? value.lean() : value
}

function findConfiguredRoomType(business, roomTypeName) {
    const key = normalizeRoomType(roomTypeName)?.toLowerCase()
    if (!key) return null
    return business.hotelRoomTypes?.find((roomType) => (
        roomType.isDefault !== true &&
        normalizeRoomType(roomType.name)?.toLowerCase() === key
    )) || null
}

function assertHotelBusiness(business) {
    if (!business) {
        throw templateError("Business not found", "BUSINESS_NOT_FOUND", 404)
    }
    const capabilities = resolveBusinessCapabilities(business)
    if (
        capabilities.identity.shell !== "hotel" ||
        !capabilities.visibleModules.includes("lodging")
    ) {
        throw templateError(
            "Room Type supply templates are not enabled for this business",
            "ROOM_SUPPLY_TEMPLATE_NOT_ENABLED",
            403,
        )
    }
}

function normalizeTemplateInput(items) {
    if (!Array.isArray(items) || items.length > MAX_STANDARD_SUPPLY_LINES) {
        throw templateError(
            `items must be an array with at most ${MAX_STANDARD_SUPPLY_LINES} lines`,
            "INVALID_ROOM_SUPPLY_TEMPLATE",
        )
    }

    const seen = new Set()
    return items.map((line) => {
        if (!line || typeof line !== "object" || Array.isArray(line)) {
            throw templateError(
                "Each standard supply line must be an object",
                "INVALID_ROOM_SUPPLY_TEMPLATE",
            )
        }
        for (const field of Object.keys(line)) {
            if (!["inventoryItemId", "quantity", "unit"].includes(field)) {
                throw templateError(
                    `Unsupported standard supply field: ${field}`,
                    "INVALID_ROOM_SUPPLY_TEMPLATE",
                )
            }
        }
        const inventoryItemId = requiredText(line.inventoryItemId, "inventoryItemId", 100)
        if (seen.has(inventoryItemId)) {
            throw templateError(
                "The same inventory item cannot appear twice in a standard supply template",
                "DUPLICATE_ROOM_SUPPLY_ITEM",
            )
        }
        seen.add(inventoryItemId)
        return {
            inventoryItemId,
            quantity: line.quantity,
            unit: line.unit,
        }
    })
}

function supplyLineStatus(line, item) {
    if (!item) return "missing"
    if (item.deletedAt) return "deleted"
    if (item.isActive === false) return "inactive"
    const domain = item.domain || "food_service"
    if (!isHotelOperationalInventoryDomain(domain)) return "not_room_usage_eligible"
    try {
        const normalized = normalizeInventoryQuantity({
            quantity: line.quantity,
            unit: line.unit,
            trackingUnit: item.trackingUnit,
        })
        if (normalized.canonicalQuantity !== line.canonicalQuantity) return "unit_changed"
    } catch {
        return "unit_changed"
    }
    return "available"
}

function templateLineDTO(line, item) {
    const status = supplyLineStatus(line, item)
    return {
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        unit: line.unit,
        canonicalQuantity: line.canonicalQuantity,
        status,
        inventoryItem: item ? toInventoryItemDTO(item) : null,
    }
}

async function readTemplateInventoryItems(businessId, template, InventoryItemModel) {
    const inventoryItemIds = template.map((line) => line.inventoryItemId)
    if (inventoryItemIds.length === 0) return new Map()
    const items = await resolveLean(InventoryItemModel.find({
        businessId,
        inventoryItemId: { $in: inventoryItemIds },
    }))
    return new Map((items || []).map((item) => [item.inventoryItemId, item]))
}

export async function updateRoomTypeSupplyTemplate({
    businessId,
    roomTypeName,
    items,
}, {
    BusinessModel = Business,
    InventoryItemModel = InventoryItem,
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const requestedRoomType = requiredText(roomTypeName, "roomTypeName", 80)
    const requestedLines = normalizeTemplateInput(items)

    const business = await BusinessModel.findOne({ businessId: tenantId })
    assertHotelBusiness(business)
    const roomType = findConfiguredRoomType(business, requestedRoomType)
    if (!roomType) {
        throw templateError("Room type not found", "ROOM_TYPE_NOT_FOUND", 404)
    }

    const inventoryItemIds = requestedLines.map((line) => line.inventoryItemId)
    const inventoryItems = inventoryItemIds.length === 0
        ? []
        : await InventoryItemModel.find({
            businessId: tenantId,
            inventoryItemId: { $in: inventoryItemIds },
            deletedAt: null,
        })
    const inventoryItemById = new Map(
        (inventoryItems || []).map((item) => [item.inventoryItemId, item]),
    )
    if (inventoryItemById.size !== inventoryItemIds.length) {
        throw templateError(
            "One or more standard supply items were not found",
            "ROOM_SUPPLY_INVENTORY_ITEM_NOT_FOUND",
            404,
        )
    }

    const template = requestedLines.map((line) => {
        const item = inventoryItemById.get(line.inventoryItemId)
        if (item.isActive === false) {
            throw templateError(
                "Inactive inventory items cannot be added to a standard supply template",
                "ROOM_SUPPLY_INVENTORY_ITEM_INACTIVE",
                409,
            )
        }
        const domain = item.domain || "food_service"
        if (!isHotelOperationalInventoryDomain(domain)) {
            throw templateError(
                "Only hotel operational inventory items can be standard room supplies",
                "INVENTORY_ITEM_NOT_ROOM_SUPPLY_ELIGIBLE",
                409,
            )
        }
        const normalized = normalizeInventoryQuantity({
            quantity: line.quantity,
            unit: line.unit,
            trackingUnit: item.trackingUnit,
        })
        return {
            inventoryItemId: line.inventoryItemId,
            quantity: Number(line.quantity),
            unit: normalized.submittedUnit,
            canonicalQuantity: normalized.canonicalQuantity,
        }
    })

    roomType.standardSupplyTemplate = template
    await business.save()

    return {
        roomType,
        roomTypeName: roomType.name,
        items: template.map((line) => templateLineDTO(
            line,
            inventoryItemById.get(line.inventoryItemId),
        )),
    }
}

export async function readRoomTypeSupplyTemplate({
    businessId,
    roomTypeName,
}, {
    BusinessModel = Business,
    InventoryItemModel = InventoryItem,
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const requestedRoomType = requiredText(roomTypeName, "roomTypeName", 80)
    const business = await resolveLean(BusinessModel.findOne({ businessId: tenantId }))
    assertHotelBusiness(business)
    const roomType = findConfiguredRoomType(business, requestedRoomType)
    if (!roomType) {
        throw templateError("Room type not found", "ROOM_TYPE_NOT_FOUND", 404)
    }
    const template = Array.from(roomType.standardSupplyTemplate || [])
    const inventoryItemById = await readTemplateInventoryItems(
        tenantId,
        template,
        InventoryItemModel,
    )
    return {
        roomTypeName: roomType.name,
        items: template.map((line) => templateLineDTO(
            line,
            inventoryItemById.get(line.inventoryItemId),
        )),
    }
}

export async function readRoomUsageContext({
    businessId,
    servicePointId = null,
}, {
    BusinessModel = Business,
    InventoryItemModel = InventoryItem,
    ServicePointModel = ServicePoint,
} = {}) {
    const tenantId = requiredText(businessId, "businessId", 200)
    const requestedRoomId = servicePointId === null || servicePointId === undefined || servicePointId === ""
        ? null
        : requiredText(servicePointId, "servicePointId", 100)

    const business = await resolveLean(BusinessModel.findOne({ businessId: tenantId }))
    assertHotelBusiness(business)

    let roomQuery = ServicePointModel.find({
        businessId: tenantId,
        servicePointType: "room",
        isActive: true,
    })
    if (typeof roomQuery?.sort === "function") {
        roomQuery = roomQuery.sort({ label: 1, servicePointId: 1 })
    }
    const roomRecords = await resolveLean(roomQuery)
    const rooms = (roomRecords || []).map((room) => ({
        servicePointId: room.servicePointId,
        label: room.label,
        roomType: room.roomType ?? null,
    }))

    if (!requestedRoomId) {
        return { rooms, selectedRoom: null, template: null }
    }
    const selectedRoom = (roomRecords || []).find(
        (room) => room.servicePointId === requestedRoomId,
    )
    if (!selectedRoom) {
        throw templateError("Active hotel room not found", "ROOM_SERVICE_POINT_NOT_FOUND", 404)
    }

    const roomType = findConfiguredRoomType(business, selectedRoom.roomType)
    const storedTemplate = Array.from(roomType?.standardSupplyTemplate || [])
    const inventoryItemById = await readTemplateInventoryItems(
        tenantId,
        storedTemplate,
        InventoryItemModel,
    )
    const resolvedLines = storedTemplate.map((line) => templateLineDTO(
        line,
        inventoryItemById.get(line.inventoryItemId),
    ))
    const suggestions = resolvedLines.filter((line) => line.status === "available")
    const unavailableItems = resolvedLines
        .filter((line) => line.status !== "available")
        .map(({ inventoryItemId, status, inventoryItem }) => ({
            inventoryItemId,
            status,
            name: inventoryItem?.name || null,
        }))

    return {
        rooms,
        selectedRoom: {
            servicePointId: selectedRoom.servicePointId,
            label: selectedRoom.label,
            roomType: selectedRoom.roomType ?? null,
        },
        template: {
            roomTypeName: roomType?.name || selectedRoom.roomType || null,
            configured: storedTemplate.length > 0,
            suggestions,
            unavailableItems,
        },
    }
}

