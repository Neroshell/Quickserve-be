Chillow Backend — Agent Instructions & Business/Venue Architecture
Version: 1.1 (consolidated)
Updated: 24 October 2026
Applies to: The Chillow backend API, its domain logic, and architectural changes affecting chillow-app and chillow-web.
Status: Part A contains current backend engineering rules; Part B describes the approved target direction, not a completed migration.
For agents: Read this entire file before modifying business onboarding, venue identity, operational modules, business capabilities, reservation and ServicePoint logic, or Discovery eligibility. First verify the actual repository state. A proposed architecture is never evidence that its schema, API, entity, or workflow exists today.

Part A — Backend Agent Instructions (Existing Rules Preserved)
A1. Repository purpose and terminology
This repository contains the backend API and authoritative business logic for the hospitality platform historically named QuickServe, now evolving as Chillow — The Connected Hospitality Ecosystem. Historical repository names, paths, database fields, API contracts, and integrations may still use QuickServe identifiers. Do not rename or remove them merely because of the brand migration.

The backend is a modular, multi-tenant hospitality operating platform. It remains authoritative for business operations, security, financial decisions, and persistence.
A2. Architectural source of truth
Before planning or modifying backend architecture, read the existing canonical documents when available:
- ../chillow-app/.ai/approved/ARCHITECTURAL_CONSTITUTION.md
- ../chillow-app/.ai/approved/PRODUCT_PHILOSOPHY.md
- ../chillow-app/.ai/approved/ARCHITECTURAL_DECISIONS.md
- ../chillow-app/.ai/approved/ARCHITECTURAL_ANALYSIS.md
These paths assume the legacy frontend and backend repositories are sibling directories. They may differ after the Chillow repository migration. Check actual locations; do not pretend documents were read if unavailable. Report missing documents before making broad architectural changes.

Do not modify files inside the canonical .ai/approved/ directory unless the user explicitly asks for a documentation change.

Authority and conflict handling: Existing production invariants, security requirements, and verified deployed contracts take precedence over proposed future models. If older approved documents conflict with this newly approved onboarding/venue direction, identify the exact conflict and request an architectural resolution before a breaking implementation; do not silently choose one. The rules in Part A remain in force until an explicitly approved migration supersedes them.
A3. Backend responsibilities
The backend owns:
- Authentication and authorization
- Tenant isolation
- Capability and module resolution
- Authoritative prices, taxes, fees, commissions, and totals
- Payment initiation, confirmation, and reconciliation
- Stripe webhook processing
- Order and reservation state transitions
- Database validation and persistence
- Real-time event publication
- Transaction aggregation
- Unified guest-profile aggregation
- Authoritative Discovery publication and reservation/booking eligibility
Clients may present forms and preferences, but cannot become the source of truth for those decisions.
A4. Mandatory engineering and domain rules
1. Tenant isolation: Every tenant-owned query and mutation must be scoped by the verified current businessId boundary. Never trust client-provided businessId without matching it to authenticated or otherwise validated context. A future organization/venue model must define and enforce an equally strong or stronger tenancy boundary before migration.
2. Backend authorization: Protect every restricted action on the backend. Frontend visibility, route guards, and client-side checks are not authorization.
3. Money: Never trust client-calculated prices, taxes, fees, commissions, or totals. Store and calculate monetary values in integer minor units (cents for applicable currencies) using the established financial conventions.
4. Payments: Stripe is the payment processor, not the internal source of truth. Verify webhooks, process them idempotently, and preserve reconciliation invariants.
5. Unified transactions: Every payable operational module must contribute to the established Transactions view/ledger through approved integration paths.
6. ServicePoints: Preserve ServicePoint as the current canonical physical service/resource abstraction. Do not introduce separate Room, Table, Booth, or Cabana persistence models. Future conceptual resource/availability models must not bypass this rule without a separately approved migration.
7. Guest access: Preserve the existing guest-access model without mandatory guest authentication. Do not add guest sign-in requirements to QR, menu, service, and current guest flows without explicit product approval.
8. Guest profiles: Guest interactions must contribute to the established unified guest profile using the approved guest-identity/privacy model.
9. Reuse: Reuse current services, middleware, validation, payment infrastructure, events, and domain logic. Do not create parallel pricing, payment, authentication, guest, reservation, or transaction systems.
10. Business identity: A venue/business classification describes identity; operational modules and effective capabilities determine supported functionality. A business label is never an authorization rule.
11. Operations safety: Do not alter live orders, reservations, bookings, guest information, payments, or inventory while testing. Use isolated sandbox data or safe read-only checks.
12. Visibility: A published listing is not automatically bookable. Confirm supported capability, configuration, publication and availability as separate concerns.
A5. Before editing code
1. Inspect current routes, controllers, services, schemas, middleware, and tests.
2. Read git status, inspect user modifications, and identify actual branches and environments.
3. Identify the closest existing abstraction and any legacy assumptions being relied upon.
4. Review tenant isolation, role authorization, and the impact on existing clients.
5. Check whether financial, payment, reservation, QR, or publication behavior may be affected.
6. For broad architectural changes, present a scoped plan, compatibility strategy, tests, and migration/rollback implications before editing.
A6. After editing code
- Run relevant automated tests.
- Run type checks, linting and builds where available.
- Verify authorization, tenant isolation, and API compatibility.
- Verify money/fee calculations and idempotency where applicable.
- Test legacy restaurant, bar, and hotel workflows whenever affected.
- Summarize changed files, validation performed, and unresolved risks.
- Do not commit, push, merge, deploy, or run destructive migrations without authorization.
Part B — Chillow Business & Venue Architecture
B1. Status, mission, and scope
Status: Approved Target Direction — Incremental Implementation Required

