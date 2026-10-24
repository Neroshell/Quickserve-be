# Chillow — Business & Venue Architecture

## Status: Proposed Target Architecture
**Version:** 1.1  
**Updated:** 24 October 2026  
**Scope:** Chillow Operations, Business Onboarding, Backend Architecture, and Chillow Discovery

---

# 1. Purpose of This Document

This document defines Chillow's proposed long-term business and venue architecture.

It serves as architectural knowledge for developers, AI coding agents, and future contributors working across the Chillow ecosystem.

The objective is to create a scalable hospitality platform that can support many types of businesses without developing separate operational systems for every business category.

**Important distinction:**

- **Current architecture:** Functionality and structures that already exist in Chillow.
- **Target architecture:** The architectural direction we have agreed to adopt.
- **Future capabilities:** Functionality that requires further design and implementation.

Agents must never assume that a proposed entity, database field, API, module, or workflow has already been implemented.

Implementation must be incremental, backward-compatible, and based on the actual codebase.

---

# 2. What Chillow Is

**Chillow — The Connected Hospitality Ecosystem**

Chillow is a unified hospitality technology platform connecting hospitality businesses, guests, operational workflows, and discovery experiences.

Its mission is:

**Make hospitality easier to receive and easier to deliver.**

Chillow serves two interconnected audiences.

### Chillow Discovery — Consumer Experience

A guest-facing platform for:

- Discovering hospitality businesses
- Exploring restaurants, bars, cafés, hotels, resorts, and other supported venues
- Finding destinations
- Viewing business profiles, facilities, menus, and offerings
- Exploring reservation and accommodation options
- Continuing into supported booking or service experiences

### Chillow Operations — Business Experience

A business-facing platform for:

- Managing hospitality operations
- Orders and fulfilment
- Menus
- Dining reservations
- Accommodation bookings
- Guest services
- Housekeeping
- Inventory
- Staff
- Payments
- Customer relationships
- Reporting and analytics
- Business administration

Both experiences are connected through a shared backend ecosystem.

The platform must support multiple hospitality verticals without unnecessarily duplicating operational functionality.

---

# 3. Core Architectural Philosophy

## Business Identity Must Be Separate From Operational Functionality

The fundamental principle is:

**What a business is must not be confused with how that business operates.**

Consider the following businesses:

- Restaurant
- Café
- Coffee shop
- Bar
- Lounge
- Bakery

Although they have different identities, they often share operational workflows.

Guests may:

1. View a menu.
2. Select food or drinks.
3. Place an order.
4. Pay for the order.
5. Have it fulfilled by a kitchen or bar.
6. Receive the order at a service location.
7. Request assistance.
8. Leave feedback.

These businesses should therefore reuse the same configurable **Food Service operational module**.

Similarly:

- Hotels
- Resorts
- Guesthouses
- Aparthotels
- Serviced apartments
- Hostels

Share accommodation workflows such as room management, stay availability, reservations, check-in, checkout, and housekeeping.

These businesses should reuse the **Lodging operational module**.

### Architectural Rule

**A new venue type does not automatically require a new operational module or a separate dashboard application.**

Operational modules represent reusable hospitality functionality.

Venue types describe the businesses using those modules.

---

# 4. The Five-Layer Target Architecture

Chillow's target architecture consists of five conceptual layers.

## Layer 1 — Organization

An Organization represents the person, company, or hospitality group responsible for operating one or more venues.

It provides the organizational boundary for:

- Ownership
- Account management
- Billing and subscriptions
- Staff membership
- Access management
- Multi-venue administration
- Consolidated reporting, where supported

Examples:

**Small operator**

One organization operates one café.

**Hospitality company**

One organization operates several restaurants.

**Resort group**

One organization operates multiple properties and their associated outlets.

### Current Implementation

The existing Business model combines several organization-level and venue-level responsibilities.

Organization is part of the target architecture, not an instruction to immediately create a new collection or replace the existing Business model.

The separation must occur through an approved migration.

---

## Layer 2 — Venue

A Venue represents a hospitality business location, property, or independently managed outlet.

Examples:

- Restaurant
- Café
- Bar
- Hotel
- Resort
- Guesthouse
- Beach club

A venue may contain:

- Business identity
- Address and geographic location
- Contact information
- Operating hours
- Branding
- Public business profile
- Operational modules
- Staff assignments
- ServicePoints
- Reservations
- Guest-facing offerings
- Discovery publication settings

### The `venueType` Field

