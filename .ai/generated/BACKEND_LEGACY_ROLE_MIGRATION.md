# Executive Summary

This report covers Phase 2 of the technical-debt cleanup, focusing on the backend repository's legacy model aliases for `Business` and `Staff`. 

We verified the `Restaurant` alias was safe and removed it. However, we preserved the `Waiter` alias because it has diverged from the `Staff` schema and is not a pure alias. We also inspected controllers and routes to verify the separation between the core `Staff` entity and the specific `Waitstaff` operational role.

# Restaurant Alias Assessment

**Verdict:** Pure alias. Removed safely.

`src/models/Restaurant.js` was a pure re-export (`export { default } from "./Business.js"`). It had no divergent schema definitions or side effects. Extensive repository searches confirmed no remaining imports, `mongoose.model` lookups, or schema references (`ref: "Restaurant"` / `populate`). It was safely deleted.

# Waiter Alias Assessment

**Verdict:** NOT a pure alias. Preserved.

`src/models/Waiter.js` was inspected against `src/models/Staff.js`. The schemas have diverged:
- **Roles:** `Waiter.js` allows `["waiter", "kitchen", "manager"]`. `Staff.js` added `bartender` and `co_owner`.
- **Fields:** `Staff.js` includes `passwordResetToken` and `passwordResetExpires` which are absent from `Waiter.js`.
- **Mongoose Registration:** `Waiter.js` registers as `mongoose.model("Waiter")` implicitly mapping to the `waiters` collection. `Staff.js` registers as `mongoose.model("Staff")` explicitly mapping to `"waiters"`.
- **Action:** Per instructions, because the schema differs, the `Waiter.js` alias was **NOT** deleted and has been preserved.

# Staff vs Waitstaff Assessment

- **Staff** is the core entity that covers all employee roles (`waiter`, `kitchen`, `manager`, `bartender`, `co_owner`).
- **Waitstaff** is an operational role under `Staff`.
- The `Staff` model correctly treats this as a hierarchy, distinguishing roles in its schema. However, legacy naming throughout the codebase (`waiterId`, `waiterController`) still conflates the two conceptually. `staffController.js` correctly abstracts staff management for all roles, while the other controllers focus specifically on Waitstaff workflows.

# Controller Assessment

### `waiterController.js`
- **Responsibility:** Manages only Waitstaff role operations (e.g., `waiterOrders`, `waiterReadyOrders`).
- **Recommendation:** Rename to `waitstaffController.js` in the future.

### `waiterOrdersController.js`
- **Responsibility:** Manages only Waitstaff order interactions (placing offline orders, marking as paid, past orders).
- **Recommendation:** Rename to `waitstaffOrdersController.js` in the future.

### `waiterCallController.js`
- **Responsibility:** Manages assistance calls placed by tables strictly for Waitstaff.
- **Recommendation:** Rename to `waitstaffCallController.js` in the future.

### `staffController.js`
- **Responsibility:** Truly manages ALL Staff members (fetching, creating, deleting) with explicit role filters (`waiter`, `kitchen`, `manager`, etc.).
- **Recommendation:** Name is accurate. No rename needed.

# Route Assessment

### `waiter-route.js`
- **Responsibility:** Exposes Waitstaff operations (calls, past orders, active orders). It does not handle general staff management (which happens in `owner-route.js`).
- **Recommendation:** Rename to `waitstaff-route.js` in the future.

# Alias Cleanup

- **Imports updated:** None. (No legacy imports of `Restaurant.js` or `Waiter.js` were found in active code.)
- **Aliases removed:** `src/models/Restaurant.js`
- **Aliases preserved:** `src/models/Waiter.js` (due to schema divergence).

# Compatibility Risks

- **Mongoose Model Names:** No risks found. No dynamic lookups (`mongoose.model("Restaurant")` / `mongoose.model("Waiter")`) or populate references remain in the codebase.
- **Legacy Field Lookups:** High reliance remains on legacy identifiers (`restaurantId` and `waiterId`) across most backend controllers and routes as fallback query mechanisms. These must remain until all API clients fully migrate to `businessId` and `staffId`.

# Validation Results

- **searches:** Full repository grep for imports, Mongoose lookups, schema refs, and populates completed. No remaining usages of `Restaurant` or `Waiter` models found.
- **tests:** ✅ Passed. Executed `npm run test:capabilities`, `npm run test:pricing`, `npm run test:check-in`. All 31 tests across 3 suites passed successfully.
- **typecheck:** ⚠️ Failed. `npx tsc --noEmit` fails because the backend `tsconfig.json` defines no valid inputs (it is a standard Node JS repository, not fully TypeScript).
- **lint:** ⚠️ Failed. `npm run lint` missing from `package.json` / eslint binary not present.

# Deferred Work

Future migration candidates:
- **Routes:** Rename `restaurant-route.js` to `business-route.js` and `restaurant-scoped-route.js` to `business-scoped-route.js`. Rename `waiter-route.js` to `waitstaff-route.js`.
- **Controllers:** Rename `waiterController.js`, `waiterOrdersController.js`, and `waiterCallController.js` to `waitstaff*`.
- **Schema Fields:** Eventual deprecation of `restaurantId` and `waiterId` fields in `Business`, `Staff`, `Order`, and `TableSession` schemas once APIs are strictly enforced.
- **API Naming:** Phasing out fallback query parameters (`?restaurantId=...`) in favor of strict `businessId`.