Chillow is a connected hospitality technology ecosystem with two interconnected experiences:
- Chillow Discovery: Guests discover hospitality venues and supported offerings, explore locations, and continue into valid booking or service flows.
- Chillow Operations: Businesses manage orders, menus, reservations, accommodation, housekeeping, staff, inventory, payments, guest services, analytics, and administration.
Mission: Make hospitality easier to receive and easier to deliver.
Consumer tagline: Find somewhere worth going.

Distinguish three states in every proposal:
- Current: Implemented and verified in the working checkout.
- Target: Agreed architecture, not yet necessarily implemented.
- Future: Unimplemented capabilities needing further product/engineering approval.
The aim is one capability-driven platform, not separate Restaurant, Café, Bar, Hotel, Resort, etc. applications.
B2. Core rule — separate identity from operation
A venue type describes what kind of place it is. An operational module provides what it can operate. Module configuration governs how those workflows behave. Effective capabilities, entitlements, permissions, and operational eligibility govern what it can actually use. Published offerings determine what guests may discover or book.

Restaurants, cafés, coffee shops, bars, lounges, and compatible bakeries largely share Food Service workflows. Hotels, resorts, guesthouses, aparthotels, hostels, and compatible accommodation largely share Lodging workflows. They do not require one newly built backend or dashboard per venue label.

A new type is not automatically an excuse to add a new module. Conversely, genuinely different workflows (e.g., spa appointments vs. dining tables) must not be forced into existing engines merely to maximize reuse.
B3. Five target architectural layers
1 — Organization (future separation)
The person, company, or group that owns/manages one or more venues; handles organization-level ownership, membership, billing, access, and eventually consolidated reporting.

A small operator may manage one venue; a hospitality group may manage many. Today's Business document may conflate organization, location, and operating business responsibilities. Do not create or migrate an Organization collection as part of a venue-type/onboarding update.
2 — Venue (target entity/concept)
A location, property, or independently managed outlet, with a descriptive venueType (e.g., cafe, restaurant, resort). A venue may have an address, business profile, branding, hours, staff, modules, ServicePoints, and publication settings.

The current Business is the transitional persistence boundary; a separate Venue model is not assumed to exist.
3 — Operational modules
Reusable operational engines assigned based on actual support and validated rules. Initial implemented foundations in the legacy platform:

foodService: Menus, QR/table and other supported ordering channels, food and drink preparation, kitchen/bar fulfilment, waitstaff, inventory, service requests, payments, dining/time-slot reservations, and reporting as implemented.

lodging: Room types/rooms, stay availability, accommodation bookings, check-in and checkout workflows as supported, housekeeping, guest services, payments, and lodging analytics.

Shared platform services: Authentication/authorization, payments, billing, staff, notifications, CRM, reporting, and reusable financial/guest infrastructure.

Future examples: Leisure/appointment workflows for spa/wellness and activities, only after their requirements and booking engine are implemented and approved.

