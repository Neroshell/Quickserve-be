import ServicePoint from "../models/ServicePoint.js";
import { resolveBusinessCapabilities } from "../services/businessCapabilityService.js";
import {
  DISCOVERY_VISIBLE_BUSINESS_STATUSES,
  isDiscoveryBusinessVisible,
} from "../services/discoveryPublicationService.js";
import {
  PublicBusinessResolutionError,
  resolvePublicBusiness,
} from "../services/publicBusinessResolverService.js";
import { findHotelRoomAvailability } from "../services/hotelReservationAvailabilityService.js";
import { toPublicHotelAvailabilityRoomDto } from "./reservationController.js";
import { assertReservationEligibility } from "../services/reservationEligibilityService.js";
import { assertPublicReservationModeBookable } from "../services/publicReservationBookabilityService.js";

function publicImage(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function roomCatalogDto(room) {
  return {
    servicePointId: room.servicePointId,
    label: room.label,
    roomType: room.roomType || null,
    description: room.fullDescription || null,
    capacity: room.capacity ?? null,
    maxGuests: room.maxGuests ?? null,
    beds: room.beds ?? null,
    bedType: room.bedType || null,
    viewType: room.viewType || null,
    amenities: Array.isArray(room.amenities)
      ? room.amenities.filter((item) => typeof item === "string" && item.trim())
      : [],
    images: Array.isArray(room.images) ? room.images.map(publicImage).filter(Boolean) : [],
  };
}

async function publishedHotel(req) {
  const { business } = await resolvePublicBusiness({
    countryCode: req.params.countryCode,
    businessSlug: req.params.slug,
    statuses: DISCOVERY_VISIBLE_BUSINESS_STATUSES,
  });
  if (!business || !isDiscoveryBusinessVisible(business) ||
      business.businessType !== "hotel" ||
      !resolveBusinessCapabilities(business).reservations.modes.includes("stay")) {
    return null;
  }
  return business;
}

async function handleDiscoveryHotel(req, res, withAvailability) {
  try {
    const business = await publishedHotel(req);
    if (!business) return res.status(404).json({ error: "Hotel not found" });
    res.set("Cache-Control", "private, no-store, max-age=0");

    if (!withAvailability) {
      // Only explicit room ServicePoints are public accommodation catalog entries.
      // Legacy/untyped points and operational resources are not exposed.
      const rooms = await ServicePoint.find({
        businessId: business.businessId,
        servicePointType: "room",
        isActive: { $ne: false },
        reservable: { $ne: false },
      }).sort({ label: 1 }).lean();
      return res.json({ currency: business.currency || 'EUR', rooms: rooms.map(roomCatalogDto) });
    }

    assertReservationEligibility(business);
    assertPublicReservationModeBookable(business, "stay");
    const { rooms } = await findHotelRoomAvailability({
      business,
      checkInDate: req.query.checkInDate,
      checkOutDate: req.query.checkOutDate,
      guestCount: req.query.guestCount,
    });
    // Reuse the canonical public availability DTO and pricing, then enforce
    // explicit room typing and a successful price quote for Discovery.
    const availableRooms = rooms
      .filter((room) => room.servicePointType === "room" &&
        room.available && !room.capacityExceeded &&
        room.pricingSummary && Number.isFinite(room.pricingSummary.total))
      .map((room) => ({
        ...roomCatalogDto(room),
        ...toPublicHotelAvailabilityRoomDto(room),
        images: roomCatalogDto(room).images,
      }));
    return res.json({ currency: business.currency || 'EUR', rooms: availableRooms });
  } catch (error) {
    if (error instanceof PublicBusinessResolutionError || error.statusCode) {
      return res.status(error.statusCode || 400).json({ error: error.message });
    }
    console.error("[discovery:hotel]", error);
    return res.status(500).json({ error: "Unable to load hotel rooms" });
  }
}

export const getDiscoveryHotelRooms = (req, res) => handleDiscoveryHotel(req, res, false);
export const getDiscoveryHotelAvailability = (req, res) => handleDiscoveryHotel(req, res, true);