`venueType` describes what kind of venue the business operates.

Examples:

```ts
type VenueType =
  | "restaurant"
  | "cafe"
  | "bar_lounge"
  | "bakery"
  | "hotel"
  | "resort"
  | "aparthotel"
  | "guest_house";
```

This is an illustrative initial catalog, not an exhaustive or already-implemented schema.

Additional venue types must be introduced through a validated, centrally managed catalog.

The selected venue type must not independently determine every operational feature.

**Venue Type describes the business. Operational modules provide functionality.**

### Single-Venue and Multi-Venue Support

A small operator may manage one venue.

A hospitality organization may eventually manage multiple venues.

The architecture should anticipate both models without requiring multi-venue complexity during ordinary onboarding.

---

## Layer 3 — Operational Modules

Operational modules provide reusable business functionality.

Chillow should be built around these modules rather than separate applications for every venue type.

### 3.1 Food Service Module

**Module identifier:** `foodService`

Purpose: Support the operations of businesses serving food and drinks.

Applicable venue types may include:

- Restaurants
- Cafés
- Coffee shops
- Bars
- Lounges
- Bakeries
- Hotel restaurants
- Resort bars
- Other compatible hospitality venues

The module provides applicable workflows including:

- Digital menus
- QR ordering
- Guest orders
- Dine-in service
- Takeaway, where supported
- Kitchen preparation
- Bar fulfilment
- Waitstaff operations
- Service requests
- Inventory
- Payments
- Dining reservations
- Guest feedback
- Analytics

Different venues may configure these capabilities differently.

For example:

A café may enable dine-in and takeaway.

A bar may primarily use bar fulfilment.

A restaurant may use kitchen preparation, waiter service, and reservations.

**These differences should be handled through configuration, not separate operational engines.**

### 3.2 Lodging Module

**Module identifier:** `lodging`

Purpose: Support accommodation operations.

Applicable venue types may include:

- Hotels
- Resorts
- Aparthotels
- Serviced apartments
- Guesthouses
- Hostels
- Villas, where supported

The module provides applicable workflows including:

- Room types
- Accommodation inventory
- Room availability
- Stay reservations
- Booking management
- Check-in
- Checkout
- Housekeeping
- Guest services
- Room supplies
- Payments
- Accommodation analytics

A hotel and a resort may share the same lodging engine even though their guest-facing identities differ.

### 3.3 Future Operational Modules

Chillow may introduce new operational modules when genuine workflow differences justify them.

For example:

**Leisure Services**

Potential future workflows:

- Spa appointments
- Wellness treatments
- Time-based leisure reservations
- Staff/resource scheduling
- Activity bookings

This module is not considered implemented until its underlying operational functionality exists.

### 3.4 Shared Platform Services

Some capabilities serve multiple operational modules.

Examples:

- Authentication
- Authorization
- Staff management
- Payments
- Billing
- Notifications
- CRM
- Reporting
- Analytics

These should remain reusable shared services rather than being unnecessarily duplicated for each module.

---

## Layer 4 — Offerings, Resources, and ServicePoints

Operational modules manage business activities.

Guests interact with the services and experiences that businesses offer.

### Offerings

An Offering represents a discoverable or consumable hospitality service.

Examples:

- Accommodation stays
- Dining reservations
- Food and drink ordering
- Future leisure appointments

Offerings are a target architectural concept.

Do not assume the current implementation already includes a generalized Offering model.

### Resources

Resources represent allocatable inventory or capacity used to deliver a service.

Examples:

- Hotel rooms
- Restaurant tables
- Booths
- Future appointment resources

Different resources can require different availability algorithms.

Room-night booking and restaurant time-slot booking must not be forced into identical allocation logic.

### ServicePoints

Chillow already has a ServicePoint system.

ServicePoints represent guest interaction or service locations.

Examples:

- Table 5
- Room 204
- Booth 3
- VIP Lounge
- Other supported service locations

ServicePoints may support:

- QR access
- Guest sessions
- Digital ordering
- Service requests
- Reservations, where explicitly supported

**A ServicePoint is not automatically a reservable resource.**

The platform must respect whether the ServicePoint and its relevant service are eligible for reservations.

Future resource abstractions must preserve existing ServicePoint IDs, QR codes, orders, reservations, and guest sessions.

---

## Layer 5 — Chillow Discovery

Chillow Discovery connects guests to eligible published hospitality venues and offerings.

The approved primary Discovery modes are:

### Find a stay

For accommodation-related Discovery.

Examples:

- Hotels
- Resorts
- Guesthouses
- Serviced apartments
- Other supported accommodation venues

### Go out

For dining, drinks, social and supported non-accommodation leisure experiences.

Examples:

- Restaurants
- Cafés
- Bars
- Lounges
- Other compatible supported venues

### Chill

The universal Discovery mode.

Chill includes all eligible published Chillow venues and offerings across supported business categories.

**Chill is the default search mode.**

### Important Rules

Find a stay, Go out, and Chill are **consumer discovery modes**, not operational modules or database venue types.

A venue's visibility is determined by publication eligibility and supported offerings.

For example, a resort may be discoverable as accommodation.

Its independently published restaurant may eventually appear under Go out.

Both can be represented within Chill.

This requires appropriate venue/offering publication support and must not be assumed functional before implementation.

---

# 5. Proposed Data Structure

The target architecture separates three primary concepts.

### `venueType`

Describes the business classification.

### `modules`

Identifies the operational systems assigned to the venue.

### `configuration`

Defines how each supported module operates.

### Example — Café

```json
{
  "venueType": "cafe",
  "modules": ["foodService"],
  "configuration": {
    "orderChannels": ["dine_in", "takeaway"],
    "fulfillmentStations": ["bar", "kitchen"],
    "reservationsEnabled": false
  }
}
```

### Example — Bar

```json
{
  "venueType": "bar_lounge",
  "modules": ["foodService"],
  "configuration": {
    "orderChannels": ["dine_in"],
    "fulfillmentStations": ["bar"],
    "reservationsEnabled": true
  }
}
```

### Example — Hotel

```json
{
  "venueType": "hotel",
  "modules": ["lodging"],
  "configuration": {
    "stayBookingsEnabled": true
  }
}
```

### Example — Resort

```json
{
  "venueType": "resort",
  "modules": ["lodging", "foodService"],
  "configuration": {
    "stayBookingsEnabled": true,
    "diningReservationsEnabled": true
  }
}
```

These are conceptual examples.

They do not represent finalized MongoDB schemas or currently supported API payloads.

The eventual implementation should provide explicit module-specific configuration, server-side validation, permissions, and subscription entitlement checks.

---

# 6. Migration From `businessType` to `venueType`

## Current Architecture

The current backend recognizes three canonical `businessType` values:

- `restaurant`
- `bar_lounge`
- `hotel`

These values influence:

- Business onboarding
- Default modules
- Dashboard selection
- Business profiles
- Reservation behavior
- ServicePoint defaults
- Discovery filtering
- Other existing operational workflows

Removing or changing this field immediately would risk breaking functionality.

## Target Architecture

`venueType` becomes the primary descriptive classification.

`modules` determines which operational foundations the venue uses.

Module configuration determines supported workflow behavior.

### Transitional Example — Café

```json
{
  "businessType": "restaurant",
  "venueType": "cafe",
  "modules": ["foodService"]
}
```

Here:

- `businessType` remains for compatibility.
- `venueType` identifies the actual venue.
- `modules` identifies the operational foundation.

### Transitional Example — Resort

```json
{
  "businessType": "hotel",
  "venueType": "resort",
  "modules": ["lodging"]
}
```

Food Service can be added separately if supported and enabled.

### Migration Rules

1. Introduce a validated `venueType` field without immediately removing `businessType`.
2. Preserve existing business records and identifiers.
3. Define an explicit compatibility mapping for supported venue types.
4. Preserve historical operational behavior.
5. Avoid changing existing booking, order, payment, or ServicePoint contracts unnecessarily.
6. Reject unsupported classifications rather than silently treating them as restaurants.
7. Backfill existing records only through a tested migration plan.
8. Avoid conflicting classifications across `venueType`, legacy `businessType`, and existing property-profile subtypes.
9. Migrate code dependencies progressively.
10. Retire `businessType` only when all dependent functionality has been updated and verified.

**Do not remove `businessType` as part of an unrelated frontend or onboarding task.**

---

# 7. Business Onboarding Architecture

## Approved Decision: Preserve the Existing Onboarding Journey

Chillow's existing onboarding process must remain intact.

We are **not redesigning the entire onboarding system**.

The existing six stages are:

1. Create Account
2. Verify Email
3. Business Identity
4. Location
5. Choose Plan
6. Complete

This sequence remains unchanged.

Do not introduce additional onboarding stages for venue classification, operational modules, or advanced configuration.

