import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import Business from "../models/Business.js";
import CrmOrderProjectionLedger from "../models/CrmOrderProjectionLedger.js";
import GuestProfile from "../models/GuestProfile.js";
import GuestVisit from "../models/GuestVisit.js";
import Order from "../models/order.js";
import { enqueueCrmOrder } from "../queues/postPaymentQueue.js";
import { resolveBusinessDay } from "../utils/businessDate.js";
import { linkJourneyToProfile } from "./customerJourneyService.js";

export const CRM_ORDER_CLAIM_LEASE_MS = 2 * 60 * 1000;
export const CRM_REPAIR_THRESHOLD_MS = 5 * 60 * 1000;
export const CRM_REPAIR_BATCH_SIZE = 100;

function normalizedEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email || null;
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

function safeError(error) {
  return String(error?.message || error?.code || "crm_processing_failed").slice(0, 500);
}

/**
 * Canonical CRM paid-order revenue.
 *
 * Order.total is backend-authoritative and includes applicable tax and
 * customer-paid platform fees. Tips belong to staff-tip reporting, so CRM
 * customer revenue subtracts tipAmount before converting to integer cents.
 */
export function getCrmOrderRevenueCents(order) {
  if (
    order?.total !== null &&
    order?.total !== undefined &&
    order?.total !== "" &&
    Number.isFinite(Number(order.total))
  ) {
    return Math.max(
      0,
      Math.round((Number(order.total) - Number(order.tipAmount || 0)) * 100),
    );
  }
  return finiteInteger(order?.totalInCents);
}

function aggregateOrderItems(items = []) {
  const totals = new Map();
  for (const item of items) {
    const itemName = String(item?.itemName || "").trim();
    const quantity = Number(item?.quantity);
    if (!itemName || !Number.isFinite(quantity) || quantity <= 0) continue;
    totals.set(itemName, (totals.get(itemName) || 0) + quantity);
  }
  return [...totals.entries()].map(([itemName, quantity]) => ({
    itemName,
    quantity,
  }));
}

export function buildCrmLedgerContribution({ order, business, email }) {
  const businessId = String(order?.businessId || "").trim();
  const orderId = String(order?.orderId || "").trim();
  const ownerEmail = normalizedEmail(email);
  if (!businessId || !orderId || !ownerEmail) {
    throw new TypeError("businessId, orderId, and CRM email are required");
  }
  // Preserve the existing CRM visit-day definition: the business-local day
  // when the order was created, even if payment is confirmed later.
  const orderDate = new Date(order.createdAt || order.paidAt || Date.now());
  if (Number.isNaN(orderDate.getTime())) {
    throw new TypeError("Order payment date is invalid");
  }
  return {
    businessId,
    orderId,
    email: ownerEmail,
    orderDate,
    localVisitDate: resolveBusinessDay(business || { timezone: "UTC" }, orderDate).businessDay,
    spendCents: getCrmOrderRevenueCents(order),
    items: aggregateOrderItems(order.items),
  };
}

function baselineFromProfile(profile, now) {
  const existing = profile?.crmProjectionBaseline;
  if (existing?.capturedAt) return existing;
  return {
    capturedAt: now,
    firstVisitAt: profile?.firstVisitAt || null,
    lastVisitAt: profile?.lastVisitAt || null,
    firstOrderId: profile?.firstOrderId || null,
    lastOrderId: profile?.lastOrderId || null,
    visitCount: finiteInteger(profile?.visitCount),
    orderCount: finiteInteger(profile?.orderCount),
    paidOrderCount: finiteInteger(profile?.paidOrderCount),
    totalSpendCents: finiteInteger(profile?.totalSpendCents),
    favouriteItems: aggregateOrderItems(profile?.favouriteItems),
  };
}

function earlierEntry(left, right) {
  return new Date(left.orderDate).getTime() - new Date(right.orderDate).getTime() ||
    String(left.orderId).localeCompare(String(right.orderId));
}

