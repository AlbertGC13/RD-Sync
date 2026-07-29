# Ingestion Worker Runbook

## Overview

RD-Sync uses a BullMQ + Redis durable queue for ingestion jobs.  The API
process (Next.js) enqueues jobs; a separate worker process consumes and
executes them.  This separation means jobs survive an API restart and can be
processed concurrently without blocking HTTP responses.

Without `RD_SYNC_REDIS_URL` set, the system falls back to an in-memory queue
with an in-process consumer (dev default, no Redis required).

---

## Environment variable

| Variable              | Required for Redis mode | Example                    |
|-----------------------|-------------------------|----------------------------|
| `RD_SYNC_REDIS_URL`   | Yes                     | `redis://localhost:6379`   |

When this variable is **set**:
- The API process pushes jobs to the BullMQ queue in Redis.
- The API process does **not** drain jobs in-process — `drainPending()` is
  skipped and the separate worker handles all consumption.

When this variable is **unset** (default):
- Jobs go into an `InMemoryScheduledIngestionQueue` inside the Next.js process.
- The run-now route drains the queue synchronously after enqueue (fire-and-forget).
- No Redis or worker process is needed.

---

## Starting services

```bash
# Start Postgres + Redis together
docker compose up -d

# Verify Redis is healthy
docker compose ps redis
```

The Redis dev URL (no auth) is `redis://localhost:6379`.

---

## Running the worker

The worker is a **separate process** from `pnpm dev`.  Open a second terminal:

```bash
# Terminal 1 — Next.js API
pnpm dev

# Terminal 2 — ingestion worker
RD_SYNC_REDIS_URL=redis://localhost:6379 pnpm worker
```

The worker will print:

```
[ingestion-worker] Started. Waiting for jobs on 'bank-transaction-ingestion'...
```

Trigger a scrape via the admin UI or `POST /api/scrape-runs/run-now`.  The API
enqueues the job and returns `202 Accepted` immediately.  The worker picks up
the job and executes the scraper.

---

## Retry semantics

BullMQ is configured with `attempts: 3` and `backoff: { type: "exponential", delay: 30000 }` (30 s base).

| Outcome                 | BullMQ retried? | Reason                                                   |
|-------------------------|-----------------|----------------------------------------------------------|
| `succeeded`             | No              | Job completed normally.                                  |
| `needs_admin_action`    | No              | Terminal outcome — processor catches it and returns it.  |
| `failed` (scrape error) | No              | Terminal outcome — processor catches it and returns it.  |
| Unexpected throw (e.g. DB unreachable during `markRunning`) | Yes, up to 3 times | Propagates through the worker handler. |

Only **unexpected infrastructure errors** (database down, Redis unreachable,
unhandled exceptions) trigger BullMQ retries.  Scraper errors and bank
session issues are handled inside the processor and are **not retried**.

---

## Stopping the worker

The worker listens for `SIGTERM` and `SIGINT`.  It calls `worker.close()` to
finish any in-flight job before exiting.

```bash
# Ctrl+C in the worker terminal, or:
kill -SIGTERM <worker-pid>
```

---

## Live Redis verification (maintainer checklist)

The following scenarios are only verifiable with a live Redis instance and are
**not covered by the default `pnpm test` run** (gated tests skip without Redis):

- [ ] `docker compose up -d` starts Redis healthy.
- [ ] `RD_SYNC_REDIS_URL=redis://localhost:6379 pnpm worker` connects and
      waits for jobs without errors.
- [ ] `POST /api/scrape-runs/run-now` enqueues a job visible in Redis (e.g.
      via `redis-cli LLEN bull:bank-transaction-ingestion:wait`).
- [ ] Worker picks up the job, calls the processor, logs the run ID and status.
- [ ] Restarting the worker mid-queue does not lose the pending job.
- [ ] With `RD_SYNC_TEST_REDIS_URL=redis://localhost:6379 pnpm test`, the
       integration test suite passes.

---

## Two-replica expiry runtime proof

Run the gated runtime proof only against a dedicated database with committed
migrations and a dedicated Redis instance:

```bash
RD_SYNC_TEST_DATABASE_URL="postgresql://test-user:test-password@localhost:5432/rd_sync_test" \
RD_SYNC_TEST_REDIS_URL="redis://localhost:6379" \
pnpm exec vitest run src/worker/expiry-runtime.integration.test.ts
```

