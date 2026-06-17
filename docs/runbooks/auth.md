# Auth runbook

## How login works

RD-Sync uses a **signed cookie session** with **scrypt-hashed passwords**. No raw passwords or secrets are ever persisted.

1. The user submits their email and password to `POST /api/auth/login`.
2. The handler fetches the user record by email and calls `verifyPassword(plain, stored)` — a constant-time scrypt comparison.
3. On success, a signed JWT-like session token is created via `signSession({ id, role }, secret)` and written as an `HttpOnly` cookie (`rd-sync-session`).
4. Subsequent requests carry the cookie; server components call `getCurrentPrincipal()` (reads the cookie from `next/headers`) or the middleware checks presence for route gating.
5. Logout (`POST /api/auth/logout`) clears the cookie.

**No secrets are stored.** Passwords are hashed with scrypt (salt + 64-byte key). Session tokens are signed with `RD_SYNC_AUTH_SECRET` using HMAC-SHA256 — the secret is never exposed to the client.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `RD_SYNC_AUTH_SECRET` | Yes (login) | HMAC-SHA256 signing key for session tokens. Must be a strong random string. |
| `RD_SYNC_ADMIN_EMAIL` | Seed only | Email of the initial admin user. Used by `pnpm prisma:seed`. |
| `RD_SYNC_ADMIN_PASSWORD` | Seed only | Plaintext password for the initial admin. Hashed at seed time; never logged or stored. |
| `RD_SYNC_TRUST_PROXY_HEADERS` | No | Set to `"enabled"` only when a trusted reverse proxy forwards `x-rd-sync-*` identity headers. Keep `disabled` otherwise (default). |
| `DATABASE_URL` | Yes (DB mode) | PostgreSQL connection string. When absent, in-memory stores are used (dev only). |

### Generating `RD_SYNC_AUTH_SECRET`

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Copy the output into your `.env` file. Use a different value for each environment (dev, staging, production). Rotating the secret invalidates all existing sessions.

---

## Seeding the first admin user

Prerequisites: the database must exist and all migrations must be applied.

```sh
# 1. Start the database (if using the local compose file)
docker compose up -d db

# 2. Apply migrations (first time) or push the schema (dev shortcut)
pnpm db:push          # dev only — never use in production
# or
pnpm prisma migrate deploy   # production

# 3. Set the admin credentials in your shell (do NOT commit these)
export RD_SYNC_ADMIN_EMAIL=admin@example.com
export RD_SYNC_ADMIN_PASSWORD=change-me-before-use

# 4. Run the seed
pnpm prisma:seed

# 5. Log in at /login with the credentials above and change the password.
```

The seed is idempotent: re-running it updates the password hash and keeps the ADMIN role link. It logs `Admin user seeded: <email>` on success or a clear notice if the env vars are missing.

---

## `RD_SYNC_TRUST_PROXY_HEADERS`

When set to `"enabled"`, the app will trust `x-rd-sync-user-id` and `x-rd-sync-role` headers forwarded by an upstream proxy. This allows a trusted internal gateway (e.g. an SSO sidecar) to inject the authenticated identity without a separate cookie.

**Security note:** only enable this when a verified, trusted proxy is guaranteed to be the sole entry point. If the app is directly reachable from the public internet with this flag enabled, any client can forge these headers and impersonate any user.

Keep `disabled` (the default) for all other deployments.

---

## Audit log (`/admin/audit`)

The audit log page (`/admin/audit`) is a server-rendered paginated table of `AuditEvent` records. It is access-gated at two levels:

1. The `src/app/admin/layout.tsx` admin layout requires an `admin` session (redirects otherwise).
2. The page itself re-checks `getCurrentPrincipal()` and renders an "Admin access required" message if the role is not `admin` (defense-in-depth).

Metadata is redacted at write time (before persistence) — tokens, passwords, cookies, screenshots, and secrets are never stored. The page truncates long metadata strings to 120 characters for display only.

Pagination: append `?page=N` (N ≥ 1) to the URL. Each page returns up to 50 events, newest-first.

---

## Dev caveats

- **Restart after auth/env changes.** Next.js dev server caches module state. If you change `RD_SYNC_AUTH_SECRET` or any auth-related env var, restart the dev server to pick up the new value.
- **Middleware vs. server-side check.** The middleware (`middleware.ts`) checks for the presence of the session cookie to gate routes at the edge. The full cryptographic verification happens server-side (in `getCurrentPrincipal()` / `verifySession()`). A forged or expired cookie will pass the middleware gate but fail the server-side check — the page will render the access-denied state.
- **DB migration before login.** The `passwordHash` column (and the `User`, `Role`, `UserRole` tables) must be present before login works. Run `pnpm db:push` or `pnpm prisma migrate deploy` before attempting to seed or log in.

---

## Login protection

### IP-based rate limiting

Login attempts are rate-limited by **client IP address** (not by email). Keying by email would allow an attacker to lock out a specific account via DoS.

| Setting | Default |
|---|---|
| Max failed attempts | 5 |
| Window | 15 minutes |
| Storage | In-memory per-process |
| Reset | On process restart |

A throttled request receives **429** with a `Retry-After` header (seconds). The 429 fires **before** the user lookup, so the response is email-agnostic and does not leak whether an address exists.

**Proxy requirement:** The IP is derived from `x-forwarded-for` (first hop), then `x-real-ip`, falling back to `"unknown"` (a single shared bucket). For correct per-client IP isolation, a trusted reverse proxy or load balancer **must** set one of these headers.

**Limitation:** In-memory state is per-process and resets on restart. For multi-instance or serverless deployments, replace `InMemoryRateLimiter` with a shared backend (Redis, etc.) via the `RateLimiter` interface in `src/modules/auth/rate-limiter.ts`.

### Response-time floor

A minimum response time of **250 ms** is enforced on the **200 success** and **401 invalid-credentials** paths. This masks the database hit/miss timing delta that can otherwise let an attacker distinguish known from unknown email addresses even after the constant-time scrypt decoy-hash fix.

The 429 throttled path is exempt (no floor applied).