One venue may have multiple modules when supported, such as a resort with lodging plus food service. Module enablement never overrides plan entitlements, business setup, or permissions.
4 — Offerings, resources, and ServicePoints
Offering (future concept): A service guests consume or book, such as a stay, dining reservation, or eventually a leisure appointment.

Resource (conceptual): Capacity allocated by an offering, such as a room-night, table/time slot, or future appointment resource. Different offerings can have different eligibility and availability algorithms.

ServicePoint (implemented): Chillow's canonical service/physical-resource abstraction for existing workflows and QR guest interactions. Examples include Table 7, Booth 3, Room 204, or a supported labelled service location. Not every ServicePoint is reservable, and QR access does not imply booking.

Compatibility constraint: Do not introduce competing Room/Table/Booth/Cabana persistence models, rewrite existing ServicePoint IDs, or break QR, sessions, orders or reservations. Generalized Offering/Resource models remain proposals requiring separate review.
5 — Chillow Discovery
Three consumer intent modes (not persistent venue types):
- Find a stay: Eligible published accommodation venues/offerings.
- Go out: Eligible published dining, drinks, and supported non-accommodation hospitality/leisure venues/offerings.
- Chill: Every eligible published Chillow venue/offering across supported classifications. Default active tab.
Published venue ≠ available/eligible booking. The backend must enforce publication, profile completeness, capability and bookability checks. Preserve operations booking handoffs.
B4. Venue taxonomy and controlled catalog
Maintain an explicit, versionable venue-type catalog. A group helps people choose; the specific venueType is the descriptive value. These labels and defaults are proposed until supported by the deployed backend.
Onboarding group	Example venueType	Default foundation	Notes
Food & Drinks	restaurant	foodService	Existing legacy business type
Food & Drinks	cafe	foodService	New descriptive type; compatible with legacy restaurant workflows
Food & Drinks	bar_lounge	foodService	Existing legacy business type
Food & Drinks	bakery	foodService if operationally compatible	Verify supported workflows
Accommodation	hotel	lodging	Existing legacy business type
Accommodation	resort	lodging	Food Service optional when supported
Accommodation	aparthotel	lodging	Preserve existing accommodation subtype data
Accommodation	guest_house	lodging	Preserve existing accommodation subtype data
Accommodation	hostel, villa	lodging when supported	Confirm inventory/booking model
Leisure & Experiences	beach_club, pool_club, spa	None by default until validated	May require distinct operational capabilities


These are illustrative, not an instruction to activate every listed type. The backend catalog should distinguish supported self-service types, types awaiting capability support, and types ineligible for onboarding. Do not let unsupported options complete onboarding with a misleading restaurant dashboard.

A new classification must explicitly define legacy compatibility, permitted/default modules, setup prerequisites, relevant profile fields, and Discovery eligibility. Avoid unknown-type fallback.
B5. Data model — venueType, modules, configuration
Terms
- venueType: Human/business classification, e.g., cafe or resort.
- modules: Authorized operational foundations, e.g., foodService, lodging.
- configuration: Supported settings within a module; do not treat this as a requirement to add a single unvalidated root configuration object to today's schema.
Conceptual café:
{
  "venueType": "cafe",
  "modules": ["foodService"],
  "configuration": {
    "orderChannels": ["dine_in", "takeaway"],
    "fulfillmentStations": ["bar", "kitchen"],
    "reservationsEnabled": false
  }
}
Conceptual resort:
{
  "venueType": "resort",
  "modules": ["lodging", "foodService"],
  "configuration": {
    "stayBookingsEnabled": true,
    "diningReservationsEnabled": true
  }
}
These are architectural examples, not implemented MongoDB schemas, accepted registration payloads, or guarantees that all options exist today. Use the current authoritative settings structures until a specific migration is approved.
Existing legacy businessType
In the inherited backend, Business.businessType is restricted to restaurant, bar_lounge, or hotel and remains embedded in navigation, reservation and profile decisions. It must remain during transition.

Compatible examples, after backend support is implemented:
{ "businessType": "restaurant", "venueType": "cafe", "modules": ["foodService"] }
{ "businessType": "hotel", "venueType": "resort", "modules": ["lodging"] }
venueType gradually replaces the descriptive role of businessType; modules and capability resolution replace the operational assumptions. Retire the old field only following an approved, fully tested migration across all callers.