export function buildCrmProjection({ entries, profileBaseline, visitBaselines }) {
  const ordered = [...entries].sort(earlierEntry);
  const baseline = profileBaseline || baselineFromProfile(null, new Date());
  const grouped = new Map();
  const itemTotals = new Map();

  for (const item of baseline.favouriteItems || []) {
    itemTotals.set(item.itemName, finiteInteger(item.quantity));
  }
  for (const entry of ordered) {
    const group = grouped.get(entry.localVisitDate) || [];
    group.push(entry);
    grouped.set(entry.localVisitDate, group);
    for (const item of entry.items || []) {
      itemTotals.set(
        item.itemName,
        (itemTotals.get(item.itemName) || 0) + finiteInteger(item.quantity),
      );
    }
  }

  const ledgerSpend = ordered.reduce(
    (sum, entry) => sum + finiteInteger(entry.spendCents),
    0,
  );
  const addedVisitCount = [...grouped.keys()].filter(
    (date) => !visitBaselines.get(date)?.exists,
  ).length;
  const totalSpendCents = finiteInteger(baseline.totalSpendCents) + ledgerSpend;
  const visitCount = finiteInteger(baseline.visitCount) + addedVisitCount;
  const orderCount = finiteInteger(baseline.orderCount) + ordered.length;
  const paidOrderCount = finiteInteger(baseline.paidOrderCount) + ordered.length;
  const firstLedger = ordered[0] || null;
  const lastLedger = ordered.at(-1) || null;
  const baselineFirst = baseline.firstVisitAt ? new Date(baseline.firstVisitAt) : null;
  const baselineLast = baseline.lastVisitAt ? new Date(baseline.lastVisitAt) : null;
  const useLedgerFirst = firstLedger &&
    (!baselineFirst || new Date(firstLedger.orderDate) < baselineFirst);
  const useLedgerLast = lastLedger &&
    (!baselineLast || new Date(lastLedger.orderDate) > baselineLast);

  const visits = [...grouped.entries()].map(([visitDate, dateEntries]) => {
    const visitBaseline = visitBaselines.get(visitDate) || {
      exists: false,
      orderIds: [],
      paidOrderIds: [],
      spendCents: 0,
    };
    const ledgerOrderIds = dateEntries.map((entry) => entry.orderId);
    return {
      visitDate,
      baseline: visitBaseline,
      orderIds: [...new Set([...(visitBaseline.orderIds || []), ...ledgerOrderIds])],
      paidOrderIds: [
        ...new Set([...(visitBaseline.paidOrderIds || []), ...ledgerOrderIds]),
      ],
      spendCents: finiteInteger(visitBaseline.spendCents) +
        dateEntries.reduce((sum, entry) => sum + finiteInteger(entry.spendCents), 0),
    };
  });

  return {
    profile: {
      guestStatus: paidOrderCount > 0 ? "customer" : "lead",
      firstVisitAt: useLedgerFirst ? new Date(firstLedger.orderDate) : baselineFirst,
      lastVisitAt: useLedgerLast ? new Date(lastLedger.orderDate) : baselineLast,
      firstOrderId: useLedgerFirst ? firstLedger.orderId : baseline.firstOrderId,
      lastOrderId: useLedgerLast ? lastLedger.orderId : baseline.lastOrderId,
      visitCount,
      orderCount,
      paidOrderCount,
      totalSpendCents,
      averageSpendCents: visitCount > 0
        ? Math.round(totalSpendCents / visitCount)
        : 0,
      averageOrderSpendCents: paidOrderCount > 0
        ? Math.round(totalSpendCents / paidOrderCount)
        : 0,
      favouriteItems: [...itemTotals.entries()]
        .map(([itemName, quantity]) => ({ itemName, quantity }))
        .sort((a, b) => b.quantity - a.quantity || a.itemName.localeCompare(b.itemName))
        .slice(0, 10),
    },
    visits,
  };
}

