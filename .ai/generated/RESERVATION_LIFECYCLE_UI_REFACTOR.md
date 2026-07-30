# Reservation Lifecycle UI Refactor

## Scope

This change refactors the Owner > Reservations hotel workflow without
redesigning reservation creation, pricing, payments, hotel settings, or the
underlying lifecycle.

The owner UI now presents three separate concerns:

- read-only reservation status;
- read-only payment status;
- one contextual action menu derived from the persisted reservation status.

Backend transition validation remains authoritative.

## Files modified

### Backend

- `src/controllers/reservationController.js`
- `src/controllers/cronController.js`
- `src/routes/owner-route.js`

### Frontend

- `components/reservations/HotelReservationsDashboard.tsx`
- `components/reservations/dashboard/useReservationDashboard.ts`
- `components/reservations/dashboard/ReservationDeleteDialog.tsx`

## Files created

### Backend

- `src/services/reservationExpiryService.js`
- `test/reservationExpiryService.test.js`
- `.ai/generated/RESERVATION_LIFECYCLE_UI_REFACTOR.md`

### Frontend

- `components/reservations/dashboard/HotelReservationActionsMenu.tsx`
- `components/reservations/dashboard/ReservationPaymentStatusBadge.tsx`
- `components/reservations/dashboard/hotel-reservation-actions.ts`
- `components/reservations/dashboard/hotel-reservation-actions.json`
- `reservation-lifecycle-ui.test.mjs`

## UI changes

- Removed the editable status selector from every hotel reservation
  presentation: main desktop list, mobile list, calendar room rows,
  unassigned rows, and selected-day details.
- Kept the existing status filter because it filters the page and does not
  mutate a reservation.
- Added separate `Reservation` and `Payment` columns in the desktop table.
- Added separate reservation and payment badges to compact/calendar rows.
- Changed the reservation label for `accepted_awaiting_payment` from
  `Awaiting Payment` to `Accepted`; payment state is now shown independently
  as `Awaiting Payment`.
- Replaced Accept, Cancel, Check-In, Delete, and editable-status controls with
  one contextual action menu.
- Changed terminal removal wording from destructive `Delete` to `Archive`,
  matching the backend soft-archive behavior.

## Removed components and controls

No component file was deleted. The following inline controls were removed:

- `renderStatusSelect`;
- all row-level status `<select>` elements;
- scattered Accept/Cancel icon pairs;
- standalone Check-In buttons;
- standalone Delete buttons;
- duplicate mobile action controls.

## Contextual lifecycle actions

| Persisted status | Owner actions |
| --- | --- |
| `pending` | Accept Reservation, Decline Reservation, View Reservation |
| `pending_approval` | Accept Reservation, Decline Reservation, View Reservation |
| `accepted_awaiting_payment` | Resend Payment Link, Copy Payment Link, Cancel Reservation, View Reservation |
| `confirmed` | Check In, Cancel Reservation, View Reservation |
| `checked_in` | Check Out, View Reservation |
| `checked_out` | View Reservation, Archive |
| `cancelled` | View Reservation, Archive |
| `expired` | View Reservation, Archive |
| `declined` | View Reservation, Archive |
| `completed` | View Reservation, Archive |
| `no_show` | View Reservation, Archive |

Payment-link actions are omitted when the backend does not return an active
`paymentUrl`.

The contextual action source does not expose arbitrary target states. Check-in
continues to use the code-verified check-in endpoint. Accept, decline/cancel,
and checkout continue through the existing transition endpoint and its
backend transition matrix.

`Decline Reservation` uses the supported `cancelled` transition because there
is no backend transition into the persisted `declined` enum value.

## Payment status behavior

Reservation status and payment status are rendered from independent fields.

- `paid` -> Paid
- `failed` -> Failed
- `refunded` -> Refunded
- pending payment on a pending reservation -> Not Started
- pending payment after acceptance/confirmation -> Awaiting Payment
- pending payment on an expired reservation -> Expired

This permits truthful combinations such as reservation `Confirmed` and
payment `Awaiting Payment` if such a record exists, without merging the two
domains into one badge.

## Payment expiry behavior

The existing authenticated cron endpoint remains in place. Its update logic
now reuses `reservationExpiryService`.

