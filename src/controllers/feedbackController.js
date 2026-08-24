import { DateTime } from "luxon"
import Feedback from "../models/Feedback.js"
import Order from "../models/order.js"
import ServicePoint from "../models/ServicePoint.js"
import Business from "../models/Business.js"

import { resolveAnalyticsDateRange } from "../utils/businessDate.js"

export async function submitFeedback(req, res) {
    try {
        const {
            orderId,
            businessId,
            overallRating,
            tags,
            comment,
            wouldRecommend,
            sessionId
        } = req.body;

        if (!orderId || !businessId || !overallRating) {
            return res.status(400).json({ error: "Missing required fields: orderId, businessId, overallRating" });
        }
        if (!sessionId) {
            return res.status(400).json({ error: "sessionId is required" });
        }

        const order = await Order.findOne({ orderId, businessId }).lean();
        if (!order) {
            return res.status(404).json({ error: "Order not found" });
        }

        // Ownership: only the device that placed the order may review it.
        // Prevents scripted/spoofed reviews against guessed orderIds.
        if (order.sessionId !== sessionId) {
            return res.status(403).json({ error: "Forbidden" });
        }

        if (order.status !== "completed") {
            return res.status(400).json({ error: "Feedback can only be submitted for completed (served) orders" });
        }

        let sentiment = "neutral";
        if (overallRating >= 4) sentiment = "positive";
        else if (overallRating <= 2) sentiment = "negative";

        try {
            await Feedback.create({
                businessId,
                orderId,
                sessionId: order.sessionId || "unknown",
                overallRating,
                tags: tags || [],
                comment,
                sentiment,
                wouldRecommend,
                orderType: order.orderType,
                servicePointId: order.servicePointLabel,
                orderValue: order.total || 0
            });
        } catch (dbErr) {
            // MongoDB duplicate key error (11000)
            if (dbErr.code === 11000) {
                return res.status(409).json({ error: "Feedback already submitted for this order" });
            }
            throw dbErr;
        }

        await Order.updateOne({ _id: order._id }, { $set: { feedbackSubmitted: true } });

        return res.status(201).json({ message: "Feedback submitted successfully" });
    } catch (error) {
        console.error("[submitFeedback error]", error);
        return res.status(500).json({ error: "Failed to submit feedback" });
    }
}

export async function getOwnerFeedbackAnalytics(req, res) {
    try {
        const { range = "today", from, to } = req.query;
        const businessId = req.session?.user?.businessId;

        if (!businessId) {
            return res.status(400).json({ error: "businessId is required" });
        }

        const business = await Business.findOne({ businessId }).lean();
        if (!business) {
            return res.status(404).json({ error: "Business not found" });
        }

        const { startDateJS, endDateJS } = resolveAnalyticsDateRange(business, range, from, to);

        const dateFilter = { businessId, createdAt: { $gte: startDateJS, $lt: endDateJS } };

        // 1. Total Completed Orders for Response Rate calculation
        const totalCompletedOrders = await Order.countDocuments({
            businessId,
            createdAt: { $gte: startDateJS, $lt: endDateJS },
            status: "completed"
        });

        // 2. Aggregate Feedback Metrics
        const feedbacks = await Feedback.find(dateFilter).sort({ createdAt: -1 }).lean();

        let totalFeedbacks = feedbacks.length;
        let responseRate = totalCompletedOrders > 0 ? Math.round((totalFeedbacks / totalCompletedOrders) * 100) : 0;

        let sumOverall = 0;
        let csatPositives = 0;

        const ratingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
        const trendsMap = new Map(); // Date string -> { count, ratingSum }
        const tagCounts = {};

        // Determine trend label format based on range
        const isSingleDay = range === "today" || range === "yesterday" || (range === "custom" && from === to);

        feedbacks.forEach(f => {
            sumOverall += f.overallRating;
            ratingDistribution[f.overallRating] = (ratingDistribution[f.overallRating] || 0) + 1;

            if (f.overallRating >= 4) csatPositives++;

            if (Array.isArray(f.tags)) {
                f.tags.forEach(tag => {
                    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                });
            }

            const fDateObj = DateTime.fromJSDate(f.createdAt).setZone(business.timezone || "Europe/Malta");
            let trendLabel;
            if (isSingleDay) {
                trendLabel = `${fDateObj.toFormat("h")}${fDateObj.toFormat("a")}`;
            } else if (range === "12months") {
                trendLabel = fDateObj.toFormat("MMM yyyy");
            } else {
                trendLabel = fDateObj.toFormat("MMM dd");
            }

            if (!trendsMap.has(trendLabel)) trendsMap.set(trendLabel, { count: 0, ratingSum: 0 });
            const trendData = trendsMap.get(trendLabel);
            trendData.count += 1;
            trendData.ratingSum += f.overallRating;
        });

        const averageRating = totalFeedbacks > 0 ? +(sumOverall / totalFeedbacks).toFixed(1) : 0;
        const csatScore = totalFeedbacks > 0 ? Math.round((csatPositives / totalFeedbacks) * 100) : 0;

        const categoryBreakdown = tagCounts;

        const trends = Array.from(trendsMap.entries()).map(([date, data]) => ({
            date,
            reviews: data.count,
            average: +(data.ratingSum / data.count).toFixed(1)
        }));

        // Fetch service points to get table labels
        const servicePoints = await ServicePoint.find({ businessId }).lean();
        const spMap = new Map(servicePoints.map(sp => [sp.servicePointId, sp.label]));

        // Limit recent reviews to 20 for initial payload (pagination via query params could be added later)
        const recentReviews = feedbacks.slice(0, 20).map(f => ({
            ...f,
            servicePointLabel: spMap.get(f.servicePointId) || f.servicePointId
        }));

        return res.json({
            overview: {
                totalFeedbacks,
                averageRating,
                responseRate,
                csatScore,
                totalCompletedOrders
            },
            ratingDistribution,
            categoryBreakdown,
            trends: trends.reverse(), // Ensure chronological order if Map iterating backwards
            recentReviews
        });

    } catch (error) {
        console.error("[getOwnerFeedbackAnalytics error]", error);
        return res.status(500).json({ error: "Failed to fetch feedback analytics" });
    }
}
