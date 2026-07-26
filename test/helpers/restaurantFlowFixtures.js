export function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    end(body) {
      this.body = body;
      this.ended = true;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
  };
}

export function mockQuery(value) {
  const promise = Promise.resolve(value);
  return {
    lean: async () => value,
    select() {
      return this;
    },
    sort() {
      return this;
    },
    then(resolve, reject) {
      return promise.then(resolve, reject);
    },
    catch(reject) {
      return promise.catch(reject);
    },
  };
}

export function createBusinessFixture(overrides = {}) {
  return {
    businessId: "business-a",
    name: "Test Bistro",
    displayName: "Test Bistro",
    slug: "test-bistro",
    status: "active",
    businessType: "restaurant",
    modules: ["foodService"],
    currency: "EUR",
    timezone: "Europe/Berlin",
    taxRate: 10,
    currentPlan: "basic",
    platformFeeMode: "business_absorbs",
    customerPlatformFeePercent: 0,
    platformFeeLabel: "Service Fee",
    billingStatus: "active",
    defaultPaymentMethodId: "pm_test_business_a",
    stripeAccountId: "acct_business_a",
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
    orderingPreferences: {
      dineInEnabled: true,
      takeoutEnabled: true,
      qrOrderingEnabled: true,
      enableWaiterOrdering: true,
    },
    paymentPreferences: {
      acceptOnlinePayments: true,
      acceptOfflinePayments: true,
      acceptCash: true,
      acceptPosCard: true,
    },
    settings: {
      tipsEnabled: false,
    },
    menuCategories: ["mains", "beverages"],
    ...overrides,
  };
}

export function createServicePointFixture(overrides = {}) {
  return {
    _id: "mongo-service-point-a",
    servicePointId: "sp_table_a",
    businessId: "business-a",
    label: "Table 7",
    code: "T7",
    capacity: 4,
    isActive: true,
    reservable: true,
    ...overrides,
  };
}

export function createMenuItemFixture(overrides = {}) {
  return {
    _id: "mongo-menu-pizza",
    businessId: "business-a",
    name: "Margherita Pizza",
    price: 12.5,
    prepTimeMinutes: 12,
    category: "mains",
    type: "food",
    description: "Tomato and mozzarella",
    imageUrl: "https://example.test/pizza.jpg",
    isAvailable: true,
    trackStock: false,
    stockQuantity: null,
    ...overrides,
  };
}

export function createGuestSessionFixture(overrides = {}) {
  return {
    _id: "mongo-guest-session-a",
    businessId: "business-a",
    servicePointId: "sp_table_a",
    token: "table-token-a",
    boundSessionId: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

export function createOrderDocument(overrides = {}) {
  const order = {
    _id: "mongo-order-a",
    orderId: "ORDER-A-001",
    businessId: "business-a",
    servicePointLabel: "sp_table_a",
    displayLabel: "Table 7",
    orderType: "dine-in",
    sessionId: "device-a",
    status: "placed",
    items: [
      {
        itemName: "Margherita Pizza",
        quantity: 1,
        lineTotal: 12.5,
        prepTimeMinutes: 12,
        type: "food",
        category: "mains",
        notes: "",
        allergies: [],
      },
    ],
    subtotal: 12.5,
    taxAmount: 1.25,
    platformFeeTotal: 0,
    total: 13.75,
    currency: "EUR",
    paymentChannel: "offline",
    paymentStatus: "unpaid",
    paidVia: null,
    paidAt: null,
    receiptEmail: null,
    receiptSent: false,
    receiptSentAt: null,
    commissionRateApplied: 2,
    commissionAmountCents: 25,
    inventoryDeducted: false,
    createdAt: new Date("2026-07-26T10:00:00.000Z"),
    updatedAt: new Date("2026-07-26T10:00:00.000Z"),
    saveCount: 0,
    ...overrides,
  };

  order.save = async function save() {
    this.saveCount += 1;
    return this;
  };
  order.toObject = function toObject() {
    const { save, toObject, ...plain } = this;
    return { ...plain };
  };
  return order;
}

export function createPendingCheckoutDocument(overrides = {}) {
  return {
    _id: {
      toString() {
        return "pending-checkout-a";
      },
    },
    saveCount: 0,
    ...overrides,
    async save() {
      this.saveCount += 1;
      return this;
    },
  };
}

export function createPlanFixture(overrides = {}) {
  return {
    slug: "basic",
    offlineCommissionRate: 2,
    commissionPercentage: 3,
    ...overrides,
  };
}

export function createPublicOrderRequest(overrides = {}) {
  return {
    body: {
      businessId: "attacker-controlled-business",
      servicePointLabel: "sp_table_a",
      sessionId: "device-a",
      tableSessionToken: "table-token-a",
      orderType: "dine-in",
      currency: "USD",
      items: [
        {
          itemName: "Margherita Pizza",
          quantity: 1,
          price: 0.01,
          notes: "No basil",
          allergies: ["Dairy"],
        },
      ],
      ...overrides,
    },
    query: {},
    params: {},
    session: {},
  };
}

export function createStaffSession(overrides = {}) {
  return {
    user: {
      businessId: "business-a",
      staffId: "staff-a",
      id: "staff-a",
      name: "Alex Waiter",
      role: "waiter",
      ...overrides,
    },
  };
}