The expiry operation atomically transitions:

```text
status = accepted_awaiting_payment
paymentExpiresAt <= now

to:

status = expired
```

Owner list loading runs the same operation with the authenticated
`businessId` before returning reservations. This closes the synchronization
gap when the scheduled job has not run recently.

After the owner accepts a reservation, the UI schedules one timeout for the
nearest persisted `paymentExpiresAt`. At that deadline it reloads the owner
list, allowing the backend to persist and return `expired`. It does not poll
every second and does not maintain a separate client-only lifecycle state.

## Backend changes

- Added a reusable, guarded reservation expiry service.
  - Owner calls require `businessId`.
  - Only the protected cron caller explicitly opts into an all-tenant sweep.
- Owner reservation responses no longer expose `secureToken`.
- While a link is active, owner responses expose a complete `paymentUrl` for
  the contextual copy action.
- Status-update responses now return the complete updated owner DTO, allowing
  the new payment expiry and link fields to appear immediately after accept.
- Added
  `POST /owner/reservations/:id/resend-payment-link`.
  - It is tenant-scoped.
  - It reuses the existing reservation payment email.
  - It does not generate a new token or extend the deadline.
  - It atomically persists `expired` and returns a conflict if the deadline
    has passed.
- The existing paid confirmation/check-in-code resend endpoint remains
  unchanged.

## Delete and archive behavior

Backend validation was not weakened. Only these terminal statuses receive the
Archive action:

- `cancelled`
- `declined`
- `expired`
- `no_show`
- `completed`
- `checked_out`

Non-terminal statuses do not render Archive, so the owner cannot invoke an
operation the backend will reject. The existing delete route continues to
soft-archive terminal records using `archivedAt` and keeps the historical
record.

## Tests added and updated

Backend expiry tests cover:

- tenant-scoped expiry filters;
- rejection of accidental unscoped owner expiry;
- reuse by the trusted all-tenant scheduled job;
- atomic transition at the exact deadline;
- owner-list expiry synchronization;
- active payment URL response shaping;
- removal of raw `secureToken`;
- no payment URL for terminal or paid records.

Frontend static lifecycle tests cover:

- exact actions for each active lifecycle stage;
- Archive hidden for non-terminal records;
- Archive present for terminal records;
- removal of editable row status dropdowns;
- contextual menu usage;
- separate reservation and payment status inputs;
- deadline timeout synchronization with no interval polling.

Existing lifecycle suites continue to cover:

- invalid transition rejection;
- explicit code-verified check-in;
- checkout transition rules;
- cross-tenant action rejection;
- terminal soft archive;
- payment confirmation and hotel payment flow.

## Verification results

- Focused backend reservation suites: **36 passed**
- Focused frontend lifecycle checks: **5 passed**
- Combined focused result: **41 passed, 0 failed**
- Backend modified files: `node --check` passed
- Frontend: `npx tsc --noEmit` passed
- Frontend: `npm run build` passed, including `/owner/reservations`
- ESLint was not run because the frontend repository has no
  `eslint.config.js`, `eslint.config.mjs`, `eslint.config.cjs`, or legacy
  `.eslintrc` file.

## Lifecycle inconsistencies discovered

- `declined` is a persisted enum and terminal archive status, but no current
  stay transition targets it. The UI therefore labels the supported
  cancellation operation as Decline for a pending request but persists
  `cancelled`.
- `Edit Reservation`, `Change Room`, `Move Room`, and `Extend Stay` have no
  corresponding backend business operations. They were not displayed as fake
  actions.
- There is no `checkout_due` persisted lifecycle state, so none was invented.
- The existing status route is still generic at the HTTP level, but its
  backend transition matrix and special check-in prohibition remain
  authoritative. The owner UI no longer exposes it as a generic status
  selector.

## Future recommendations

- Add explicit, validated reservation editing, room-assignment, and
  stay-extension operations before exposing those actions.
- Decide whether `declined` should become a real transition with its own
  timestamp/reason semantics or be removed in favor of `cancelled`.
- If desired in a later backend lifecycle cleanup, replace UI calls to the
  existing status endpoint with explicit accept, cancel, and checkout
  business-operation routes. That was intentionally outside this UX refactor.
