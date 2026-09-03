export const QUEUE_NAMES = Object.freeze({
    DIAGNOSTIC: "diagnostic",
    EMAIL: "email",
    RESERVATIONS: "reservations",
    BILLING: "billing",
    POST_PAYMENT: "post-payment",
    AI_ANALYST: "ai-analyst",
});

export const DIAGNOSTIC_JOB_NAME = "diagnostic-ping";

export const EMAIL_JOB_NAMES = Object.freeze({
    RESERVATION_REQUEST_OWNER: "reservation-request-owner",
    RESERVATION_REQUEST_GUEST: "reservation-request-guest",
    RESTAURANT_RESERVATION_CONFIRMED: "restaurant-reservation-confirmed",
    RESTAURANT_RESERVATION_CANCELLED: "restaurant-reservation-cancelled",
    RESERVATION_ARRIVAL_REMINDER: "reservation-arrival-reminder",
    ORDER_RECEIPT: "order-receipt",
    REFUND_CONFIRMATION: "refund-confirmation",
    BILLING_UPCOMING_INVOICE: "billing-email-upcoming-invoice",
    BILLING_PAYMENT_SUCCESS: "billing-email-payment-success",
    BILLING_OVERDUE_DAY_3: "billing-email-overdue-day-3",
    BILLING_OVERDUE_DAY_5: "billing-email-overdue-day-5",
    BILLING_OFFLINE_RESTRICTED: "billing-email-offline-restricted",
    BILLING_SERVICE_RESTORED: "billing-email-service-restored",
});

export const RESERVATION_JOB_NAMES = Object.freeze({
    EXPIRY_REPAIR_SCAN: "reservation-expiry-repair-scan",
    EXPIRE_PAYMENT_WINDOW: "reservation-expire-payment-window",
});

export const BILLING_JOB_NAMES = Object.freeze({
    LIFECYCLE_SCAN: "billing-lifecycle-scan",
    UPCOMING_INVOICE: "billing-upcoming-invoice",
    OVERDUE_WARNING_DAY_3: "billing-overdue-warning-day-3",
    OVERDUE_WARNING_DAY_5: "billing-overdue-warning-day-5",
    RESTRICT_SERVICE: "billing-restrict-service",
    RESTORE_SERVICE: "billing-restore-service",
});

export const POST_PAYMENT_JOB_NAMES = Object.freeze({
    CRM_ORDER: "crm-order",
    CRM_ORDER_REPAIR_SCAN: "crm-order-repair-scan",
});

export const AI_ANALYST_JOB_NAMES = Object.freeze({
    WEEKLY_SCAN: "ai-analyst-weekly-scan",
    GENERATE_REPORT: "ai-analyst-generate-report",
});
