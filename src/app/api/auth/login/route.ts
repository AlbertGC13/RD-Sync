/**
 * Login route handler.
 *
 * POST /api/auth/login
 *
 * Accepts JSON { email: string; password: string }.
 * Returns 200 + Set-Cookie on success, 401 with generic error on any failure.
 * NEVER reveals whether the email exists (no user enumeration).
 * NEVER logs passwords or tokens.
 */

import type { UserRepository } from "../../../../modules/auth/user-repository";
import { verifyPassword } from "../../../../modules/auth/password";
import { signSession } from "../../../../modules/auth/session";
import {
  serializeSessionCookie,
  buildSessionCookieOptions,
  SESSION_MAX_AGE_MS,
} from "../../../../modules/auth/cookie";
import { getAuthSecret } from "../../../../modules/auth/index";
import { defaultUserRepository } from "../defaults";

const INVALID_CREDENTIALS = "Invalid email or password";

export interface LoginHandlerDeps {
  users: UserRepository;
  secret: string;
  clock: () => number;
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

    if (
      !user ||
      user.passwordHash === null ||
      user.status === "disabled" ||
      !verifyPassword(password, user.passwordHash)
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
