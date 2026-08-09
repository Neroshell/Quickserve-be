import test from "node:test";
import assert from "node:assert/strict";

process.env.REDIS_URL = "";
process.env.BULLMQ_EMAILS_ENABLED = "false";
process.env.STRIPE_SECRET_KEY = "sk_test_restaurant_flow";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_restaurant_flow";
process.env.RESEND_API_KEY = "re_test_restaurant_flow";
process.env.FRONTEND_BASE_URL = "https://app.quickserve.test";

const [
  {
    createOrder,
    getOrderById,
    listOrders,
    markPaid,
    updateOrderStatus,
  },
  { createCheckoutSession },
  { getPublicBusinessConfig },
  { getMenuItems },
  { kitchenOrders },
  { barOrders },
  { waiterOrders },
  { reorderFromOrder },
  { requireAuth, requireRole },
  { sseHandler },
  { default: guestSessionRouter },
  { default: Order },
  { default: GuestSession },
  { default: PendingCheckout },
  { default: Business },
  { default: ServicePoint },
  { default: MenuItem },
  { default: Plan },
  { default: GuestProfile },
  { default: GuestVisit },
] = await Promise.all([
  import("../src/controllers/orderController.js"),
  import("../src/controllers/paymentController.js"),
  import("../src/controllers/publicController.js"),
  import("../src/controllers/menuController.js"),
  import("../src/controllers/kitchenController.js"),
  import("../src/controllers/barController.js"),
  import("../src/controllers/waitstaffOrdersController.js"),
  import("../src/controllers/reorderController.js"),
  import("../src/middleware/authMiddleware.js"),
  import("../src/utils/sseManager.js"),
  import("../src/routes/guest-session-route.js"),
  import("../src/models/order.js"),
  import("../src/models/GuestSession.js"),
  import("../src/models/PendingCheckout.js"),
  import("../src/models/Business.js"),
  import("../src/models/ServicePoint.js"),
  import("../src/models/menuItem.js"),
  import("../src/models/Plan.js"),
  import("../src/models/GuestProfile.js"),
  import("../src/models/GuestVisit.js"),
]);

const {
  createBusinessFixture,
  createGuestSessionFixture,
  createMenuItemFixture,
  createOrderDocument,
  createPendingCheckoutDocument,
  createPlanFixture,
  createPublicOrderRequest,
  createResponse,
  createServicePointFixture,
  createStaffSession,
  mockQuery,
} = await import("./helpers/restaurantFlowFixtures.js");

