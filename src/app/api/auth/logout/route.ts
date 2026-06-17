/**
 * Logout route handler.
 *
 * POST /api/auth/logout
 *
 * Clears the session cookie by setting Max-Age=0.
 * No authentication required — clearing an invalid cookie is harmless.
 */

import { serializeClearSessionCookie } from "../../../../modules/auth/cookie";

export function createLogoutHandler() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return async function POST(_request?: Request): Promise<Response> {
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": serializeClearSessionCookie() } },
    );
  };
}

export const POST = createLogoutHandler();