export const mongoCrmRepository = {
  async claimOrder({ businessId, orderId, claimId, now, staleBefore }) {
    return Order.findOneAndUpdate(
      {
        businessId,
        orderId,
        paymentStatus: "paid",
        crmProcessed: { $ne: true },
        crmEmail: { $type: "string", $ne: "" },
        $or: [
          { crmProcessingStatus: "pending" },
          {
            crmProcessingStatus: "failed",
            crmProcessingRetryable: { $ne: false },
          },
          {
            crmProcessingStatus: "processing",
            crmProcessingClaimedAt: { $lte: staleBefore },
          },
          { crmProcessingStatus: null },
          { crmProcessingStatus: { $exists: false } },
        ],
      },
      {
        $set: {
          crmProcessingStatus: "processing",
          crmProcessingClaimId: claimId,
          crmProcessingClaimedAt: now,
          crmProcessingFailedAt: null,
          crmProcessingLastError: null,
          crmProcessingRetryable: true,
        },
        $inc: { crmProcessingAttemptCount: 1 },
      },
      { new: true },
    ).lean();
  },

  async loadOrder({ businessId, orderId }) {
    return Order.findOne({ businessId, orderId }).lean();
  },

  async loadBusiness({ businessId }) {
    return Business.findOne({ businessId }).lean();
  },

  async ensureLedger(contribution) {
    try {
      return await CrmOrderProjectionLedger.findOneAndUpdate(
        { businessId: contribution.businessId, orderId: contribution.orderId },
        { $setOnInsert: { ...contribution, status: "pending" } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean();
    } catch (error) {
      if (error?.code !== 11000) throw error;
      return CrmOrderProjectionLedger.findOne({
        businessId: contribution.businessId,
        orderId: contribution.orderId,
      }).lean();
    }
  },

  async claimGuest({ businessId, email, claimId, now, staleBefore }) {
    try {
      return await GuestProfile.findOneAndUpdate(
        {
          businessId,
          email,
          $or: [
            { crmProjectionClaimId: null },
            { crmProjectionClaimId: { $exists: false } },
            { crmProjectionClaimedAt: { $lte: staleBefore } },
          ],
        },
        {
          $set: { crmProjectionClaimId: claimId, crmProjectionClaimedAt: now },
          $setOnInsert: {
            businessId,
            email,
            guestStatus: "lead",
            source: "receipt",
            firstCapturedAt: now,
            lastCapturedAt: now,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean();
    } catch (error) {
      if (error?.code === 11000) return null;
      throw error;
    }
  },

  async ensureProfileBaseline({ businessId, email, claimId, profile, now }) {
    const baseline = baselineFromProfile(profile, now);
    if (profile?.crmProjectionBaseline?.capturedAt) return baseline;
    await GuestProfile.updateOne(
      {
        businessId,
        email,
        crmProjectionClaimId: claimId,
        $or: [
          { crmProjectionBaseline: null },
          { crmProjectionBaseline: { $exists: false } },
        ],
      },
      { $set: { crmProjectionBaseline: baseline } },
    );
    return baseline;
  },

  async ensureVisitBaseline({ businessId, email, visitDate, now }) {
    const visit = await GuestVisit.findOne({ businessId, email, visitDate }).lean();
    if (!visit) {
      return {
        exists: false,
        capturedAt: now,
        existed: false,
        orderIds: [],
        paidOrderIds: [],
        spendCents: 0,
      };
    }
    if (visit.crmProjectionBaseline?.capturedAt) {
      return {
        exists: visit.crmProjectionBaseline.existed !== false,
        ...visit.crmProjectionBaseline,
      };
    }
    const baseline = {
      capturedAt: now,
      existed: true,
      orderIds: visit.orderIds || [],
      paidOrderIds: visit.paidOrderIds || [],
      spendCents: finiteInteger(visit.spendCents),
    };
    await GuestVisit.updateOne(
      {
        businessId,
        email,
        visitDate,
        $or: [
          { "crmProjectionBaseline.capturedAt": null },
          { "crmProjectionBaseline.capturedAt": { $exists: false } },
        ],
      },
      { $set: { crmProjectionBaseline: baseline } },
    );
    return { exists: true, ...baseline };
  },

  async listLedgerEntries({ businessId, email }) {
    return CrmOrderProjectionLedger.find({ businessId, email })
      .sort({ orderDate: 1, orderId: 1 })
      .lean();
  },

  async replaceProfile({ businessId, email, claimId, projection, now }) {
    const result = await GuestProfile.updateOne(
      { businessId, email, crmProjectionClaimId: claimId },
      { $set: { ...projection, lastCapturedAt: now } },
    );
    if (result.matchedCount !== 1) throw new Error("CRM guest projection claim was lost");
  },

  async replaceVisit({ businessId, email, visit, now }) {
    const baseline = {
      capturedAt: visit.baseline.capturedAt || now,
      existed: visit.baseline.exists === true,
      orderIds: visit.baseline.orderIds || [],
      paidOrderIds: visit.baseline.paidOrderIds || [],
      spendCents: finiteInteger(visit.baseline.spendCents),
    };
    await GuestVisit.findOneAndUpdate(
      { businessId, email, visitDate: visit.visitDate },
      {
        $set: {
          orderIds: visit.orderIds,
          paidOrderIds: visit.paidOrderIds,
          spendCents: visit.spendCents,
        },
        $setOnInsert: {
          businessId,
          email,
          visitDate: visit.visitDate,
          crmProjectionBaseline: baseline,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  },

  async completeLedger({ businessId, orderId, now }) {
    await CrmOrderProjectionLedger.updateOne(
      { businessId, orderId },
      { $set: { status: "completed", completedAt: now } },
    );
  },

  async completeOrder({ businessId, orderId, claimId, now }) {
    const result = await Order.updateOne(
      {
        businessId,
        orderId,
        paymentStatus: "paid",
        crmProcessingClaimId: claimId,
      },
      {
        $set: {
          crmProcessed: true,
          crmProcessedAt: now,
          crmProcessingStatus: "completed",
          crmProcessingClaimId: null,
          crmProcessingClaimedAt: null,
          crmProcessingFailedAt: null,
          crmProcessingLastError: null,
          crmProcessingRetryable: false,
        },
      },
    );
    if (result.matchedCount !== 1) throw new Error("CRM order claim was lost");
  },

  async failOrder({ businessId, orderId, claimId, now, error, retryable = true }) {
    await Order.updateOne(
      { businessId, orderId, crmProcessingClaimId: claimId },
      {
        $set: {
          crmProcessingStatus: "failed",
          crmProcessingFailedAt: now,
          crmProcessingLastError: safeError(error),
          crmProcessingRetryable: retryable,
          crmProcessingClaimId: null,
          crmProcessingClaimedAt: null,
        },
      },
    );
  },

  async releaseGuest({ businessId, email, claimId }) {
    await GuestProfile.updateOne(
      { businessId, email, crmProjectionClaimId: claimId },
      { $set: { crmProjectionClaimId: null, crmProjectionClaimedAt: null } },
    );
  },
};

export async function processCrmOrder({
  businessId,
  orderId,
  now = new Date(),
  claimId = randomUUID(),
  repository = mongoCrmRepository,
  linkJourney = linkJourneyToProfile,
} = {}) {
  const staleBefore = new Date(now.getTime() - CRM_ORDER_CLAIM_LEASE_MS);
  const claimed = await repository.claimOrder({
    businessId,
    orderId,
    claimId,
    now,
    staleBefore,
  });
  if (!claimed) {
    const current = await repository.loadOrder({ businessId, orderId });
    if (!current) return { skipped: true, reason: "order_not_found" };
    if (current.paymentStatus !== "paid") {
      return { skipped: true, reason: "order_not_paid" };
    }
    if (current.crmProcessed || current.crmProcessingStatus === "completed") {
      return { skipped: true, reason: "already_completed" };
    }
    return { skipped: true, reason: "claim_busy" };
  }

  let guestClaimed = false;
  let email = null;
  try {
    const order = await repository.loadOrder({ businessId, orderId });
    if (!order || order.businessId !== businessId) {
      throw new Error("Tenant-scoped order reload failed");
    }
    if (order.paymentStatus !== "paid") {
      await repository.failOrder({
        businessId,
        orderId,
        claimId,
        now,
        error: new Error("Order is not paid"),
        retryable: false,
      });
      return { skipped: true, reason: "order_not_paid" };
    }
    email = normalizedEmail(order.crmEmail);
    if (!email) {
      await repository.failOrder({
        businessId,
        orderId,
        claimId,
        now,
        error: new Error("CRM owner email is missing"),
        retryable: false,
      });
      return { skipped: true, reason: "crm_email_missing" };
    }
    const business = await repository.loadBusiness({ businessId });
    if (!business || business.businessId !== businessId) {
      throw new Error("Tenant-scoped business reload failed");
    }

    const contribution = buildCrmLedgerContribution({ order, business, email });
    const ledger = await repository.ensureLedger(contribution);
    if (normalizedEmail(ledger?.email) !== email) {
      throw new Error("CRM ledger ownership conflict");
    }

    const profile = await repository.claimGuest({
      businessId,
      email,
      claimId,
      now,
      staleBefore,
    });
    if (!profile) throw new Error("CRM guest projection is busy");
    guestClaimed = true;

    const profileBaseline = await repository.ensureProfileBaseline({
      businessId,
      email,
      claimId,
      profile,
      now,
    });
    const entries = await repository.listLedgerEntries({ businessId, email });
    const visitBaselines = new Map();
    for (const visitDate of new Set(entries.map((entry) => entry.localVisitDate))) {
      visitBaselines.set(
        visitDate,
        await repository.ensureVisitBaseline({ businessId, email, visitDate, now }),
      );
    }
    const projection = buildCrmProjection({
      entries,
      profileBaseline,
      visitBaselines,
    });
    await repository.replaceProfile({
      businessId,
      email,
      claimId,
      projection: projection.profile,
      now,
    });
    for (const visit of projection.visits) {
      await repository.replaceVisit({ businessId, email, visit, now });
    }
    if (order?.journeyId && profile?._id) {
      try {
        await linkJourney({
          businessId,
          journeyId: order.journeyId,
          guestProfileId: profile._id,
          identifiedAt: now,
        });
      } catch (journeyError) {
        // Journey intelligence is fail-open and must never block the canonical
        // GuestProfile/ledger projection.
        console.error("[CRM] CustomerJourney profile linkage failed", {
          businessId,
          orderId,
          reason: journeyError?.code || journeyError?.name || "journey_link_failed",
        });
      }
    }
    await repository.completeLedger({ businessId, orderId, now });
    await repository.completeOrder({ businessId, orderId, claimId, now });
    return {
      completed: true,
      businessId,
      orderId,
      email,
      visitDate: contribution.localVisitDate,
    };
  } catch (error) {
    await repository.failOrder({
      businessId,
      orderId,
      claimId,
      now,
      error,
      retryable: true,
    });
    throw error;
  } finally {
    if (guestClaimed && email) {
      await repository.releaseGuest({ businessId, email, claimId });
    }
  }
}

export async function captureGuestLead({
  businessId,
  email,
  marketingConsent,
  now = new Date(),
  guestProfileModel = GuestProfile,
} = {}) {
  const ownerEmail = normalizedEmail(email);
  if (!businessId || !ownerEmail) return null;
  const set = { lastCapturedAt: now };
  if (marketingConsent === true) {
    set.marketingConsent = true;
    set.marketingConsentUpdatedAt = now;
  }
  try {
    return await guestProfileModel.findOneAndUpdate(
      { businessId, email: ownerEmail },
      {
        $set: set,
        $setOnInsert: {
          businessId,
          email: ownerEmail,
          guestStatus: "lead",
          firstCapturedAt: now,
          source: "receipt",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    console.error("[CRM] Guest lead capture failed", {
      businessId,
      reason: error?.code || error?.name || "lead_capture_failed",
    });
    return null;
  }
}

export async function recordCrmOrderIntent({
  businessId,
  orderId,
  email,
  now = new Date(),
  orderModel = Order,
} = {}) {
  const ownerEmail = normalizedEmail(email);
  if (!businessId || !orderId || !ownerEmail) {
    return { recorded: false, reason: "missing_crm_identity" };
  }
  const order = await orderModel.findOneAndUpdate(
    {
      businessId,
      orderId,
      paymentStatus: "paid",
      crmProcessed: { $ne: true },
      crmProcessingStatus: { $ne: "processing" },
      $or: [
        { crmEmail: ownerEmail },
        { crmEmail: null },
        { crmEmail: { $exists: false } },
      ],
    },
    {
      $set: {
        crmEmail: ownerEmail,
        crmProcessingStatus: "pending",
        crmProcessingRetryable: true,
        crmProcessingLastError: null,
        crmProcessingFailedAt: null,
        crmProcessingEnqueueError: null,
        crmProcessingEnqueuedAt: now,
      },
    },
    { new: true },
  );
  return order
    ? { recorded: true, order }
    : { recorded: false, reason: "not_paid_or_owner_locked" };
}

export async function dispatchCrmOrder({
  businessId,
  orderId,
  env = process.env,
  enqueue = enqueueCrmOrder,
  orderModel = Order,
  now = new Date(),
  processOrder = processCrmOrder,
  isDatabaseReady = () => mongoose.connection.readyState === 1,
} = {}) {
  try {
    const queued = await enqueue({ businessId, orderId }, { env });
    if (
      !queued.queued &&
      queued.reason === "post_payment_queue_disabled" &&
      isDatabaseReady()
    ) {
      const result = await processOrder({ businessId, orderId, now });
      return { queued: false, direct: true, result };
    }
    if (queued.queued) {
      await orderModel.updateOne(
        { businessId, orderId, crmProcessed: { $ne: true } },
        {
          $set: {
            crmProcessingEnqueuedAt: now,
            crmProcessingEnqueueError: null,
          },
        },
      );
    }
    return queued;
  } catch (error) {
    await orderModel.updateOne(
      { businessId, orderId, crmProcessed: { $ne: true } },
      { $set: { crmProcessingEnqueueError: safeError(error) } },
    ).catch(() => {});
    console.error("[CRM] Post-payment enqueue failed", {
      businessId,
      orderId,
      reason: error?.code || error?.name || "enqueue_failed",
    });
    return { queued: false, reason: "enqueue_failed" };
  }
}

export async function scanCrmOrderRepairs({
  now = new Date(),
  thresholdMs = CRM_REPAIR_THRESHOLD_MS,
  batchSize = CRM_REPAIR_BATCH_SIZE,
  maxBatches = 100,
  orderModel = Order,
  businessModel = Business,
  enqueue = enqueueCrmOrder,
  env = process.env,
} = {}) {
  const threshold = new Date(now.getTime() - thresholdMs);
  const staleClaim = new Date(now.getTime() - CRM_ORDER_CLAIM_LEASE_MS);
  const summary = { candidates: 0, queued: 0, failed: 0, batches: 0 };
  let lastBusinessId = null;
  let exhaustedBatchBudget = false;

  while (!exhaustedBatchBudget) {
    const businessFilter = lastBusinessId ? { _id: { $gt: lastBusinessId } } : {};
    const businesses = await businessModel.find(businessFilter)
      .select({ _id: 1, businessId: 1 })
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();
    if (businesses.length === 0) break;

    for (const business of businesses) {
      let lastOrderId = null;
      while (summary.batches < maxBatches) {
        const filter = {
          businessId: business.businessId,
          paymentStatus: "paid",
          crmProcessed: { $ne: true },
          crmProcessingRetryable: { $ne: false },
          paidAt: { $lte: threshold },
          $or: [
            { crmProcessingStatus: "pending" },
            {
              crmProcessingStatus: "failed",
              crmProcessingFailedAt: { $lte: threshold },
            },
            {
              crmProcessingStatus: "processing",
              crmProcessingClaimedAt: { $lte: staleClaim },
            },
            { crmProcessingStatus: null },
            { crmProcessingStatus: { $exists: false } },
          ],
        };
        if (lastOrderId) filter._id = { $gt: lastOrderId };
        const orders = await orderModel.find(filter)
          .sort({ _id: 1 })
          .limit(batchSize)
          .lean();
        if (orders.length === 0) break;
        summary.batches += 1;

        for (const order of orders) {
          summary.candidates += 1;
          const email = normalizedEmail(order.crmEmail || order.receiptEmail);
          try {
            if (!email) continue;
            if (!order.crmEmail || !order.crmProcessingStatus) {
              await recordCrmOrderIntent({
                businessId: order.businessId,
                orderId: order.orderId,
                email,
                now,
                orderModel,
              });
            }
            const result = await enqueue(
              { businessId: order.businessId, orderId: order.orderId },
              { env, repair: true },
            );
            if (result.queued) summary.queued += 1;
          } catch (error) {
            summary.failed += 1;
            await orderModel.updateOne(
              { businessId: order.businessId, orderId: order.orderId },
              { $set: { crmProcessingEnqueueError: safeError(error) } },
            ).catch(() => {});
          }
        }
        lastOrderId = orders.at(-1)._id;
        if (orders.length < batchSize) break;
      }
      if (summary.batches >= maxBatches) {
        exhaustedBatchBudget = true;
        break;
      }
    }
    lastBusinessId = businesses.at(-1)._id;
    if (businesses.length < batchSize) break;
  }
  return summary;
}

/**
 * Backward-compatible lead capture only. Paid counters are now exclusively
 * projected by processCrmOrder from the durable per-order ledger.
 */
export async function upsertGuestProfileFromOrder({
  businessId,
  email,
  marketingConsent,
  trackVisit = true,
} = {}) {
  if (trackVisit) return null;
  return captureGuestLead({ businessId, email, marketingConsent });
}
