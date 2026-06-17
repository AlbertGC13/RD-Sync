/**
 * Login route handler.
 *
 * POST /api/auth/login
 *
 * Accepts JSON { email: string; password: string }.
 * Returns 200 + Set-Cookie on success, 401 with generic error on any failure.
 * NEVER reveals whether the email exists (no user enumeration).
 * NEVER logs passwords or tokens.
 *
 * Timing-safe enumeration resistance: verifyPassword (scrypt) always runs,
 * even when the email is unknown or the account has no password hash.
 * A module-level DECOY_HASH is initialised once at startup for this purpose.
 */

import type { UserRepository } from "../../../../modules/auth/user-repository";
import { hashPassword, verifyPassword } from "../../../../modules/auth/password";
import { signSession } from "../../../../modules/auth/session";
import {
  serializeSessionCookie,
  buildSessionCookieOptions,
  SESSION_MAX_AGE_MS,
} from "../../../../modules/auth/cookie";
import { getAuthSecret } from "../../../../modules/auth/index";
import { defaultUserRepository } from "../defaults";

const INVALID_CREDENTIALS = "Invalid email or password";

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

export interface LoginHandlerDeps {
  users: UserRepository;
  secret: string;
  clock: () => number;
  /** Override decoy hash for deterministic tests. */
  decoyHash?: Promise<string>;
}

export function createLoginHandler(deps: LoginHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: INVALID_CREDENTIALS }, { status: 401 });
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: INVALID_CREDENTIALS }, { status: 401 });
    }

    const { email, password } = body as Record<string, unknown>;

    if (typeof email !== "string" || typeof password !== "string") {
      return Response.json({ error: INVALID_CREDENTIALS }, { status: 401 });
    }

    const user = await deps.users.findByEmail(email);

    // Always run scrypt — even when the user is unknown or has no password hash —
    // so that response latency is constant and email enumeration via timing is
    // not possible.
    const decoy = await (deps.decoyHash ?? getDecoyHash());
    const candidateHash = user?.passwordHash ?? decoy;
    const passwordValid = await verifyPassword(password, candidateHash);

    if (
      !user ||
      user.passwordHash === null ||
      user.status === "disabled" ||
      !passwordValid
    ) {
      return Response.json({ error: INVALID_CREDENTIALS }, { status: 401 });
    }

    const expiresAt = deps.clock() + SESSION_MAX_AGE_MS;
    const token = signSession({ userId: user.id, role: user.role, expiresAt }, deps.secret);
    const cookieString = serializeSessionCookie(token, buildSessionCookieOptions());

    return Response.json({ ok: true }, {
      status: 200,
      headers: { "Set-Cookie": cookieString },
    });
  };
}

/**
 * Default POST handler — resolves secret at request time (never at import time)
 * so the module is safe to import even when RD_SYNC_AUTH_SECRET is not set.
 */
export async function POST(request: Request): Promise<Response> {
  const handler = createLoginHandler({
    users: defaultUserRepository,
    secret: getAuthSecret(),
    clock: () => Date.now(),
  });
  return handler(request);
}