Legacy type collision: Accommodation-specific propertyProfile.accommodationType already exists in the inherited codebase. Design explicit precedence/backfill rules so a venueType such as resort cannot contradict businessType: hotel and accommodationType: hotel. Do not erase existing profile detail.
B6. Approved onboarding decision — keep all six stages
THIS SECTION SUPERSEDES THE OLD ONBOARDING PROPOSAL THAT IMPLIED ADDING SEPARATE OPERATIONAL QUESTIONNAIRES OR SETUP STEPS.

The existing onboarding sequence stays exactly:
1. Create Account — unchanged
2. Verify Email — unchanged
3. Business Identity — only step in scope for venue-type selection redesign
4. Location — unchanged
5. Choose Plan — unchanged
6. Complete — unchanged
Do not insert, reorder, remove, merge, or reimplement onboarding stages during venue classification work. Do not change email verification, credentials, plans, payments, or completion behavior for this task.
B6.1 Business Identity — change only the classification selection
Replace the three hardcoded visible choices (Restaurant, Bar & Lounge, Hotel / Apartment) with a grouped, backend-supported venue-type selector.

Suggested prompt: “What kind of business do you operate?”
Supporting copy: “Choose the type that best describes your venue. Chillow will tailor your workspace to your business.”

Groups are for navigation only:
- Accommodation: supported hotels, resorts, aparthotels, guesthouses, etc.
- Food & Drinks: supported restaurants, cafés/coffee shops, bars/lounges, bakeries, etc.
- Leisure & Experiences: show as self-service options only when real supported operational capability exists.
The chosen supported venue type is sent through an explicitly validated onboarding contract. The backend resolves compatible legacy businessType and supported default modules. Do not trust frontend-provided module selection or enable unsupported capabilities.

Retain all other Business Identity fields and behaviors:
- Business Name
- Display Name
- Business URL / Slug
- Contact Email
- Phone Number
- Existing validation, error reporting, step persistence, back/continue transitions, and slug checks
Correct visible legacy QuickServe branding to Chillow when appropriate without silently changing persisted business identifiers or legacy public URL contracts.
B6.2 No extra operational questions during sign-up
Do not add mandatory onboarding questions/stages for dine-in/takeaway, kitchen/bar stations, reservations, rooms, housekeeping, ServicePoints, inventory, or module toggles.

Assign safe, validated module defaults. Complete detailed operational configuration through existing post-onboarding setup and business settings. A business owner should not need to know what foodService or lodging means during registration.
B6.3 Unsupported venue types
Do not let a new venue type silently fall back to restaurant behavior. Either exclude the type from self-service activation or provide a separately approved expression-of-interest/review workflow that makes no operational promises. Validate on the server regardless of visible frontend options.
B7. Post-onboarding operations and effective capabilities
After registration, guide the owner through the existing relevant setup tasks:
- Café/restaurant/bar: menu, order and fulfilment settings, service locations, reservations where enabled, inventory, staff.
- Hotel/guesthouse: room types and accommodation resources, stay reservations, housekeeping, staff.
- Resort: lodging first, with optional supported Food Service capabilities configured later.
The UI should increasingly use resolved effective capabilities, not direct checks such as businessType === 'hotel', to choose navigation and workflows. Effective access must account for:
1. Assigned/supported operational module
2. Subscription/plan entitlements
3. Venue configuration and setup prerequisites
4. Reservation/payment eligibility
5. Staff role and resource-specific permissions
An assigned module is not a blanket grant of every feature. Backend enforcement remains authoritative. Hybrid Food Service + Lodging workspaces should use one coherent navigation model when actually supported.
B8. Discovery integration and truthful booking actions
Integrate the new venueType taxonomy with Find a stay, Go out, and Chill only after backend support exists and the real API contract has been validated.
- Find a stay includes supported published accommodation listings; filters by actual stay offerings. Search dates are preferences until authoritative availability is checked.
- Go out includes supported published food/drink and leisure listings. Dates, times, party size and ServicePoints do not imply a confirmed reservation.
- Chill returns all eligible published businesses/offerings using one authoritative properly paginated search; do not merge independently paginated frontend result sets and misrepresent ordering/pagination.
Preserve public Discovery publication visibility rules, verified destination/location search, business details, and secure handoffs to Operations. A published venue might have View place instead of Reserve if reservation capabilities are unavailable. Do not invent room rates, reservation slots, prices, reviews, or business availability.