Until this command completes successfully against both dedicated services, the
proof remains blocked and B2.5 remains pending. Record unavailable PostgreSQL
or Redis as a blocked verification result; do not infer a pass from the skip.

Expected evidence:

- Two independently constructed runtimes use distinct lease owners, timer
  handles, and BullMQ queue clients.
- Concurrent expiry observations persist one episode, one expiry audit, and
  one publication job.
- A test-only worker forces that synthetic job to retained `failed`; concurrent
  terminal observation emits one durable reconciliation audit and one fixed,
  safe operator alert.
- A pending manual-recovery audit outbox row is leased once and becomes one
  delivered row with one resolution audit.
- Shutdown waits for blocked ticks, clears both timers, closes each owned queue
  once, and is idempotent.

Cleanup is scoped to the test UUID queue through BullMQ `obliterate` and to
the test's UUID database records. The test never calls Redis `FLUSHALL`.

Safety boundaries:

- Both variables must target disposable test services, never `DATABASE_URL`,
  developer data, or production data.
- The proof creates no ingestion, scraper, browser, CDP, credential, bank URL,
  or login activity.
- `unavailableScrapeTimeAutoLoginBrowserOpener` remains unchanged.

---

## Troubleshooting

**Worker fails to start:**
```
[ingestion-worker] RD_SYNC_REDIS_URL is not set.
```
Set `RD_SYNC_REDIS_URL` before starting the worker.

**Jobs not being processed:**
- Confirm the worker process is running (separate terminal from `pnpm dev`).
- Confirm `RD_SYNC_REDIS_URL` is identical in both processes.
- Check Redis health: `docker compose ps redis`.

**All jobs report `needs_admin_action`:**
- No bank navigation is configured.  Set `RD_SYNC_SCRAPER=popular-cdp` and
  `RD_SYNC_CDP_URL` to attach to the bank browser, or set
  `RD_SYNC_DEV_PREVIEW=enabled` for the fixture scraper.

---

## Linux server setup — Banco Popular browser orchestration

RD-Sync runs on a Linux server. The bank browser is Brave/Chromium (not
Firefox for this slice) because the existing working path is CDP attach
(`chromium.connectOverCDP`). The employee never sees the browser process —
the worker attaches to a server-side browser that an admin has logged into.

### 1. Install a browser

Install Brave or Chromium on the server:

```bash
# Debian/Ubuntu — Brave
sudo apt install curl
sudo curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" | sudo tee /etc/apt/sources.list.d/brave-browser-release.list
sudo apt update && sudo apt install brave-browser

# Or Chromium
sudo apt install chromium-browser
```

### 2. Configure environment variables

```bash
export RD_SYNC_SCRAPER=popular-cdp
export RD_SYNC_CDP_URL=http://127.0.0.1:9222
export RD_SYNC_BANK_BROWSER_AUTO_LAUNCH=enabled
export RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND=./scripts/launch-bank-browser.sh
```

With auto-launch enabled, the worker calls the launch command before
connecting if CDP is not already alive, then polls until CDP responds (or
times out after `RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS`, default 30 s).

Without auto-launch, the admin must run `./scripts/launch-bank-browser.sh`
manually before the worker can scrape.

### 3. Run the server and worker

```bash
# Terminal 1 — Next.js API
pnpm dev

# Terminal 2 — ingestion worker
RD_SYNC_REDIS_URL=redis://localhost:6379 pnpm worker
```

### 4. Admin first-time login / MFA

The first time (or whenever the bank session expires):

1. Run `./scripts/launch-bank-browser.sh` (or let the worker auto-launch it).
2. In the browser window that opens on the server, log in to the bank portal
   with credentials and complete MFA.
3. Leave the browser open. The worker attaches via CDP on the next scrape.

The admin accesses the server browser through a secure remote desktop
(VNC/noVNC over SSH tunnel). CDP is bound to 127.0.0.1 only — never expose
it to the Internet.

### Security constraints

- **No automated login or MFA.** The worker never enters credentials or
  completes MFA. Banco Popular blocks CDP-driven login attempts.
- **No anti-bot evasion.** RD-Sync does not bypass Imperva or other bank
  defences. The scraper is read-only over a human-opened session.
- **CDP on 127.0.0.1 only.** The launch script always binds
  `--remote-debugging-address=127.0.0.1`. Do not change this to 0.0.0.0.
