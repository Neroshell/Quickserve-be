/**
 * ARCH-007: Financial Equivalence Test
 *
 * Proves that buildCanonicalOrderDraft produces the same field values as
 * the inline manual construction in each controller, given identical inputs.
 *
 * Run: node --test test/arch007OrderConstruction.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCanonicalOrderDraft } from "../src/services/orderConstructionService.js";

// ── Representative fixture data ──────────────────────────────────────────────
const mockBusiness = {
    businessId: "biz_test_007",
    settings: { tipsEnabled: true, taxRate: 0.07 },
    currency: "USD",
};

const mockEnrichedItems = [
    {
        menuItemId: "item_001",
        name: "Burger",
        price: 12.50,
        quantity: 2,
        lineTotal: 25.00,
        notes: "No onions",
        allergies: ["gluten"],
        prepTimeMinutes: 15,
        type: "food",
        category: "Mains",
        image: null,
    },
    {
        menuItemId: "item_002",
        name: "Fries",
        price: 5.00,
        quantity: 1,
        lineTotal: 5.00,
        notes: "",
        allergies: [],
        prepTimeMinutes: 8,
        type: "food",
        category: "Sides",
        image: null,
    },
];

const mockTip = { tipAmount: 4.50, tipType: "custom", tipPercentage: null };

// ── Before-state: what orderController.js would produce inline ───────────────
function buildGuestOfflineOrderInput_BeforeState() {
    const subtotal = 30.00;
    const taxAmount = 2.10;
    const customerPlatformFeeFloat = 0.90;
    const fullPlatformFeeCents = 90;
    const customerPlatformFeeCents = 90;
    const businessAbsorbedPlatformFeeCents = 0;
    const mode = "customer_pays";
    const percent = 3;
    const commissionRateApplied = 0.05;
    const planApplied = "growth";
    const finalCommissionAmountCents = 150;
    const tip = mockTip;
    const finalTotal = 37.50; // pricing.total

    return {
        orderId: "ORD-TEST-001",
        businessId: "biz_test_007",
        servicePointId: "sp_table5",
        displayLabel: "Table 5",
        orderType: "dine-in",
        sessionId: "sess_abc123",
        guestSessionId: "gs_xyz789",
        items: mockEnrichedItems,
        estimatedPrepMinutes: 15,
        estimatedReadyAt: new Date("2026-01-01T12:15:00Z"),
        subtotal,
        taxAmount,
        platformFeeTotal: customerPlatformFeeFloat,
        tipAmount: tip.tipAmount,
        tipType: tip.tipType,
        tipPercentage: tip.tipPercentage,
        platformFeeCents: fullPlatformFeeCents,
        customerPlatformFeeCents,
        businessAbsorbedPlatformFeeCents,
        platformFeeMode: mode,
        customerPlatformFeePercent: percent,
        total: finalTotal,
        currency: "USD",
        receiptEmail: "guest@example.com",
        journeyId: "journey_001",
        planApplied,
        commissionRateApplied,
        commissionAmountCents: finalCommissionAmountCents,
        planAtOrder: planApplied,
        commissionRateAtOrder: commissionRateApplied,
        platformFeeRateAtOrder: commissionRateApplied,
    };
}

// ── Corrected Waiter behavior: what waitstaffOrdersController produces inline
function buildWaiterOrderInput_Corrected() {
    const subtotal = 30.00;
    const taxAmount = 2.10;
    const customerPlatformFeeFloat = 0.90;
    const fullPlatformFeeCents = 90;
    const customerPlatformFeeCents = 90;
    const businessAbsorbedPlatformFeeCents = 0;
    const mode = "customer_pays";
    const percent = 3;
    const commissionRateApplied = 0.05;
    const planApplied = "growth";
    const finalCommissionAmountCents = 150;
    const tip = mockTip; // Waiter now correctly accepts tip!
    const finalTotal = 37.50; // Now uses canonical pricing.total which includes tip

    return {
        orderId: "ORD-TEST-002",
        businessId: "biz_test_007",
        servicePointId: "sp_table5",
        displayLabel: "Table 5",
        orderType: "dine-in",
        sessionId: "waiter_staff1_1700000000000",
        guestSessionId: null,
        items: mockEnrichedItems,
        estimatedPrepMinutes: 15,
        estimatedReadyAt: new Date("2026-01-01T12:15:00Z"),
        subtotal,
        taxAmount,
        platformFeeTotal: customerPlatformFeeFloat,
        tipAmount: tip.tipAmount,
        tipType: tip.tipType,
        tipPercentage: tip.tipPercentage,
        platformFeeCents: fullPlatformFeeCents,
        customerPlatformFeeCents,
        businessAbsorbedPlatformFeeCents,
        platformFeeMode: mode,
        customerPlatformFeePercent: percent,
        total: finalTotal,
        currency: "USD",
        receiptEmail: null,
        journeyId: null, // Still omits journey intentionally
        planApplied,
        commissionRateApplied,
        commissionAmountCents: finalCommissionAmountCents,
        planAtOrder: planApplied,
        commissionRateAtOrder: commissionRateApplied,
        platformFeeRateAtOrder: commissionRateApplied,
    };
}

// ── The shared fields list that buildCanonicalOrderDraft maps ─────────────────
const CANONICAL_FIELDS = [
    "businessId", "orderId", "servicePointId", "displayLabel", "orderType",
    "sessionId", "guestSessionId", "journeyId", "items",
    "subtotal", "taxAmount", "tipAmount", "tipType", "tipPercentage",
    "total", "currency",
    "platformFeeTotal", "platformFeeCents", "customerPlatformFeeCents",
    "businessAbsorbedPlatformFeeCents", "platformFeeMode", "customerPlatformFeePercent",
    "commissionAmountCents", "commissionRateApplied", "planApplied",
    "planAtOrder", "commissionRateAtOrder", "platformFeeRateAtOrder",
    "estimatedPrepMinutes", "estimatedReadyAt",
    "receiptEmail",
];

function assertFieldEquivalence(actual, expected, label) {
    for (const field of CANONICAL_FIELDS) {
        if (field === "items") {
            assert.deepStrictEqual(actual[field], expected[field], `${label}: items mismatch`);
        } else if (field === "estimatedReadyAt") {
            const a = actual[field] instanceof Date ? actual[field].toISOString() : actual[field];
            const e = expected[field] instanceof Date ? expected[field].toISOString() : expected[field];
            assert.strictEqual(a, e, `${label}: ${field} mismatch`);
        } else {
            assert.strictEqual(actual[field], expected[field],
                `${label}: ${field} mismatch — got ${JSON.stringify(actual[field])}, expected ${JSON.stringify(expected[field])}`);
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("ARCH-007: buildCanonicalOrderDraft equivalence", () => {
    it("Guest offline: draft matches before-state inline construction", () => {
        const expected = buildGuestOfflineOrderInput_BeforeState();
        const actual = buildCanonicalOrderDraft({
            business: mockBusiness,
            orderId: "ORD-TEST-001",
            servicePointId: "sp_table5",
            displayLabel: "Table 5",
            orderType: "dine-in",
            sessionId: "sess_abc123",
            guestSessionId: "gs_xyz789",
            enrichedItems: mockEnrichedItems,
            subtotal: 30.00,
            taxAmount: 2.10,
            tip: mockTip,
            total: 37.50,
            currency: "USD",
            platformFeeTotal: 0.90,
            platformFeeCents: 90,
            customerPlatformFeeCents: 90,
            businessAbsorbedPlatformFeeCents: 0,
            platformFeeMode: "customer_pays",
            customerPlatformFeePercent: 3,
            commissionAmountCents: 150,
            commissionRateApplied: 0.05,
            planApplied: "growth",
            estimatedPrepMinutes: 15,
            estimatedReadyAt: new Date("2026-01-01T12:15:00Z"),
            journeyId: "journey_001",
            receiptEmail: "guest@example.com",
        });
        assertFieldEquivalence(actual, expected, "Guest Offline");
    });

    it("Waiter: draft matches corrected canonical construction", () => {
        const expected = buildWaiterOrderInput_Corrected();
        const tip = mockTip;
        const subtotal = 30.00;
        const taxAmount = 2.10;
        const customerPlatformFeeFloat = 0.90;
        const finalTotal = 37.50; // Canonical pricing.total

        const actual = buildCanonicalOrderDraft({
            business: mockBusiness,
            orderId: "ORD-TEST-002",
            servicePointId: "sp_table5",
            displayLabel: "Table 5",
            orderType: "dine-in",
            sessionId: "waiter_staff1_1700000000000",
            guestSessionId: null,
            enrichedItems: mockEnrichedItems,
            subtotal,
            taxAmount,
            tip,
            total: finalTotal,
            currency: "USD",
            platformFeeTotal: customerPlatformFeeFloat,
            platformFeeCents: 90,
            customerPlatformFeeCents: 90,
            businessAbsorbedPlatformFeeCents: 0,
            platformFeeMode: "customer_pays",
            customerPlatformFeePercent: 3,
            commissionAmountCents: 150,
            commissionRateApplied: 0.05,
            planApplied: "growth",
            estimatedPrepMinutes: 15,
            estimatedReadyAt: new Date("2026-01-01T12:15:00Z"),
            journeyId: null,
            receiptEmail: null,
        });
        assertFieldEquivalence(actual, expected, "Waiter");
    });

    it("Builder is a pure function — same inputs yield same outputs", () => {
        const args = {
            business: mockBusiness,
            orderId: "ORD-PURE-001",
            servicePointId: "sp_1",
            displayLabel: "Bar 1",
            orderType: "dine-in",
            sessionId: "s1",
            guestSessionId: "g1",
            enrichedItems: mockEnrichedItems,
            subtotal: 10,
            taxAmount: 0.70,
            tip: { tipAmount: 1, tipType: "custom", tipPercentage: null },
            total: 11.70,
            currency: "USD",
            platformFeeTotal: 0,
            platformFeeCents: 0,
            customerPlatformFeeCents: 0,
            businessAbsorbedPlatformFeeCents: 0,
            platformFeeMode: "business_absorbs",
            customerPlatformFeePercent: 0,
            commissionAmountCents: 50,
            commissionRateApplied: 0.05,
            planApplied: "free",
            estimatedPrepMinutes: 10,
            estimatedReadyAt: new Date("2026-01-01T12:10:00Z"),
            journeyId: null,
            receiptEmail: null,
        };
        const a = buildCanonicalOrderDraft(args);
        const b = buildCanonicalOrderDraft(args);
        assert.deepStrictEqual(a, b, "Pure function: same inputs must yield same outputs");
    });

    it("Builder does not add channel-specific fields", () => {
        const draft = buildCanonicalOrderDraft({
            business: mockBusiness,
            orderId: "ORD-PURE-002",
            servicePointId: "sp_1",
            displayLabel: "Bar 1",
            orderType: "dine-in",
            sessionId: "s1",
            guestSessionId: "g1",
            enrichedItems: [],
            subtotal: 0,
            taxAmount: 0,
            tip: { tipAmount: 0, tipType: null, tipPercentage: null },
            total: 0,
            currency: "USD",
            platformFeeTotal: 0,
            platformFeeCents: 0,
            customerPlatformFeeCents: 0,
            businessAbsorbedPlatformFeeCents: 0,
            platformFeeMode: "business_absorbs",
            customerPlatformFeePercent: 0,
            commissionAmountCents: 0,
            commissionRateApplied: 0,
            planApplied: null,
            estimatedPrepMinutes: null,
            estimatedReadyAt: null,
            journeyId: null,
            receiptEmail: null,
        });
        const channelFields = [
            "status", "paymentChannel", "paymentStatus", "paidVia", "paidAt",
            "paidByStaffId", "paidByName", "orderSource", "createdBy",
            "createdByStaffId", "creationIdempotencyKey", "creationRequestFingerprint",
        ];
        for (const f of channelFields) {
            assert.strictEqual(f in draft, false,
                `Channel-specific field '${f}' must NOT be in canonical draft`);
        }
    });
});
