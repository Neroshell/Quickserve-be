# QuickServe Engineering Bootstrap Runbook

This guide defines the deterministic setup, validation, and deployment steps required for a fresh or upgraded environment.

## 1. Environment Definitions

### A. Local Development
- Target: Developer machine.
- Needs: MongoDB running locally or on cloud. Redis optional for API but required for BullMQ features.
- Env: Safe defaults exist. E.g. `SESSION_SECRET` can be omitted to use default.
- Worker: Starts via `npm run worker:dev`.

### B. Production
- Target: Public-facing servers (API & Worker).
- Needs: MongoDB Cluster/Replica Set (for transactions), Redis cluster, Stripe, Resend.
- Env: Strict. Boot process will hard-crash if mandatory secrets are missing.
- Security: CORS enforced.

---

## 2. Dependencies & Runtime

- **Node.js**: `v24.x` (Strictly enforced via `engines` and verification script)
- **MongoDB**: Must support transactions (Replica Set / Sharded Cluster). Standalone is not supported for production.
- **Redis**: Required for sessions, presence, cache, and BullMQ. (Sessions will fast-fail if Redis goes down, returning 503).

---

## 3. Fresh Environment Setup

Use this sequence for a completely empty, brand new environment.

### Step 1: Environment Variables
1. **Backend**: Copy `Quickserve-be/.env.example` to `.env`. Fill in `MONGODB_URI`, `REDIS_URL`, `STRIPE_SECRET_KEY`, `SESSION_SECRET`, etc.
2. **Frontend**: Copy `Quick-serve-qr-menu/.env.example` to `.env.local`. Ensure `NEXT_PUBLIC_API_BASE_URL` matches the backend origin.

### Step 2: Dependencies
```bash
nvm use
npm install
```

### Step 3: Database Bootstrap (Idempotent)
Run the purely database-focused setup to seed essential plans:
```bash
npm run setup:db
```
*Note: This does not make network calls to Stripe.*

### Step 4: Provider Bootstrap (Idempotent, explicit)
If this is a non-disposable environment, bootstrap the Stripe pricing/meter configuration:
```bash
npm run setup:stripe
```

### Step 5: Environment & Index Verification
Run the verification scripts to prove the environment is correctly configured and that MongoDB holds the required schema indexes.
```bash
npm run verify:environment
npm run verify:indexes
```

---

## 4. Startup & Traffic Gating

### Process Model
Chillow requires **two separate long-running processes** if BullMQ features are enabled (e.g. `BULLMQ_EMAILS_ENABLED=true`):

1. **API Process**: `npm start`
   - Handles public HTTP traffic.
   - Enqueues jobs, but does not process them.
   - Probes:
     - **`/healthz`**: Returns 200 `{"status": "alive"}` immediately.
     - **`/ready`**: Returns 200 `{"status": "ready"}` ONLY if MongoDB and Session Redis are connected. If Session Redis is offline, it drops to 503 so load balancers stop sending authenticated traffic. Cache and presence systems degrade safely and do not fail readiness.

2. **Worker Process**: `npm run worker`
   - Handles background jobs (emails, billing lifecycle, inventory repair).
   - Does not expose an HTTP server.
   - Boot sequence uses a bounded retry loop, pausing rather than crashing if Redis is temporarily unreachable.

### Deployment / Restart Flow
- Stop old Worker -> Start new Worker
- Wait for Worker to stabilize
- Start new API instances -> Wait for `/ready` -> Cut over traffic -> Terminate old API instances

---

## 5. Legacy Upgrades

When upgrading an existing QuickServe database (vs a fresh one), you must manually run any necessary historical migrations **before** `setup:db` or `verify:indexes`.
*A fresh database requires none of these.*

**Legacy Migrations:**
- Staff Legacy Waiter Index: `npm run migrate:staff-legacy-waiter-index`
- Reservation Idempotency: `npm run migrate:reservation-idempotency`
- Reservation Payment Indexes: `npm run migrate:reservation-payment-attempt-indexes`

---

## 6. Stripe Webhook Registration

Stripe webhooks are **not** created automatically by setup scripts to prevent accidental production mutations from local machines.

1. Go to the Stripe Dashboard > Developers > Webhooks.
2. Add Endpoint: `https://api.yourdomain.com/webhook`
3. Events to listen for:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
4. Copy the Webhook Signing Secret into the `STRIPE_WEBHOOK_SECRET` environment variable.