Do not modify existing account creation, email verification, location collection, subscription selection, or onboarding completion behavior as part of the venue classification redesign.

## 7.1 Business Identity Is the Only Onboarding Step Being Updated

The Business Identity step currently presents three business types:

- Restaurant
- Bar & Lounge
- Hotel / Apartment

These choices will be replaced by a more scalable venue classification interface.

### New Business Identity Selector

Prompt:

**What kind of business do you operate?**

Supporting description:

"Choose the type that best describes your venue. Chillow will tailor your workspace to your business."

The selectable venue types should be organized into intuitive groups.

**Accommodation**

Potential types:

- Hotel
- Resort
- Aparthotel
- Guesthouse
- Hostel
- Villa
- Other supported accommodation types

**Food & Drinks**

Potential types:

- Restaurant
- Café / Coffee shop
- Bar & Lounge
- Bakery
- Other compatible supported food-service venues

**Leisure & Experiences**

Potential types:

- Beach club
- Pool club
- Spa & Wellness
- Other compatible leisure venues

The actual selectable list must be controlled by backend-supported classifications.

Unsupported venue types must not be activated for normal self-service onboarding.

### Important UI Distinction

The category groups exist to help users navigate the selection.

The selected `venueType` represents their classification.

Group labels are not necessarily persistent operational fields.

### Existing Business Identity Fields Must Remain

The following fields should be preserved:

- Business Name
- Display Name
- Business URL / Slug
- Contact Email
- Phone Number

Existing validation, slug behavior, contact information processing, form progress, and error handling must continue to function.

Legacy QuickServe branding in the onboarding UI should be updated to Chillow where appropriate, without prematurely changing existing public URL contracts or persisted identifiers.

## 7.2 Automatic Module Assignment

During onboarding, the selected venue type should determine sensible **default operational modules** through backend-controlled mappings.

Examples:

| Selected venue type | Default module |
|---|---|
| Restaurant | Food Service |
| Café | Food Service |
| Coffee shop | Food Service |
| Bar & Lounge | Food Service |
| Bakery | Food Service |
| Hotel | Lodging |
| Resort | Lodging |
| Guesthouse | Lodging |
| Aparthotel | Lodging |

These are proposed defaults subject to validation against supported implementations.

The backend—not the frontend—must resolve and validate the actual assigned modules.

For example:

A café selection could result in:

```json
{
  "businessType": "restaurant",
  "venueType": "cafe",
  "modules": ["foodService"]
}
```

A resort selection could result in:

```json
{
  "businessType": "hotel",
  "venueType": "resort",
  "modules": ["lodging"]
}
```

**The business owner should not have to manually select technical modules during registration.**

## 7.3 No Additional Operational Questionnaires During Initial Onboarding

The existing onboarding journey must remain simple.

Do not add mandatory registration stages asking operators to configure:

- Order channels
- Kitchen or bar stations
- Reservation policies
- Room types
- Housekeeping
- ServicePoints
- Detailed inventory workflows
- Additional operational modules

These configurations belong in the existing post-registration setup and business settings experiences, adapted where necessary.

The selected venue type should provide defaults and determine relevant setup guidance.

Advanced configuration can occur after onboarding when the owner enters the business workspace.

## 7.4 Post-Onboarding Configuration

Once onboarding is completed, Chillow Operations should guide the business through the appropriate existing setup workflows.

For example:

**Café**

- Menu setup
- ServicePoint configuration
- Ordering preferences
- Kitchen/bar workflow setup
- Staff setup
- Inventory configuration

**Hotel**

- Room types
- Room setup
- Accommodation settings
- Reservations
- Housekeeping
- Staff setup

**Resort**

- Accommodation setup
- Optional Food Service activation
- Appropriate additional supported operational workflows

Do not expose unsupported functionality simply because a venue type appears in the catalog.

## 7.5 Unsupported Business Types

A new venue type must not automatically inherit arbitrary operational behavior.

For example, a standalone spa should not receive a restaurant dashboard simply because its true operational module has not yet been implemented.

Unsupported classifications should be unavailable for normal activation until the relevant capabilities exist.

An optional interest-registration or review pathway may be developed separately if approved.

---

# 8. Capability-Driven Operations Interface

The long-term Operations frontend should render business navigation and available functionality based on effective operational capabilities rather than fixed venue-type comparisons.

### Food Service Workspace

May include:

