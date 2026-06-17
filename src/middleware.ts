/**
 * Next.js Edge Middleware — presence-check only.
 *
 * This file runs on the Edge runtime. It MUST NOT import node:crypto or any
 * Node-only module. Cryptographic verification happens server-side in layouts
 * and route handlers (the real security boundary).
 *
 * Decision logic lives in middleware-decision.ts so it can be unit-tested
 * without the Next.js runtime.
 */

import { type NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME } from "./modules/auth/cookie";
import { decideMiddleware } from "./middleware-decision";

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);

  const decision = decideMiddleware({ pathname, hasSessionCookie });

  switch (decision.type) {
    case "next":
      return NextResponse.next();

    case "redirect": {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = `next=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(url);
    }

    case "json401":
      return new NextResponse(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
  }
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public assets (svg, png, jpg, jpeg, gif, webp)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
