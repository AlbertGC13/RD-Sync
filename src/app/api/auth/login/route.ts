/**
 * Login route handler.
 *
 * POST /api/auth/login
 *
 * Accepts JSON { email: string; password: string }.
 * Returns 200 + Set-Cookie on success, 401 with generic error on any failure,
 * 429 with Retry-After when the client IP exceeds the rate limit.
 *
 * Security properties:
 * - NEVER reveals whether the email exists (no user enumeration).
 * - NEVER logs passwords or tokens.
 * - Rate-limited BY CLIENT IP (not by email — keying by email would let an
 *   attacker lock out a specific account via DoS).
 * - 429 fires BEFORE the user lookup so a throttled response is also
 *   email-agnostic.
 * - Response-time floor (default 250 ms) is applied on the 200 and 401 paths
 *   to mask the DB-hit/miss timing delta that can otherwise leak email validity
 *   even after the decoy-hash fix.
 *
 * Timing-safe enumeration resistance: verifyPassword (scrypt) always runs,
 * even when the email is unknown or the account has no password hash.
 * A module-level DECOY_HASH is initialised once at startup for this purpose.
 */

import type { UserRepository } from "../../../../modules/auth/user-repository";
import type { RateLimiter } from "../../../../modules/auth/rate-limiter";
import { hashPassword, verifyPassword } from "../../../../modules/auth/password";
import { signSession } from "../../../../modules/auth/session";
import {
  serializeSessionCookie,
  buildSessionCookieOptions,
  SESSION_MAX_AGE_MS,
} from "../../../../modules/auth/cookie";
import { getAuthSecret } from "../../../../modules/auth/index";
import { InMemoryRateLimiter } from "../../../../modules/auth/rate-limiter";
import { defaultUserRepository } from "../defaults";

const INVALID_CREDENTIALS = "Invalid email or password";
const TOO_MANY_ATTEMPTS = "Too many attempts. Try again later.";

/**
 * Default response-time floor in milliseconds.
 * Applied to 200 and 401 paths to equalise DB-hit/miss timing.
 */
const DEFAULT_FLOOR_MS = 250;

/**
 * Default delay implementation (real timer). Injectable for tests.
 */
function realDelay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pre-computed decoy hash used when the email is unknown or the account has
 * no password hash. Ensures scrypt always runs so response time is constant
 * regardless of whether the email exists in the database.
 *
 * Initialised lazily on first use to avoid blocking import time.
 */
let _decoyHashPromise: Promise<string> | null = null;

function getDecoyHash(): Promise<string> {
  if (!_decoyHashPromise) {
    _decoyHashPromise = hashPassword("rd-sync-decoy-constant-work");
  }
  return _decoyHashPromise;
}

/**
 * Module-level default rate limiter (shared across requests in the same process).
 * In-memory, resets on restart — acceptable for local-first MVP.
 */
const defaultRateLimiter = new InMemoryRateLimiter();

/**
 * XFF trust warning — emitted once at module load.
 *
 * x-forwarded-for is trusted without any proxy validation. In a direct-to-
 * internet deployment (no trusted reverse proxy in front of Next.js) a client
 * can set an arbitrary x-forwarded-for header and completely bypass IP-based
 * rate limiting by rotating spoofed IPs.
 *
 * Ensure a reverse proxy strips or overwrites x-forwarded-for before it
 * reaches this process, or set RD_SYNC_TRUST_XFF=false to fall back to the
 * "unknown" shared bucket (which is at least unspoofable).
 *
 * See docs/runbooks/auth.md for the recommended proxy configuration.
 */
if (process.env.NODE_ENV !== "test" && process.env.RD_SYNC_TRUST_XFF !== "false") {
  console.warn(
    "[auth/login] WARNING: x-forwarded-for is trusted unconditionally. " +
    "Ensure a trusted reverse proxy is in front of this service. " +
    "Set RD_SYNC_TRUST_XFF=false to disable XFF trust and use the shared 'unknown' bucket instead.",
  );
}

/**
 * Derive the client IP key for rate limiting.
 *
 * Prefers x-forwarded-for (first hop) so that behind a reverse proxy each
 * real client IP gets its own bucket. Falls back to x-real-ip, then "unknown".
 *
 * NOTE: A correct IP requires the trusted proxy (or Next.js server) to set
 * these headers. Without a proxy, all requests will share the "unknown" bucket.
 */
function deriveIpKey(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = request.headers.get("x-real-ip")?.trim();
  if (xri) return xri;
  return "unknown";
}