- Orders
- Menu management
- Kitchen and bar fulfilment
- Waitstaff
- Reservations
- Inventory
- ServicePoints
- Guest management
- Analytics

### Lodging Workspace

May include:

- Rooms
- Accommodation reservations
- Housekeeping
- Guest management
- ServicePoints
- Inventory
- Analytics

### Hybrid Workspace

A venue with multiple supported modules should be able to access their applicable workflows from one coherent Operations interface.

For example, a hotel operating a restaurant may require both Lodging and Food Service capabilities.

The application should not require a separate hardcoded frontend simply because the venue's classification is Hotel.

### Effective Capability Rules

A module being assigned does not automatically authorize every feature.

Actual access depends on:

- Supported operational modules
- Subscription entitlements
- Venue configuration
- Operational prerequisites
- Staff roles and permissions
- Relevant reservation and payment eligibility rules

The backend must remain authoritative.

Frontend navigation is a presentation layer, not an authorization boundary.

---

# 9. Multi-Venue and Multi-Module Businesses

Chillow must be capable of evolving toward businesses with multiple venues or outlets.

Example:

**Azure Hospitality Group**

Operates:

- Azure Bay Resort — Lodging
- Azure Restaurant — Food Service
- Azure Rooftop Bar — Food Service

These venues may eventually share organization-level management while retaining independent:

- Operating hours
- Menus
- Staff assignments
- ServicePoints
- Inventory
- Reservations
- Public profiles
- Discovery listings

A single property may also host multiple operational experiences.

For example, a resort might provide accommodation and dining within one property.

### Important Scope Boundary

The current Chillow Business model must not be assumed to support the complete Organization → Venue → Outlet relationship.

This architecture is a future evolution.

Do not create multiple new database collections or refactor all business ownership models as part of the initial `venueType` rollout.

Multi-venue functionality requires its own approved implementation and migration plan.

---

# 10. Discovery Integration

The venue architecture must support Chillow's approved three-tab Discovery interface.

## Find a stay

Queries eligible published accommodation venues or offerings.

Examples:

- Hotels
- Resorts
- Guesthouses
- Aparthotels

## Go out

Queries eligible published food, drinks, and compatible non-accommodation hospitality venues or offerings.

Examples:

- Restaurants
- Cafés
- Bars
- Lounges

Additional leisure venues become eligible when the supporting classification, operational capabilities, and Discovery publication requirements exist.

## Chill

The universal Discovery mode.

Includes all eligible published Chillow hospitality venues and offerings.

**Chill remains the default Discovery mode.**

### Discovery Filtering Rules

A venue's inclusion must not depend solely on its label.

Discovery must consider:

1. Supported venue classification.
2. Applicable operational capabilities.
3. Published business/profile status.
4. Offering availability and eligibility where relevant.
5. The selected Discovery search mode.

Discovery must not invent reservations, available rooms, service capacity, or other operational capabilities.

A published venue can be discoverable without necessarily supporting online booking.

Bookings must continue through the appropriate existing Chillow Operations workflows.

---

# 11. Scalability and Technology Strategy

Chillow should continue evolving as a modular monolith rather than immediately introducing separate microservices for every hospitality vertical.

The existing technology foundation includes:

- Next.js
- React
- TypeScript
- Node.js
- Express
- MongoDB
- Redis
- BullMQ
- REST APIs
- Existing payment, media, email, and other integrations

Architecture should prioritize:

- Clear domain boundaries
- Reusable operational modules
- Centralized venue classification
- Backend-enforced capabilities
- Tenant isolation
- Consistent authorization
- Backward compatibility
- Independent testing of operational domains
- Incremental migrations
- Safe sandbox validation

Microservices should be considered later only where independent deployment, scaling, reliability, or organizational requirements justify the additional complexity.

---

# 12. Implementation Roadmap

The target architecture must be implemented incrementally.

## Phase 1 — Venue Taxonomy and Capability Contract

Define:

- Canonical supported venue types
- Venue classification groups
- Compatibility mapping to existing `businessType`
- Default module assignments
- Unsupported classification handling
- Validation rules
- Existing accommodation subtype compatibility
- Discovery classification mapping

Deliver a clear technical contract before changing persistence.

## Phase 2 — Backend Foundation

Implement compatible backend support for `venueType`.

Requirements:

- Preserve `businessType`.
- Add validated venue classification.
- Centralize catalog and mapping logic.
- Resolve supported default modules server-side.
- Reject unknown or unsupported classifications.
- Preserve existing APIs and operational behavior.
- Add focused tests.
- Provide a safe migration/backfill strategy for existing businesses.

