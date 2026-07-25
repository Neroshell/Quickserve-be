import assert from "node:assert/strict";
import test from "node:test";
import {
  getMaximumConfiguredServicePointCapacity,
  getReservationGuestCapacity,
  validateReservationGuestCapacity,
} from "../src/services/reservationCapacityService.js";
import Business from "../src/models/Business.js";
import ServicePoint from "../src/models/ServicePoint.js";
import { createReservation } from "../src/controllers/publicController.js";

const servicePoints = [
  { servicePointId: "sp_small", capacity: 2 },
  { servicePointId: "sp_medium", capacity: 4 },
  { servicePointId: "sp_large", capacity: 8 },
];

test("a selected service point determines the reservation guest capacity", () => {
  assert.equal(
    getReservationGuestCapacity({
      servicePoints,
      servicePointId: "sp_medium",
    }),
    4
  );
});

test("no-preference reservations use the largest configured service point", () => {
  assert.equal(getMaximumConfiguredServicePointCapacity(servicePoints), 8);
  assert.equal(getReservationGuestCapacity({ servicePoints }), 8);
});

test("guest counts above the configured service point capacity are rejected", () => {
  assert.deepEqual(
    validateReservationGuestCapacity({
      guestCount: 5,
      servicePoints,
      servicePointId: "sp_medium",
    }),
    { capacity: 4, valid: false }
  );
});

test("legacy service points without capacity do not introduce an invented limit", () => {
  assert.deepEqual(
    validateReservationGuestCapacity({
      guestCount: 75,
      servicePoints: [{ servicePointId: "sp_legacy", capacity: null }],
      servicePointId: "sp_legacy",
    }),
    { capacity: null, valid: true }
  );
});

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createRestaurantReservationRequest(overrides = {}) {
  const date = "2099-07-24";
  return {
    body: {
      businessSlug: "capacity-restaurant",
      customerName: "Capacity Guest",
      phone: "+35600000000",
      email: "guest@example.com",
      date,
      startTime: "10:00",
      endTime: "11:00",
      durationMinutes: 60,
      guestCount: 3,
      seatingPreference: "no_preference",
      ...overrides,
    },
  };
}

function createBusinessForDate(date) {
  const dayOfWeek = new Date(`${date}T00:00:00`).toLocaleDateString(
    "en-US",
    { weekday: "long" }
  );
  return {
    businessId: "business-1",
    slug: "capacity-restaurant",
    status: "active",
    businessType: "restaurant",
    modules: ["foodService"],
    settings: { reservationsEnabled: true },
    operatingHours: {
      [dayOfWeek]: {
        enabled: true,
        openTime: "09:00",
        closeTime: "22:00",
      },
    },
  };
}

test("public reservations reject guest counts above the selected service point capacity", async () => {
  const originalBusinessFindOne = Business.findOne;
  const originalServicePointFindOne = ServicePoint.findOne;
  const request = createRestaurantReservationRequest({
    servicePointId: "sp_small",
    servicePointLabel: "Small Table",
  });
  const business = createBusinessForDate(request.body.date);

  Business.findOne = () => ({ lean: async () => business });
  ServicePoint.findOne = () => ({
    lean: async () => ({
      servicePointId: "sp_small",
      businessId: business.businessId,
      capacity: 2,
    }),
  });

  try {
    const response = createResponse();
    await createReservation(request, response);

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /maximum of 2 guests/i);
  } finally {
    Business.findOne = originalBusinessFindOne;
    ServicePoint.findOne = originalServicePointFindOne;
  }
});

test("no-preference reservations reject counts above every configured capacity", async () => {
  const originalBusinessFindOne = Business.findOne;
  const originalServicePointFind = ServicePoint.find;
  const request = createRestaurantReservationRequest({ guestCount: 5 });
  const business = createBusinessForDate(request.body.date);

  Business.findOne = () => ({ lean: async () => business });
  ServicePoint.find = () => ({
    select: () => ({
      lean: async () => [
        { servicePointId: "sp_small", capacity: 2 },
        { servicePointId: "sp_large", capacity: 4 },
      ],
    }),
  });

  try {
    const response = createResponse();
    await createReservation(request, response);

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /more than 4 guests/i);
  } finally {
    Business.findOne = originalBusinessFindOne;
    ServicePoint.find = originalServicePointFind;
  }
});