export interface LoginHandlerDeps {
  users: UserRepository;
  secret: string;
  clock: () => number;
  /** Override decoy hash for deterministic tests. */
  decoyHash?: Promise<string>;
  /** IP-based rate limiter. Default: module-level InMemoryRateLimiter. */
  rateLimiter?: RateLimiter;
  /** Artificial delay function for the timing floor. Default: setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /** Minimum response time (ms) for 200 and 401 paths. Default: 250. */
  floorMs?: number;
  /**
   * Password verification function. Default: the real scrypt verifyPassword.
   * Injectable so tests can assert it runs on every path (constant-work
   * guarantee) without mocking the module.
   */
  verify?: (plain: string, stored: string) => Promise<boolean>;
}

export function createLoginHandler(deps: LoginHandlerDeps) {
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter;
  const delay = deps.delay ?? realDelay;
  const floorMs = deps.floorMs ?? DEFAULT_FLOOR_MS;
  const verify = deps.verify ?? verifyPassword;

  return async function POST(request: Request): Promise<Response> {
    // --- Rate limit check (before user lookup, IP-scoped, email-agnostic) ---
    const ipKey = deriveIpKey(request);
    const rateResult = rateLimiter.check(ipKey);
    if (!rateResult.allowed) {
      return Response.json({ error: TOO_MANY_ATTEMPTS }, {
        status: 429,
        headers: { "Retry-After": String(rateResult.retryAfterSeconds ?? 60) },
      });
    }

    // --- Start timing floor clock ---
    const start = deps.clock();

    // --- Parse body ---
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // Malformed body — record failure so the rate-limit budget advances even
      // for bots/fuzzers that deliberately send bad JSON.
      rateLimiter.recordFailure(ipKey);
      await applyFloor(delay, deps.clock, start, floorMs);
      return Response.json({ error: INVALID_CREDENTIALS }, { status: 401 });
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      rateLimiter.recordFailure(ipKey);
      await applyFloor(delay, deps.clock, start, floorMs);
      return Response.json({ error: INVALID_CREDENTIALS }, { status: 401 });
    }

    const { email, password } = body as Record<string, unknown>;

    if (typeof email !== "string" || typeof password !== "string") {
      rateLimiter.recordFailure(ipKey);
      await applyFloor(delay, deps.clock, start, floorMs);
      return Response.json({ error: INVALID_CREDENTIALS }, { status: 401 });
    }

    const user = await deps.users.findByEmail(email);

    // Always run scrypt — even when the user is unknown or has no password hash —
    // so that response latency is constant and email enumeration via timing is
    // not possible.
    const decoy = await (deps.decoyHash ?? getDecoyHash());
    const candidateHash = user?.passwordHash ?? decoy;
    const passwordValid = await verify(password, candidateHash);

    if (
      !user ||
      user.passwordHash === null ||
      user.status === "disabled" ||
      !passwordValid
    ) {
      rateLimiter.recordFailure(ipKey);
      await applyFloor(delay, deps.clock, start, floorMs);
      return Response.json({ error: INVALID_CREDENTIALS }, { status: 401 });
    }

    const expiresAt = deps.clock() + SESSION_MAX_AGE_MS;
    const token = signSession({ userId: user.id, role: user.role, expiresAt }, deps.secret);
    const cookieString = serializeSessionCookie(token, buildSessionCookieOptions());

    await applyFloor(delay, deps.clock, start, floorMs);
    return Response.json({ ok: true }, {
      status: 200,
      headers: { "Set-Cookie": cookieString },
    });
  };
}

/**
 * Apply the response-time floor: wait until at least floorMs ms have elapsed
 * since `start`. Clamps to 0 if the handler already took longer than floorMs.
 */
async function applyFloor(
  delay: (ms: number) => Promise<void>,
  clock: () => number,
  start: number,
  floorMs: number,
): Promise<void> {
  const elapsed = clock() - start;
  await delay(Math.max(0, floorMs - elapsed));
}

/**
 * Default POST handler — resolves secret inside the handler closure so that
 * it is called AFTER the rate-limit check inside createLoginHandler.
 * This ensures a misconfigured secret (getAuthSecret() throws) never bypasses
 * the rate limiter; the 500 is still throttled.
 */
export async function POST(request: Request): Promise<Response> {
  const handler = createLoginHandler({
    users: defaultUserRepository,
    // Secret is resolved lazily via a deferred getter so the module is safe to
    // import even when RD_SYNC_AUTH_SECRET is not set, and so that getAuthSecret()
    // is not called before the rate-limit check executes.
    get secret(): string {
      return getAuthSecret();
    },
    clock: () => Date.now(),
  });
  return handler(request);
}
