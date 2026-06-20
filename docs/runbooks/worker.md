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
