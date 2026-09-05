import { toOrderDTO } from "../utils/orderDTO.js"
import { publishEvent } from "../utils/sseManager.js"
import Business from "../models/Business.js"
import { getCustomerProgressOptionsForBusiness } from "../utils/customerOrderTiming.js"
import { deriveStationStatus } from "./orderFulfillmentService.js"

export function toStationOrderDTO(order, station) {
  const dto = toOrderDTO(order, { includeFulfillment: true })
  const items = dto.items.filter((item) => item.fulfillmentStation === station)
  if (items.length === 0) return null
  return { ...dto, items, stationStatus: deriveStationStatus(items) }
}

export async function publishOrderRealtime(event, order, { action, customerNotification } = {}) {
  const business = await Business.findOne({ businessId: order.businessId }).lean()
  const customerProgressOptions = getCustomerProgressOptionsForBusiness(business)
  const staffDTO = toOrderDTO(order, { includeFulfillment: true })
  const customerDTO = toOrderDTO(order, { customerProgressOptions })
  const payloadExtra = action ? { action } : {}
  const customerPayloadExtra = customerNotification
    ? { ...payloadExtra, customerNotification }
    : payloadExtra
  const kitchenItems = staffDTO.items.filter((item) => item.fulfillmentStation === "kitchen")
  const barItems = staffDTO.items.filter((item) => item.fulfillmentStation === "bar")

  if (kitchenItems.length > 0) {
    await publishEvent(event, order.businessId, ["kitchen"], {
      order: { ...staffDTO, items: kitchenItems, stationStatus: deriveStationStatus(kitchenItems) },
      ...payloadExtra,
    })
  }
  if (barItems.length > 0) {
    await publishEvent(event, order.businessId, ["bar"], {
      order: { ...staffDTO, items: barItems, stationStatus: deriveStationStatus(barItems) },
      ...payloadExtra,
    })
  }
  await publishEvent(event, order.businessId, ["waiter", "table", "anon"], {
    order: customerDTO,
    ...customerPayloadExtra,
  })
}