Do not deploy destructive database changes.

## Phase 3 — Business Identity UI Update

Modify only the Business Identity stage in `chillow-app`.

Requirements:

- Replace the three hardcoded business types.
- Introduce grouped venue-type selection.
- Integrate supported backend catalog values.
- Preserve existing form fields.
- Preserve existing onboarding state and validation.
- Keep all six onboarding stages unchanged.
- Do not introduce additional required onboarding questionnaires.
- Do not change payment or subscription workflows.

## Phase 4 — Operations Capability Integration

Progressively reduce hardcoded business-type assumptions.

Adapt supported dashboard navigation, module visibility, configuration, and post-registration setup to resolved capabilities.

Preserve operational behavior for existing restaurants, bars, and hotels.

## Phase 5 — Discovery Integration

Connect Find a stay, Go out, and Chill to the new classification and capability contract.

Preserve existing Discovery publication rules and booking handoffs.

## Phase 6 — Future Multi-Venue Architecture

Introduce organization-level ownership and independently managed venues or outlets when justified by product requirements.

This phase requires separate schema, tenant-isolation, permission, billing, and migration design.

---

# 13. Mandatory Agent Rules

All coding agents working on Chillow must follow these rules.

### Understand current versus target architecture

Always inspect the current implementation before proposing or editing code.

Do not assume an architectural proposal has already been deployed.

### Preserve onboarding

The existing six-stage onboarding journey is approved.

**Only Business Identity is in scope for the initial venue classification update.**

Do not redesign Create Account, Verify Email, Location, Choose Plan, or Complete as part of this work.

### Keep classification separate from functionality

Do not create a separate operational application for each venue type.

Do not determine access exclusively from `venueType`.

Use validated operational capabilities.

### Preserve legacy compatibility

Do not remove `businessType` prematurely.

Do not break existing IDs, QR capabilities, sessions, reservations, bookings, payments, or public URLs.

### Validate new venue types

Never silently default an unknown classification to Restaurant.

Unsupported venue types must be rejected or routed to an explicitly supported alternative process.

### Keep advanced setup outside initial onboarding

Detailed operational settings should remain in the appropriate post-onboarding business setup and settings workflows.

### Enforce backend authorization

Frontend visibility must not replace backend permission, entitlement, reservation, or payment checks.

### Avoid unnecessary architectural expansion

Do not introduce Organization, Venue, Outlet, Offering, or generalized Resource collections solely because they are described in this target document.

Such changes require separate approval and migration planning.

### Respect deployment boundaries

Work in development or sandbox environments.

Do not modify production business data, merge branches, or deploy migration changes without explicit authorization.

### Test compatibility

Every architectural migration must include focused tests for existing business types, module resolution, onboarding payloads, validation, and impacted operational workflows.

---

# 14. Final Architectural Principles

The following definitions are the foundation of Chillow's future development.

**Organization**  
The entity that owns or manages hospitality venues.

**Venue**  
A hospitality location, property, or independently operated outlet.

**Venue Type (`venueType`)**  
Describes what the venue is.

**Operational Modules (`modules`)**  
Provide reusable systems the venue can operate.

**Configuration**  
Defines how supported modules behave.

**Capabilities, Entitlements, and Permissions**  
Determine which functionality can actually be used and by whom.

**Offerings**  
Represent guest-facing hospitality services and experiences.

**Resources**  
Represent inventory or capacity used to deliver offerings.

**ServicePoints**  
Represent guest interaction or service locations.

**Chillow Discovery**  
Connects guests to eligible published venues and offerings through Find a stay, Go out, and Chill.

---

# 15. Final Product Direction

Chillow must not evolve into separate Restaurant, Café, Bar, Hotel, and Resort applications.

It should evolve into **one connected, capability-driven hospitality ecosystem**.

A restaurant, café, and bar can share Food Service.

A hotel, resort, and guesthouse can share Lodging.

A venue can operate multiple supported modules.

An organization can eventually manage multiple venues.

The onboarding journey remains simple, while Chillow intelligently recommends the appropriate operational foundation from the venue's identity.

**The approved immediate change is to introduce scalable venue classification through the existing Business Identity step, while preserving the rest of onboarding and maintaining backward compatibility.**

The guiding principle remains:

**Build operational systems once. Configure them for different hospitality businesses. Connect them through Chillow.**