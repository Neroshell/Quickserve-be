# MongoDB collection-name migration

This maintenance migration changes collection names only:

- `restaurants` to `businesses`
- `waiters` to `staff`

It does not copy documents, alter fields, remove `restaurantId`, remove legacy
routes, or drop indexes. `businessId` and `staffId` remain the canonical
identifiers. The `waiter` Staff role remains valid.

## Safety properties

- The migration is never imported by API or worker startup.
- `MONGODB_URI` is required; there is no implicit local-database fallback.
- Output contains counts, validation totals, and index metadata only.
- Dry-run and audit modes never mutate MongoDB.
- A confirmed run repeats preflight immediately before its first mutation.
- A non-empty target collection always aborts the operation.
- Only an existing empty target collection can be removed.
- Collection renames use `dropTarget: false`.
- Indexes are preserved and verified; none are dropped automatically.
- Re-running after a verified rename or rollback is a successful no-op.

## Commands

Read-only audit:

```bash
npm run audit:collections
```

Required dry-run:

```bash
npm run migrate:collections -- --dry-run
```

Apply outside production:

```bash
npm run migrate:collections -- --confirm-rename
```

Apply when `NODE_ENV=production`:

```bash
npm run migrate:collections -- --confirm-rename --confirm-production
```

Rollback dry-run:

```bash
npm run migrate:collections:rollback -- --dry-run
```

Confirmed rollback outside production:

```bash
npm run migrate:collections:rollback -- --confirm-rollback
```

Confirmed rollback when `NODE_ENV=production`:

```bash
npm run migrate:collections:rollback -- --confirm-rollback --confirm-production
```

## Cutover procedure

The release containing the new model bindings expects `businesses` and `staff`.
Do not start that API or worker build against a database that still uses
`restaurants` and `waiters`.

1. Build and test the release artifact, but do not start it.
2. Run `npm run audit:collections` and save the safe summary.
3. Run the migration dry-run and review all counts and index checks.
4. Take a database snapshot or verified backup.
5. Disable external cron schedules.
6. Stop every API instance, BullMQ worker, one-off script, and other database
   writer. Confirm old deployment instances have fully drained.
7. Run the confirmed migration with the appropriate production flag.
8. Do not continue if either rename or post-verification fails. Inspect the
   reported collection state first; the first rename may have completed before
   a second-rename failure.
9. Deploy and start the release whose explicit bindings are:
   - `Business` to `businesses`
   - `Staff` to `staff`
10. Complete the verification checklist below before re-enabling cron traffic.

MongoDB preserves documents and indexes when renaming within the same database.
The operation locks the source and target namespaces and interrupts active
queries/cursors, which is why a maintenance window is mandatory.

## Rollback procedure

The rollback script changes collection names only. It does not revert source
code automatically.

1. Stop API, worker, cron, and all other database writers again.
2. Run the rollback dry-run.
3. Run the confirmed rollback.
4. Verify `restaurants` and `waiters` counts match the pre-rollback source
   counts.
5. Redeploy the previous application build that binds to the legacy collection
   names before restarting processes.
6. Keep `restaurantId` fields until the rollback window is formally closed.

## Index note

The migration verifies these canonical unique indexes:

- Business: `businessId`
- Staff: `businessId + staffId`
- Staff: `businessId + email`

Legacy indexes are deliberately preserved. In particular, the existing unique
`businessId + waiterId` index will move with `waiters` to `staff`. It is the
known cause of the one-staff-per-business insertion failure when `waiterId` is
absent. Removing it requires a separate, explicitly approved index migration;
this collection-name migration will only report it.

## Verification checklist

- [ ] `Business.find` reads from `businesses`.
- [ ] `Staff.find` reads from `staff`.
- [ ] Owner login works.
- [ ] Staff login works.
- [ ] Staff invitations work.
- [ ] Kitchen, waiter, manager, and co-owner routes work.
- [ ] Public business lookup works.
- [ ] Reservation creation, payment, and expiry behavior works.
- [ ] Billing lifecycle scan works.
- [ ] CRM post-payment processing works.
- [ ] Owner analytics load.
- [ ] Operational SSE events reach the expected roles.
- [ ] A BullMQ diagnostic job completes through the worker.
- [ ] No new documents appear in `restaurants` or `waiters`.
- [ ] `businesses` count matches the original `restaurants` count.
- [ ] `staff` count matches the original `waiters` count.
- [ ] No credentials, tokens, emails, or document contents appear in migration
      logs.

## Deferred cleanup

Do not combine these items with the collection cutover:

- Removing `restaurantId` document fields.
- Removing request/query compatibility fallbacks.
- Removing legacy routes.
- Deleting the abandoned `Waiter.js` model.
- Dropping legacy indexes.