function getRouteHandler(router, path, method) {
  const layer = router.stack.find(
    (candidate) =>
      candidate.route?.path === path && candidate.route.methods?.[method],
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route`);
  return layer.route.stack.at(-1).handle;
}

function installOfflineOrderMocks(t, options = {}) {
  const business = options.business || createBusinessFixture();
  const servicePoint =
    options.servicePoint === undefined
      ? createServicePointFixture()
      : options.servicePoint;
  const guestSession =
    options.guestSession || createGuestSessionFixture();
  const menuItems =
    options.menuItems || [createMenuItemFixture()];
  const plan = options.plan || createPlanFixture();
  const capture = {
    orderCreates: [],
    menuQueries: [],
    servicePointQueries: [],
    sessionClaims: [],
  };

  t.mock.method(GuestSession, "findOne", () => mockQuery(guestSession));
  t.mock.method(GuestSession, "findOneAndUpdate", async (query) => {
    capture.sessionClaims.push(query);
    guestSession.boundSessionId = query?._id ? "device-a" : guestSession.boundSessionId;
    return guestSession;
  });
  t.mock.method(Business, "findOne", () => mockQuery(business));
  t.mock.method(ServicePoint, "findOne", (query) => {
    capture.servicePointQueries.push(query);
    return mockQuery(servicePoint);
  });
  t.mock.method(Plan, "findOne", () => mockQuery(plan));
  t.mock.method(MenuItem, "findOne", (query) => {
    capture.menuQueries.push(query);
    const item = menuItems.find((candidate) => {
      if (query.name && candidate.name !== query.name) return false;
      if (query._id && String(candidate._id) !== String(query._id)) return false;
      return candidate.businessId === query.businessId;
    });
    return mockQuery(item || null);
  });
  t.mock.method(MenuItem, "findOneAndUpdate", async () => null);
  t.mock.method(Order, "create", async (fields) => {
    capture.orderCreates.push(fields);
    return createOrderDocument(fields);
  });

  return { business, servicePoint, guestSession, menuItems, plan, capture };
}

function installOnlineCheckoutMocks(t, options = {}) {
  const business = options.business || createBusinessFixture();
  const servicePoint =
    options.servicePoint === undefined
      ? createServicePointFixture()
      : options.servicePoint;
  const guestSession =
    options.guestSession || createGuestSessionFixture();
  const menuItems =
    options.menuItems || [createMenuItemFixture()];
  const plan = options.plan || createPlanFixture();
  const capture = {
    pendingCreates: [],
    stripeConfigs: [],
    menuQueries: [],
    sessionClaims: [],
  };

  t.mock.method(GuestSession, "findOne", () => mockQuery(guestSession));
  t.mock.method(GuestSession, "findOneAndUpdate", async (query) => {
    capture.sessionClaims.push(query);
    guestSession.boundSessionId = "device-a";
    return guestSession;
  });
  t.mock.method(MenuItem, "findOne", (query) => {
    capture.menuQueries.push(query);
    const item = menuItems.find((candidate) => {
      if (query.name && candidate.name !== query.name) return false;
      if (query._id && String(candidate._id) !== String(query._id)) return false;
      return candidate.businessId === query.businessId;
    });
    return mockQuery(item || null);
  });
  t.mock.method(Business, "findOne", () => mockQuery(business));
  t.mock.method(ServicePoint, "findOne", () => mockQuery(servicePoint));
  t.mock.method(Plan, "findOne", () => mockQuery(plan));
  t.mock.method(PendingCheckout, "create", async (fields) => {
    const pending = createPendingCheckoutDocument(fields);
    capture.pendingCreates.push(pending);
    return pending;
  });

  const stripeClient = {
    checkout: {
      sessions: {
        async create(config) {
          capture.stripeConfigs.push(config);
          if (options.stripeError) throw options.stripeError;
          return {
            id: "cs_restaurant_flow",
            url: "https://checkout.stripe.test/session",
            payment_intent: "pi_restaurant_flow",
          };
        },
      },
    },
  };

  return {
    business,
    servicePoint,
    guestSession,
    menuItems,
    plan,
    capture,
    stripeClient,
  };
}

function withStripeClient(req, stripeClient) {
  return {
    ...req,
    app: { locals: { stripe: stripeClient } },
  };
}

function createSseClientRequest({ role, businessId, session, token }) {
  const closeHandlers = [];
  return {
    req: {
      query: { role, businessId, token },
      session,
      on(event, callback) {
        if (event === "close") closeHandlers.push(callback);
      },
    },
    close() {
      closeHandlers.forEach((callback) => callback());
    },
  };
}

function createSseResponse() {
  const response = createResponse();
  response.writes = [];
  response.write = function write(chunk) {
    this.writes.push(chunk);
    return true;
  };
  response.flushHeaders = () => {};
  return response;
}

function orderEvents(response) {
  return response.writes
    .filter((chunk) => chunk.startsWith("event: order_"))
    .map((chunk) => JSON.parse(chunk.match(/\ndata: (.+)\n\n/s)[1]));
}

test("public business config returns restaurant currency/timezone and blocks inactive businesses", async (t) => {
  const active = createBusinessFixture();
  let currentBusiness = active;
  t.mock.method(Business, "findOne", () => mockQuery(currentBusiness));
  t.mock.method(Plan, "findOne", () => mockQuery(createPlanFixture()));

  const activeRes = createResponse();
  await getPublicBusinessConfig(
    { query: { businessId: "business-a" } },
    activeRes,
  );

  assert.equal(activeRes.statusCode, 200);
  assert.equal(activeRes.body.businessId, "business-a");
  assert.equal(activeRes.body.currency, "EUR");
  assert.equal(activeRes.body.timezone, "Europe/Berlin");
  assert.equal(activeRes.body.offlinePaymentsAvailable, true);
  assert.equal("stripeAccountId" in activeRes.body, false);

  currentBusiness = createBusinessFixture({ status: "suspended" });
  const inactiveRes = createResponse();
  await getPublicBusinessConfig(
    { query: { businessId: "business-a" } },
    inactiveRes,
  );
  assert.equal(inactiveRes.statusCode, 404);
});

test("public menu is tenant-scoped and hides unavailable items while owning staff can manage them", async (t) => {
  const items = [
    createMenuItemFixture(),
    createMenuItemFixture({
      _id: "mongo-menu-sold-out",
      name: "Sold Out Soup",
      isAvailable: false,
    }),
  ];
  const filters = [];
  t.mock.method(MenuItem, "find", (filter) => {
    filters.push(filter);
    const result = filter.isAvailable
      ? items.filter((item) => item.isAvailable)
      : items;
    return mockQuery(result);
  });

  const publicRes = createResponse();
  await getMenuItems(
    { query: { businessId: "business-a" }, body: {}, session: {} },
    publicRes,
  );
  assert.deepEqual(filters[0], { businessId: "business-a", isAvailable: true });
  assert.deepEqual(publicRes.body.map((item) => item.name), ["Margherita Pizza"]);

  const staffRes = createResponse();
  await getMenuItems(
    {
      query: { businessId: "business-b" },
      body: {},
      session: createStaffSession(),
    },
    staffRes,
  );
  assert.deepEqual(filters[1], { businessId: "business-a" });
  assert.equal(staffRes.body.length, 2);
});

test("valid active ServicePoint creates a tenant-bound guest session", async (t) => {
  const business = createBusinessFixture();
  const servicePoint = createServicePointFixture();
  let created;
  t.mock.method(Business, "findOne", () => mockQuery(business));
  t.mock.method(ServicePoint, "findOne", (query) => {
    assert.deepEqual(query, {
      servicePointId: "sp_table_a",
      businessId: "business-a",
    });
    return mockQuery(servicePoint);
  });
  t.mock.method(GuestSession, "create", async (fields) => {
    created = fields;
    return fields;
  });

  const handler = getRouteHandler(guestSessionRouter, "/start", "post");
  const res = createResponse();
  await handler(
    {
      body: {
        businessId: "business-a",
        servicePointId: "sp_table_a",
      },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.label, "Table 7");
  assert.equal(created.businessId, "business-a");
  assert.equal(created.servicePointId, "sp_table_a");
  assert.ok(created.expiresAt > new Date());
  assert.equal(created.boundSessionId, null);
});

test("guest-session bootstrap rejects inactive businesses, disabled ServicePoints, and tenant manipulation", async (t) => {
  let business = createBusinessFixture({ status: "suspended" });
  let servicePoint = createServicePointFixture();
  let createCount = 0;
  t.mock.method(Business, "findOne", () => mockQuery(business));
  t.mock.method(ServicePoint, "findOne", (query) => {
    if (
      query.businessId !== servicePoint.businessId ||
      query.servicePointId !== servicePoint.servicePointId
    ) {
      return mockQuery(null);
    }
    return mockQuery(servicePoint);
  });
  t.mock.method(GuestSession, "create", async () => {
    createCount += 1;
  });

  const handler = getRouteHandler(guestSessionRouter, "/start", "post");

  const inactiveRes = createResponse();
  await handler(
    { body: { businessId: "business-a", servicePointId: "sp_table_a" } },
    inactiveRes,
  );
  assert.equal(inactiveRes.statusCode, 404);

  business = createBusinessFixture();
  servicePoint = createServicePointFixture({ isActive: false });
  const disabledRes = createResponse();
  await handler(
    { body: { businessId: "business-a", servicePointId: "sp_table_a" } },
    disabledRes,
  );
  assert.equal(disabledRes.statusCode, 400);

  servicePoint = createServicePointFixture({
    businessId: "business-b",
    servicePointId: "sp_table_b",
  });
  const tenantAttackRes = createResponse();
  await handler(
    { body: { businessId: "business-a", servicePointId: "sp_table_b" } },
    tenantAttackRes,
  );
  assert.equal(tenantAttackRes.statusCode, 404);
  assert.equal(createCount, 0);
});

test("Scenario A: public dine-in order derives tenant, menu pricing, snapshots, and offline state", async (t) => {
  const { capture } = installOfflineOrderMocks(t);
  t.mock.method(console, "log", () => {});

  const req = createPublicOrderRequest({
    items: [
      {
        itemName: "Margherita Pizza",
        quantity: 2,
        price: 0.01,
        modifierPrice: 0.01,
        notes: "No basil",
        allergies: ["Dairy"],
      },
    ],
    currency: "USD",
    total: 0.01,
    paymentChannel: "online",
    paymentStatus: "paid",
    paidVia: "online_card",
  });
  const res = createResponse();
  await createOrder(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(capture.orderCreates.length, 1);
  const stored = capture.orderCreates[0];
  assert.equal(stored.businessId, "business-a");
  assert.equal(stored.servicePointLabel, "sp_table_a");
  assert.equal(stored.displayLabel, "Table 7");
  assert.equal(stored.orderType, "dine-in");
  assert.equal(stored.items[0].quantity, 2);
  assert.equal(stored.items[0].lineTotal, 25);
  assert.equal(stored.items[0].notes, "No basil");
  assert.deepEqual(stored.items[0].allergies, ["Dairy"]);
  assert.equal(stored.subtotal, 25);
  assert.equal(stored.taxAmount, 2.5);
  assert.equal(stored.platformFeeCents, 50);
  assert.equal(stored.customerPlatformFeeCents, 0);
  assert.equal(stored.total, 27.5);
  assert.equal(stored.currency, "EUR");
  assert.equal(stored.paymentChannel, "offline");
  assert.equal(stored.paymentStatus, "unpaid");
  assert.equal(stored.paidVia, null);
  assert.equal(stored.status, "placed");
  assert.equal(stored.orderSource, "self");
  assert.ok(stored.estimatedReadyAt instanceof Date);
  assert.equal(res.body.orderId, stored.orderId);
  assert.equal(res.body.businessId, "business-a");
  assert.equal(res.body.status, "placed");
  assert.deepEqual(res.body.pricing, {
    subtotal: 25,
    subtotalCents: 2500,
    taxRate: 10,
    taxLabel: "Tax",
    taxAmount: 2.5,
    taxAmountCents: 250,
    platformFeeLabel: "Service Fee",
    customerPlatformFeeAmount: 0,
    customerPlatformFeeCents: 0,
    total: 27.5,
    totalCents: 2750,
    tipAmount: 0,
    tipAmountCents: 0,
    currency: "EUR",
  });
});

test("takeout preserves the order type while keeping the current ServicePoint association rule", async (t) => {
  const { capture } = installOfflineOrderMocks(t);
  t.mock.method(console, "log", () => {});

  const res = createResponse();
  await createOrder(
    createPublicOrderRequest({ orderType: "takeout" }),
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(capture.orderCreates[0].orderType, "takeout");
  assert.equal(capture.orderCreates[0].servicePointLabel, "sp_table_a");
  assert.equal(capture.orderCreates[0].displayLabel, "Table 7");
});

test("cart validation rejects zero, negative, fractional, non-numeric, and missing quantities", async () => {
  const invalidQuantities = [0, -1, 1.5, "two", undefined];

  for (const quantity of invalidQuantities) {
    const req = createPublicOrderRequest({
      items: [{ itemName: "Margherita Pizza", quantity }],
    });
    const res = createResponse();
    await createOrder(req, res);
    assert.equal(res.statusCode, 400, `quantity=${String(quantity)}`);
    assert.match(res.body.message, /quantity/i);
  }
});

test("item disabled after menu load and inactive ServicePoint are rejected before order persistence", async (t) => {
  const unavailable = createMenuItemFixture({ isAvailable: false });
  const { capture } = installOfflineOrderMocks(t, {
    menuItems: [unavailable],
  });

  const unavailableRes = createResponse();
  await createOrder(createPublicOrderRequest(), unavailableRes);
  assert.equal(unavailableRes.statusCode, 400);
  assert.match(unavailableRes.body.message, /no longer available/i);
  assert.equal(capture.orderCreates.length, 0);
});

test("tracked item stock is revalidated at checkout", async (t) => {
  const tracked = createMenuItemFixture({
    trackStock: true,
    stockQuantity: 1,
  });
  const { capture } = installOfflineOrderMocks(t, {
    menuItems: [tracked],
  });

  const res = createResponse();
  await createOrder(
    createPublicOrderRequest({
      items: [{ itemName: tracked.name, quantity: 2 }],
    }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /requested quantity/i);
  assert.equal(res.body.items[0].available, 1);
  assert.equal(capture.orderCreates.length, 0);
});

test("ServicePoint disabled between QR scan and checkout blocks the order", async (t) => {
  const { capture } = installOfflineOrderMocks(t, {
    servicePoint: createServicePointFixture({ isActive: false }),
  });

  const res = createResponse();
  await createOrder(createPublicOrderRequest(), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /service ?point/i);
  assert.equal(capture.orderCreates.length, 0);
});

test("expired or device-bound guest sessions are rejected without creating an order", async (t) => {
  let guestSession = createGuestSessionFixture({
    expiresAt: new Date(Date.now() - 1000),
  });
  let createCount = 0;
  t.mock.method(GuestSession, "findOne", () => mockQuery(guestSession));
  t.mock.method(Order, "create", async () => {
    createCount += 1;
  });

  const expiredRes = createResponse();
  await createOrder(createPublicOrderRequest(), expiredRes);
  assert.equal(expiredRes.statusCode, 403);

  guestSession = createGuestSessionFixture({
    boundSessionId: "another-device",
  });
  const boundRes = createResponse();
  await createOrder(createPublicOrderRequest(), boundRes);
  assert.equal(boundRes.statusCode, 403);
  assert.equal(createCount, 0);
});

test("disabled dine-in/takeout and offline payment preferences are enforced", async (t) => {
  let business = createBusinessFixture({
    orderingPreferences: {
      dineInEnabled: false,
      takeoutEnabled: false,
    },
  });
  const { capture } = installOfflineOrderMocks(t, { business });

  const dineInRes = createResponse();
  await createOrder(createPublicOrderRequest(), dineInRes);
  assert.equal(dineInRes.statusCode, 403);

  business.orderingPreferences.dineInEnabled = true;
  const takeoutRes = createResponse();
  await createOrder(
    createPublicOrderRequest({ orderType: "takeout" }),
    takeoutRes,
  );
  assert.equal(takeoutRes.statusCode, 403);

  business.orderingPreferences.takeoutEnabled = true;
  business.paymentPreferences.acceptOfflinePayments = false;
  const offlineRes = createResponse();
  await createOrder(createPublicOrderRequest(), offlineRes);
  assert.equal(offlineRes.statusCode, 403);
  assert.equal(capture.orderCreates.length, 0);
});

test("Scenario D: manipulated tenant, ServicePoint, and item identifiers cannot create an order", async (t) => {
  const business = createBusinessFixture({ businessId: "business-a" });
  const guestSession = createGuestSessionFixture({
    businessId: "business-a",
    servicePointId: "sp_table_a",
  });
  const { capture } = installOfflineOrderMocks(t, {
    business,
    guestSession,
  });

  const wrongPointRes = createResponse();
  await createOrder(
    createPublicOrderRequest({
      businessId: "business-b",
      servicePointLabel: "sp_table_b",
    }),
    wrongPointRes,
  );
  assert.equal(wrongPointRes.statusCode, 403);

  const wrongItemRes = createResponse();
  await createOrder(
    createPublicOrderRequest({
      businessId: "business-b",
      items: [
        {
          menuItemId: "business-b-menu-item",
          itemName: "Business B Exclusive",
          quantity: 1,
        },
      ],
    }),
    wrongItemRes,
  );
  assert.equal(wrongItemRes.statusCode, 400);
  assert.equal(capture.orderCreates.length, 0);
  assert.ok(
    capture.menuQueries.every((query) => query.businessId === "business-a"),
  );
});

test("Scenario C: mixed order events split kitchen/bar items, preserve waiter view, and isolate tenants", async (t) => {
  const food = createMenuItemFixture();
  const drink = createMenuItemFixture({
    _id: "mongo-menu-cola",
    name: "Cola",
    price: 3,
    prepTimeMinutes: 2,
    category: "beverages",
    type: "drinks",
  });
  installOfflineOrderMocks(t, { menuItems: [food, drink] });
  t.mock.method(console, "log", () => {});

  const clients = [
    {
      request: createSseClientRequest({
        role: "kitchen",
        businessId: "business-a",
        session: createStaffSession({ role: "kitchen" }),
      }),
      response: createSseResponse(),
    },
    {
      request: createSseClientRequest({
        role: "bar",
        businessId: "business-a",
        session: createStaffSession({ role: "bartender" }),
      }),
      response: createSseResponse(),
    },
    {
      request: createSseClientRequest({
        role: "waiter",
        businessId: "business-a",
        session: createStaffSession({ role: "waiter" }),
      }),
      response: createSseResponse(),
    },
    {
      request: createSseClientRequest({
        role: "table",
        businessId: "business-a",
        token: "table-token-a",
      }),
      response: createSseResponse(),
    },
    {
      request: createSseClientRequest({
        role: "waiter",
        businessId: "business-b",
        session: createStaffSession({
          role: "waiter",
          businessId: "business-b",
        }),
      }),
      response: createSseResponse(),
    },
  ];

  try {
    for (const client of clients) {
      await sseHandler(client.request.req, client.response);
    }

    const res = createResponse();
    await createOrder(
      createPublicOrderRequest({
        items: [
          { itemName: "Margherita Pizza", quantity: 1 },
          { itemName: "Cola", quantity: 2 },
        ],
      }),
      res,
    );
    assert.equal(res.statusCode, 201);

    const kitchen = orderEvents(clients[0].response);
    const bar = orderEvents(clients[1].response);
    const waiter = orderEvents(clients[2].response);
    const customer = orderEvents(clients[3].response);
    const otherTenant = orderEvents(clients[4].response);

    assert.equal(kitchen.length, 1);
    assert.deepEqual(
      kitchen[0].order.items.map((item) => item.itemName),
      ["Margherita Pizza"],
    );
    assert.equal(bar.length, 1);
    assert.deepEqual(
      bar[0].order.items.map((item) => item.itemName),
      ["Cola"],
    );
    assert.equal(waiter.length, 1);
    assert.deepEqual(
      waiter[0].order.items.map((item) => item.itemName),
      ["Margherita Pizza", "Cola"],
    );
    assert.equal(customer.length, 1);
    assert.equal(customer[0].order.items.length, 2);
    assert.equal(otherTenant.length, 0);
  } finally {
    clients.forEach((client) => client.request.close());
  }
});

test("kitchen and bar queues use session tenant scope and expose only their preparation items", async (t) => {
  const rawOrders = [
    createOrderDocument({
      orderId: "MIXED-1",
      items: [
        {
          itemName: "Pizza",
          quantity: 1,
          lineTotal: 12,
          type: "food",
          category: "mains",
        },
        {
          itemName: "Cola",
          quantity: 1,
          lineTotal: 3,
          type: "drinks",
          category: "beverages",
        },
      ],
    }).toObject(),
    createOrderDocument({
      orderId: "BAR-1",
      status: "ready",
      items: [
        {
          itemName: "Lemonade",
          quantity: 1,
          lineTotal: 4,
          type: "drinks",
          category: "beverages",
        },
      ],
    }).toObject(),
  ];
  const filters = [];
  t.mock.method(Order, "find", (filter) => {
    filters.push(filter);
    return mockQuery(rawOrders);
  });

  const kitchenRes = createResponse();
  await kitchenOrders(
    { session: createStaffSession({ role: "kitchen" }) },
    kitchenRes,
  );
  assert.deepEqual(
    kitchenRes.body.orders.map((order) => order.orderId),
    ["MIXED-1"],
  );
  assert.deepEqual(
    kitchenRes.body.orders[0].items.map((item) => item.type),
    ["food"],
  );

  const barRes = createResponse();
  await barOrders(
    { session: createStaffSession({ role: "bartender" }) },
    barRes,
  );
  assert.deepEqual(
    barRes.body.orders.map((order) => order.orderId),
    ["MIXED-1", "BAR-1"],
  );
  assert.ok(
    barRes.body.orders.every((order) =>
      order.items.every((item) => item.type === "drinks"),
    ),
  );
  assert.ok(filters.every((filter) => filter.businessId === "business-a"));
});

test("waitstaff queue receives the full mixed order and session-scoped counts", async (t) => {
  const mixed = createOrderDocument({
    orderId: "MIXED-WAITER",
    items: [
      {
        itemName: "Pizza",
        quantity: 1,
        lineTotal: 12,
        type: "food",
        notes: "No basil",
        allergies: ["Dairy"],
      },
      {
        itemName: "Cola",
        quantity: 2,
        lineTotal: 6,
        type: "drinks",
        notes: "",
        allergies: [],
      },
    ],
  }).toObject();
  let orderFilter;
  t.mock.method(Business, "findOne", () =>
    mockQuery(createBusinessFixture()),
  );
  t.mock.method(Order, "find", (filter) => {
    orderFilter = filter;
    return mockQuery([mixed]);
  });
  t.mock.method(Order, "aggregate", async () => [
    { _id: "placed", count: 1 },
  ]);

  const res = createResponse();
  await waiterOrders(
    {
      query: { status: "all" },
      session: createStaffSession({ role: "waiter" }),
    },
    res,
  );

  assert.equal(orderFilter.businessId, "business-a");
  assert.equal(res.body.orders.length, 1);
  assert.equal(res.body.orders[0].items.length, 2);
  assert.deepEqual(res.body.orders[0].allergies, ["Dairy"]);
  assert.equal(res.body.orders[0].notes, "No basil");
  assert.equal(res.body.counts.placed, 1);
});

test("order lifecycle enforces sequential transitions, payment-before-completion, and timestamps", async (t) => {
  let state = createOrderDocument();
  t.mock.method(console, "log", () => {});
  t.mock.method(Order, "findOne", () => mockQuery({ ...state }));
  t.mock.method(
    Order,
    "findOneAndUpdate",
    async (query, update) => {
      if (query.businessId !== state.businessId || query.status !== state.status) {
        return null;
      }
      Object.assign(state, update.$set, { updatedAt: new Date() });
      return createOrderDocument(state);
    },
  );

  const reqBase = {
    params: { orderId: state.orderId },
    session: createStaffSession({ role: "kitchen" }),
  };

  const skippedRes = createResponse();
  await updateOrderStatus(
    { ...reqBase, body: { status: "ready" } },
    skippedRes,
  );
  assert.equal(skippedRes.statusCode, 400);

  const progressRes = createResponse();
  await updateOrderStatus(
    { ...reqBase, body: { status: "in_progress" } },
    progressRes,
  );
  assert.equal(progressRes.statusCode, 200);
  assert.equal(state.status, "in_progress");

  const backwardRes = createResponse();
  await updateOrderStatus(
    { ...reqBase, body: { status: "placed" } },
    backwardRes,
  );
  assert.equal(backwardRes.statusCode, 400);

  const readyRes = createResponse();
  await updateOrderStatus(
    { ...reqBase, body: { status: "ready" } },
    readyRes,
  );
  assert.equal(readyRes.statusCode, 200);
  assert.ok(state.readyAt instanceof Date);

  const unpaidCompleteRes = createResponse();
  await updateOrderStatus(
    { ...reqBase, body: { status: "completed" } },
    unpaidCompleteRes,
  );
  assert.equal(unpaidCompleteRes.statusCode, 400);

  state.paymentStatus = "paid";
  const completeRes = createResponse();
  await updateOrderStatus(
    { ...reqBase, body: { status: "completed" } },
    completeRes,
  );
  assert.equal(completeRes.statusCode, 200);
  assert.equal(state.status, "completed");
  assert.ok(state.completedAt instanceof Date);

  const afterCompletionRes = createResponse();
  await updateOrderStatus(
    { ...reqBase, body: { status: "ready" } },
    afterCompletionRes,
  );
  assert.equal(afterCompletionRes.statusCode, 400);
});

test("concurrent order transition conflict returns 409 without overwriting state", async (t) => {
  const order = createOrderDocument();
  t.mock.method(Order, "findOne", () => mockQuery(order));
  t.mock.method(Order, "findOneAndUpdate", async () => null);

  const res = createResponse();
  await updateOrderStatus(
    {
      params: { orderId: order.orderId },
      body: { status: "in_progress" },
      session: createStaffSession({ role: "kitchen" }),
    },
    res,
  );

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /another request/i);
});

test("cancelled orders cannot progress and cross-tenant status updates resolve no order", async (t) => {
  const queries = [];
  let order = createOrderDocument({ status: "cancelled" });
  t.mock.method(Order, "findOne", (query) => {
    queries.push(query);
    if (query.businessId !== order.businessId) return mockQuery(null);
    return mockQuery(order);
  });

  const cancelledRes = createResponse();
  await updateOrderStatus(
    {
      params: { orderId: order.orderId },
      body: { status: "in_progress" },
      session: createStaffSession(),
    },
    cancelledRes,
  );
  assert.equal(cancelledRes.statusCode, 400);

  const tenantRes = createResponse();
  await updateOrderStatus(
    {
      params: { orderId: order.orderId },
      body: { status: "in_progress" },
      session: createStaffSession({ businessId: "business-b" }),
    },
    tenantRes,
  );
  assert.equal(tenantRes.statusCode, 404);
  assert.equal(queries[1].businessId, "business-b");
});

test("offline cash payment records staff attribution, sends one receipt, and remains paid if delivery is asynchronous", async (t) => {
  const business = createBusinessFixture();
  const sourceOrder = createOrderDocument({
    receiptEmail: "customer@example.com",
  });
  const updatedOrder = createOrderDocument({
    ...sourceOrder,
    paymentStatus: "paid",
    paidVia: "cash",
    paidAt: new Date(),
    paidByStaffId: "staff-a",
    paidByName: "Alex Waiter",
    receiptEmail: "customer@example.com",
  });
  const updates = [];
  const providerRequests = [];
  const profile = {
    marketingConsent: false,
    visitCount: 0,
    orderCount: 0,
    paidOrderCount: 0,
    totalSpendCents: 0,
    averageSpendCents: 0,
    averageOrderSpendCents: 0,
    processedOrderIds: [],
    processedPaidOrderIds: [],
    favouriteItems: [],
    async save() {},
  };
  const visit = {
    orderIds: [],
    paidOrderIds: [],
    spendCents: 0,
    async save() {},
  };

  t.mock.method(Order, "findOne", () => mockQuery(sourceOrder));
  t.mock.method(
    Order,
    "findOneAndUpdate",
    async (query, update) => {
      updates.push({ query, update });
      if (query.orderId) return updatedOrder;
      return updatedOrder;
    },
  );
  t.mock.method(Order, "updateOne", async () => ({ acknowledged: true }));
  t.mock.method(Business, "findOne", () => mockQuery(business));
  t.mock.method(GuestProfile, "findOne", async () => profile);
  t.mock.method(GuestVisit, "findOne", async () => visit);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    providerRequests.push({ url, options });
    return new Response(JSON.stringify({ id: "msg-offline-receipt" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  t.mock.method(console, "log", () => {});

  const res = createResponse();
  await markPaid(
    {
      params: { orderId: sourceOrder.orderId },
      body: { paidVia: "cash", businessId: "business-b" },
      session: createStaffSession(),
    },
    res,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paymentStatus, "paid");
  assert.equal(res.body.paidVia, "cash");
  const paymentUpdate = updates.find((entry) => entry.query.orderId);
  assert.equal(paymentUpdate.query.businessId, "business-a");
  assert.equal(paymentUpdate.update.$set.paidByStaffId, "staff-a");
  assert.equal(paymentUpdate.update.$set.paidByName, "Alex Waiter");
  assert.ok(paymentUpdate.update.$set.paidAt instanceof Date);
  assert.equal(providerRequests.length, 1);
  assert.equal(
    providerRequests[0].options.headers.get("Idempotency-Key"),
    `order-receipt/business-a/${sourceOrder.orderId}`,
  );
  assert.equal(
    updates.filter((entry) => entry.query._id === sourceOrder._id).length,
    1,
  );
});

test("offline receipt provider failure does not roll back payment or stamp receipt delivery", async (t) => {
  const business = createBusinessFixture();
  const sourceOrder = createOrderDocument({
    receiptEmail: "customer@example.com",
  });
  const updatedOrder = createOrderDocument({
    ...sourceOrder,
    paymentStatus: "paid",
    paidVia: "cash",
    paidAt: new Date(),
    receiptEmail: "customer@example.com",
  });
  const updates = [];
  const profile = {
    marketingConsent: false,
    visitCount: 0,
    orderCount: 0,
    paidOrderCount: 0,
    totalSpendCents: 0,
    averageSpendCents: 0,
    averageOrderSpendCents: 0,
    processedOrderIds: [],
    processedPaidOrderIds: [],
    favouriteItems: [],
    async save() {},
  };
  const visit = {
    orderIds: [],
    paidOrderIds: [],
    spendCents: 0,
    async save() {},
  };

  t.mock.method(Order, "findOne", () => mockQuery(sourceOrder));
  t.mock.method(
    Order,
    "findOneAndUpdate",
    async (query, update) => {
      updates.push({ query, update });
      return updatedOrder;
    },
  );
  t.mock.method(Order, "updateOne", async () => ({ acknowledged: true }));
  t.mock.method(Business, "findOne", () => mockQuery(business));
  t.mock.method(GuestProfile, "findOne", async () => profile);
  t.mock.method(GuestVisit, "findOne", async () => visit);
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        name: "application_error",
        message: "Provider unavailable",
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});

  const res = createResponse();
  await markPaid(
    {
      params: { orderId: sourceOrder.orderId },
      body: { paidVia: "cash" },
      session: createStaffSession(),
    },
    res,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paymentStatus, "paid");
  assert.equal(updatedOrder.paymentStatus, "paid");
  assert.equal(updatedOrder.receiptSent, false);
  assert.equal(updatedOrder.receiptSentAt, null);
  assert.equal(
    updates.filter((entry) => entry.query._id === updatedOrder._id).length,
    0,
  );
});

test("offline mark-paid is idempotent and enforces cash/POS preferences", async (t) => {
  let order = createOrderDocument({
    paymentStatus: "paid",
    paidVia: "cash",
    paidAt: new Date(),
  });
  let business = createBusinessFixture();
  let updateCount = 0;
  t.mock.method(Order, "findOne", () => mockQuery(order));
  t.mock.method(Order, "findOneAndUpdate", async () => {
    updateCount += 1;
    return null;
  });
  t.mock.method(Business, "findOne", () => mockQuery(business));

  const repeatRes = createResponse();
  await markPaid(
    {
      params: { orderId: order.orderId },
      body: { paidVia: "cash" },
      session: createStaffSession(),
    },
    repeatRes,
  );
  assert.equal(repeatRes.statusCode, 200);
  assert.equal(repeatRes.body.alreadyPaid, true);
  assert.equal(updateCount, 0);

  order = createOrderDocument();
  business = createBusinessFixture({
    paymentPreferences: {
      acceptOfflinePayments: true,
      acceptCash: false,
      acceptPosCard: false,
    },
  });

  const cashRes = createResponse();
  await markPaid(
    {
      params: { orderId: order.orderId },
      body: { paidVia: "cash" },
      session: createStaffSession(),
    },
    cashRes,
  );
  assert.equal(cashRes.statusCode, 403);

  const posRes = createResponse();
  await markPaid(
    {
      params: { orderId: order.orderId },
      body: { paidVia: "pos_card" },
      session: createStaffSession(),
    },
    posRes,
  );
  assert.equal(posRes.statusCode, 403);
  assert.equal(updateCount, 0);
});

test("incorrect-business staff cannot mark another tenant order paid", async (t) => {
  let capturedQuery;
  t.mock.method(Order, "findOne", (query) => {
    capturedQuery = query;
    return mockQuery(null);
  });

  const res = createResponse();
  await markPaid(
    {
      params: { orderId: "BUSINESS-B-ORDER" },
      body: { paidVia: "cash", businessId: "business-b" },
      session: createStaffSession({ businessId: "business-a" }),
    },
    res,
  );

  assert.equal(res.statusCode, 404);
  assert.equal(capturedQuery.businessId, "business-a");
});

test("Scenario B: online checkout ignores client price/currency and persists the canonical Stripe snapshot", async (t) => {
  const { capture, stripeClient } = installOnlineCheckoutMocks(t);
  t.mock.method(console, "log", () => {});

  const res = createResponse();
  await createCheckoutSession(
    withStripeClient(
      createPublicOrderRequest({
        items: [
          {
            itemName: "Margherita Pizza",
            quantity: 2,
            price: 0.01,
          },
        ],
        currency: "USD",
        amount: 1,
        receiptEmail: "customer@example.com",
      }),
      stripeClient,
    ),
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.sessionUrl, "https://checkout.stripe.test/session");
  assert.equal(capture.pendingCreates.length, 1);
  assert.equal(capture.stripeConfigs.length, 1);

  const pending = capture.pendingCreates[0];
  const stripeConfig = capture.stripeConfigs[0];
  assert.equal(pending.businessId, "business-a");
  assert.equal(pending.servicePointLabel, "sp_table_a");
  assert.equal(pending.displayLabel, "Table 7");
  assert.equal(pending.items[0].lineTotal, 25);
  assert.equal(pending.subtotal, 25);
  assert.equal(pending.taxAmount, 2.5);
  assert.equal(pending.total, 27.5);
  assert.equal(pending.grossAmount, 2750);
  assert.equal(pending.currency, "EUR");
  assert.equal(pending.stripeSessionId, "cs_restaurant_flow");
  assert.equal(pending.stripePaymentIntentId, "pi_restaurant_flow");
  assert.equal(pending.stripeConnectedAccountId, "acct_business_a");
  assert.equal(pending.commissionAmountCents, 75);
  assert.equal(pending.saveCount, 1);

  assert.equal(stripeConfig.line_items[0].price_data.unit_amount, 1250);
  assert.equal(stripeConfig.line_items[0].quantity, 2);
  assert.ok(
    stripeConfig.line_items.every(
      (lineItem) => lineItem.price_data.currency === "eur",
    ),
  );
  assert.equal(stripeConfig.payment_intent_data.application_fee_amount, 75);
  assert.equal(
    stripeConfig.payment_intent_data.transfer_data.destination,
    "acct_business_a",
  );
  assert.equal(stripeConfig.metadata.businessId, "business-a");
  assert.equal(stripeConfig.customer_email, "customer@example.com");
  assert.match(stripeConfig.success_url, /payment=success/);
  assert.match(stripeConfig.cancel_url, /payment=cancelled/);
});

test("online checkout rejects unavailable items, disabled online payments, and invalid quantities before Stripe", async (t) => {
  const business = createBusinessFixture();
  const unavailable = createMenuItemFixture({ isAvailable: false });
  const { capture, stripeClient } = installOnlineCheckoutMocks(t, {
    business,
    menuItems: [unavailable],
  });

  const unavailableRes = createResponse();
  await createCheckoutSession(
    withStripeClient(createPublicOrderRequest(), stripeClient),
    unavailableRes,
  );
  assert.equal(unavailableRes.statusCode, 400);
  assert.equal(capture.stripeConfigs.length, 0);
  assert.equal(capture.pendingCreates.length, 0);

  unavailable.isAvailable = true;
  business.paymentPreferences.acceptOnlinePayments = false;
  const disabledRes = createResponse();
  await createCheckoutSession(
    withStripeClient(createPublicOrderRequest(), stripeClient),
    disabledRes,
  );
  assert.equal(disabledRes.statusCode, 403);
  assert.equal(capture.stripeConfigs.length, 0);

  const invalidRes = createResponse();
  await createCheckoutSession(
    withStripeClient(
      createPublicOrderRequest({
        items: [{ itemName: "Margherita Pizza", quantity: 0 }],
      }),
      stripeClient,
    ),
    invalidRes,
  );
  assert.equal(invalidRes.statusCode, 400);
  assert.equal(capture.stripeConfigs.length, 0);
});

test("online checkout rejects expired sessions and inactive ServicePoints", async (t) => {
  const expired = createGuestSessionFixture({
    expiresAt: new Date(Date.now() - 1000),
  });
  const { capture, stripeClient } = installOnlineCheckoutMocks(t, {
    guestSession: expired,
    servicePoint: createServicePointFixture({ isActive: false }),
  });

  const expiredRes = createResponse();
  await createCheckoutSession(
    withStripeClient(createPublicOrderRequest(), stripeClient),
    expiredRes,
  );
  assert.equal(expiredRes.statusCode, 403);

  expired.expiresAt = new Date(Date.now() + 60_000);
  const inactivePointRes = createResponse();
  await createCheckoutSession(
    withStripeClient(createPublicOrderRequest(), stripeClient),
    inactivePointRes,
  );
  assert.equal(inactivePointRes.statusCode, 400);
  assert.equal(capture.pendingCreates.length, 0);
  assert.equal(capture.stripeConfigs.length, 0);
});

test("Stripe checkout creation failure is surfaced and leaves only TTL-backed pending state", async (t) => {
  const { capture, stripeClient } = installOnlineCheckoutMocks(t, {
    stripeError: new Error("Stripe unavailable"),
  });
  t.mock.method(console, "error", () => {});

  const res = createResponse();
  await createCheckoutSession(
    withStripeClient(createPublicOrderRequest(), stripeClient),
    res,
  );

  assert.equal(res.statusCode, 500);
  assert.equal(capture.pendingCreates.length, 1);
  assert.equal(capture.pendingCreates[0].stripeSessionId, undefined);
});

test("customer history is scoped by business and device session and preserves snapshots", async (t) => {
  const stored = createOrderDocument({
    paymentStatus: "paid",
    paidVia: "cash",
  }).toObject();
  let orderFilter;
  t.mock.method(Order, "find", (filter) => {
    orderFilter = filter;
    return mockQuery([stored]);
  });
  t.mock.method(ServicePoint, "findOne", () =>
    mockQuery(createServicePointFixture()),
  );

  const res = createResponse();
  await listOrders(
    {
      query: {
        businessId: "business-a",
        sessionId: "device-a",
        servicePointLabel: "sp_attacker_override",
      },
      session: {},
    },
    res,
  );

  assert.deepEqual(orderFilter, {
    businessId: "business-a",
    sessionId: "device-a",
  });
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].paymentStatus, "paid");
  assert.equal(res.body[0].items[0].itemName, "Margherita Pizza");
  assert.equal(res.body[0].subtotal, 12.5);
  assert.equal(res.body[0].total, 13.75);
  assert.equal(res.body[0].displayLabel, "Table 7");
});

test("another device or business cannot read an order by public order ID", async (t) => {
  const stored = createOrderDocument().toObject();
  t.mock.method(Order, "findOne", (query) => {
    if (
      query.businessId !== stored.businessId ||
      query.orderId !== stored.orderId
    ) {
      return mockQuery(null);
    }
    return mockQuery(stored);
  });

  const wrongDeviceRes = createResponse();
  await getOrderById(
    {
      params: { orderId: stored.orderId },
      query: { businessId: "business-a", sessionId: "device-b" },
      body: {},
      session: {},
    },
    wrongDeviceRes,
  );
  assert.equal(wrongDeviceRes.statusCode, 403);

  const wrongBusinessRes = createResponse();
  await getOrderById(
    {
      params: { orderId: stored.orderId },
      query: { businessId: "business-b", sessionId: "device-a" },
      body: {},
      session: {},
    },
    wrongBusinessRes,
  );
  assert.equal(wrongBusinessRes.statusCode, 404);
});

test("order-again data uses current tenant menu price and rejects another guest session", async (t) => {
  const original = createOrderDocument().toObject();
  const live = createMenuItemFixture({ price: 14 });
  t.mock.method(Order, "findOne", (query) => {
    if (query.sessionId !== original.sessionId) return mockQuery(null);
    return mockQuery(original);
  });
  t.mock.method(MenuItem, "find", () => mockQuery([live]));

  const deniedRes = createResponse();
  await reorderFromOrder(
    {
      params: { orderId: original.orderId },
      body: { businessId: "business-a", sessionId: "device-b" },
    },
    deniedRes,
  );
  assert.equal(deniedRes.statusCode, 404);

  const allowedRes = createResponse();
  await reorderFromOrder(
    {
      params: { orderId: original.orderId },
      body: { businessId: "business-a", sessionId: "device-a" },
    },
    allowedRes,
  );
  assert.equal(allowedRes.statusCode, 200);
  assert.equal(allowedRes.body.items[0].price, 14);
  assert.equal(allowedRes.body.items[0].quantity, 1);
});

test("authorization rejects unauthenticated internal actions and role spoofing", async (t) => {
  const unauthorizedRes = createResponse();
  let nextCalled = false;
  requireAuth({}, unauthorizedRes, () => {
    nextCalled = true;
  });
  assert.equal(unauthorizedRes.statusCode, 401);
  assert.equal(nextCalled, false);

  const kitchenRes = createResponse();
  requireRole("waiter", "manager", "owner")(
    { session: createStaffSession({ role: "kitchen" }) },
    kitchenRes,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(kitchenRes.statusCode, 403);

  t.mock.method(console, "log", () => {});
  const spoofed = createSseClientRequest({
    role: "waiter",
    businessId: "business-a",
    session: createStaffSession({ role: "kitchen" }),
  });
  const spoofedRes = createSseResponse();
  try {
    await sseHandler(spoofed.req, spoofedRes);
    assert.match(spoofedRes.writes[0], /"role":"kitchen"/);
    assert.doesNotMatch(spoofedRes.writes[0], /"role":"waiter"/);
  } finally {
    spoofed.close();
  }
});

test("database failure during order creation returns an error without a persisted order", async (t) => {
  const business = createBusinessFixture();
  const guest = createGuestSessionFixture({ boundSessionId: "device-a" });
  let createAttempts = 0;
  t.mock.method(GuestSession, "findOne", () => mockQuery(guest));
  t.mock.method(Business, "findOne", () => mockQuery(business));
  t.mock.method(ServicePoint, "findOne", () =>
    mockQuery(createServicePointFixture()),
  );
  t.mock.method(Plan, "findOne", () => mockQuery(createPlanFixture()));
  t.mock.method(MenuItem, "findOne", () =>
    mockQuery(createMenuItemFixture()),
  );
  t.mock.method(Order, "create", async () => {
    createAttempts += 1;
    throw new Error("database unavailable");
  });
  t.mock.method(console, "error", () => {});

  const res = createResponse();
  await createOrder(createPublicOrderRequest(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(createAttempts, 1);
});
