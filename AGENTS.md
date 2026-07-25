# QuickServe Backend Agent Instructions

This repository contains the backend API and authoritative business logic for QuickServe.

QuickServe is a modular, multi-tenant hospitality operating platform.

## Architectural source of truth

Before planning or modifying backend code, read the canonical documentation:

- `../Quick-serve-qr-menu/.ai/approved/ARCHITECTURAL_CONSTITUTION.md`
- `../Quick-serve-qr-menu/.ai/approved/PRODUCT_PHILOSOPHY.md`
- `../Quick-serve-qr-menu/.ai/approved/ARCHITECTURAL_DECISIONS.md`
- `../Quick-serve-qr-menu/.ai/approved/ARCHITECTURAL_ANALYSIS.md`

These paths assume the frontend and backend repositories are sibling folders inside the same parent directory.

If these documents cannot be accessed, report that before making architectural changes.

## Backend responsibilities

The backend owns:

- authentication and authorization
- tenant isolation
- capability resolution
- authoritative pricing
- taxes, fees, commissions, and totals
- payment initiation and reconciliation
- Stripe webhook processing
- order and reservation state transitions
- database validation and persistence
- real-time event publication
- transaction aggregation
- guest-profile aggregation

## Mandatory rules

- Every tenant-owned query and mutation must be scoped by `businessId`.
- Never trust a client-provided `businessId` without verifying it against authenticated or validated context.
- Never trust client-calculated prices, taxes, fees, commissions, or totals.
- Monetary values must be stored and calculated using integer cents.
- Backend authorization must protect every restricted action.
- Frontend visibility or route protection is not authorization.
- Preserve `ServicePoint` as the canonical physical-resource abstraction.
- Do not introduce separate Room, Table, Booth, or Cabana persistence models.
- Business type defines identity; modules add capabilities.
- Guests never authenticate.
- Guest interactions must contribute to the unified guest profile.
- All payable modules must contribute to the unified Transactions view.
- Stripe is a payment processor, not the internal source of truth.
- Webhook processing must be verified and idempotent.
- Reuse existing services, middleware, validation, and event infrastructure.
- Do not create parallel pricing, payment, authentication, guest, reservation, or transaction systems.

## Before changing code

1. Inspect the existing route, controller, service, schema, middleware, and tests.
2. Identify whether existing abstractions can support the requested change.
3. Check tenant isolation and role authorization.
4. Check whether financial or payment behavior is affected.
5. Present a plan before making broad architectural changes.

## After changing code

- Run relevant tests.
- Run type checking and linting where available.
- Verify authorization and tenant isolation.
- Verify financial calculations where applicable.
- Summarize changed files.
- Report unresolved risks or architectural conflicts.

Do not modify files under the canonical `.ai/approved/` directory unless the user explicitly requests a documentation change.