During migration, existing category=eat|drink|stay queries and old links must continue to work unless an explicitly approved versioned deprecation takes place.
B9. Multi-venue organizations and outlets — future, not onboarding scope
Example future structure:
- Organization: Azure Hospitality Group
- Venue/property: Azure Bay Resort — Lodging
- Outlet: Azure Restaurant — Food Service
- Outlet: Azure Rooftop Lounge — Food Service
A venue or outlet may eventually have its own staff permissions, hours, menus, operational data and published Discovery identity, with organization-level ownership and reporting.

This is not an authorization to create Organization, Venue, Outlet, Offering, generalized Resource, Room or Table collections now. Multi-venue architecture requires a separate domain model, tenant-isolation design, financial/billing ownership strategy, migration path, and explicit approval.
B10. Technical scaling strategy
Keep the modular monolith (existing Node.js/Express backend, MongoDB, Redis, BullMQ and other approved integrations). Enforce well-defined domain boundaries and reuse common services. Microservices should follow genuine independent scaling, isolation or deployment needs—not a new marketing venue type.

Before any schema rollout or migration, plan for:
- Existing and future tenant scope
- Backward-compatible APIs and serialized DTOs
- Legacy businessType dependencies and fallback behavior
- Existing propertyProfile.accommodationType values
- Validated module defaults and unsupported type handling
- Reservation and room availability correctness
- Existing ServicePoint IDs, QR capabilities, sessions and guest access
- Public Discovery publication requirements
- Financial/payment/transaction ledger integrity
- Tests, operational observability, feature rollout and rollback
B11. Implementation phases (separately approved)
Phase 1 — Contract/design: Audit Business, capability resolver, onboarding controller/session, frontend Business Identity, property profiles, and Discovery. Finalize venue catalog, legacy compatibility mapping, module defaults, permitted configurations, and validation. No migration in this phase.

Phase 2 — Backend additive foundation: Add backend-validated venueType, controlled mappings, explicit unknown-type rejection, compatible DTOs, and regression tests. Retain businessType. Plan safe backfill of existing businesses; no destructive migration.

Phase 3 — Business Identity UI only: Replace the three choice cards in the current Business Identity stage. Keep every other onboarding step and its behavior unchanged.

Phase 4 — Capability-driven Operations: Progressively update navigation/setup/feature guards to read effective capabilities, with backend authorization and existing workflows preserved.

Phase 5 — Discovery integration: Connect the three guest search modes to accurate venue classification, publication eligibility and supported offerings. Maintain legacy API compatibility.

Phase 6 — Optional multi-venue evolution: Design and implement organization/venue/outlet management only when separately approved.

The independent visual redesign of chillow-web may proceed before these backend phases if it honestly handles missing API capabilities.
B12. Mandatory implementation rules for agents
- Check what currently exists before referring to a target model as implemented.
- Do not change the six-stage onboarding sequence; only Business Identity is initially changing.
- Do not make onboarding a mandatory questionnaire about operational workflows.
- Do not remove or rename legacy businessType before approved migration.
- Do not infer permissions from venue type, hide-only frontend checks, or raw module flags.
- Do not silently map unsupported venueType values to restaurant.
- Do not enable unsupported leisure/spa/appointment functionality.
- Do not create an operational engine or independent dashboard for each new venue classification.
- Do not create parallel payment, booking, guest, resource or reservation systems.
- Preserve ServicePoint as the present canonical physical-resource model and preserve existing codes/identifiers.
- Preserve data isolation, financial invariants, webhook idempotency, public listing eligibility and booking truthfulness.
- Keep chillow-app, backend, and chillow-web API contracts and rollout order consistent.
- Do not modify real production data or deploy breaking changes without approval.
- Report conflicts between canonical architectural documents and proposed models instead of silently resolving them in code.
B13. Final guiding principles
An Organization owns or manages venues.
A Venue represents a place or independently operated outlet.
venueType describes what the place is.
Operational modules supply reusable systems.
Module configuration determines their behavior.
Effective capabilities, entitlements, and permissions determine actual access.
Offerings describe what guests can discover/consume/book.
ServicePoints remain the current canonical physical service-resource abstraction.
Discovery presents Find a stay, Go out, and Chill (default) without misrepresenting bookability.

Build operational systems once. Configure them for different hospitality businesses. Connect them through Chillow.