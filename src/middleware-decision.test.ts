import { describe, expect, it } from "vitest";

import { decideMiddleware } from "./middleware-decision";

describe("decideMiddleware", () => {
  // --- Unauthenticated protected pages → redirect ---

  it("redirects unauthenticated requests to /admin to /login?next=...", () => {
    const result = decideMiddleware({ pathname: "/admin", hasSessionCookie: false });
    expect(result).toEqual({ type: "redirect", location: "/login?next=%2Fadmin" });
  });

  it("redirects unauthenticated requests to /admin/audit to /login?next=...", () => {
    const result = decideMiddleware({ pathname: "/admin/audit", hasSessionCookie: false });
    expect(result).toEqual({ type: "redirect", location: "/login?next=%2Fadmin%2Faudit" });
  });

  it("redirects unauthenticated requests to /transactions to /login?next=...", () => {
    const result = decideMiddleware({ pathname: "/transactions", hasSessionCookie: false });
    expect(result).toEqual({ type: "redirect", location: "/login?next=%2Ftransactions" });
  });

  it("redirects unauthenticated requests to /transactions/anything to /login?next=...", () => {
    const result = decideMiddleware({ pathname: "/transactions/detail", hasSessionCookie: false });
    expect(result).toEqual({
      type: "redirect",
      location: "/login?next=%2Ftransactions%2Fdetail",
    });
  });

  // --- Unauthenticated protected APIs → 401 ---

  it("returns 401 for unauthenticated /api/scrape-runs", () => {
    const result = decideMiddleware({ pathname: "/api/scrape-runs/run-now", hasSessionCookie: false });
    expect(result).toEqual({ type: "json401" });
  });

  it("returns 401 for unauthenticated /api/transactions", () => {
    const result = decideMiddleware({ pathname: "/api/transactions", hasSessionCookie: false });
    expect(result).toEqual({ type: "json401" });
  });

  it("returns 401 for unauthenticated /api/bank-sessions/status", () => {
    const result = decideMiddleware({ pathname: "/api/bank-sessions/status", hasSessionCookie: false });
    expect(result).toEqual({ type: "json401" });
  });

  // --- Public routes → next ---

  it("lets /login through without a session cookie", () => {
    const result = decideMiddleware({ pathname: "/login", hasSessionCookie: false });
    expect(result).toEqual({ type: "next" });
  });

  it("lets /api/auth/login through without a session cookie", () => {
    const result = decideMiddleware({ pathname: "/api/auth/login", hasSessionCookie: false });
    expect(result).toEqual({ type: "next" });
  });

  it("lets /api/auth/logout through without a session cookie", () => {
    const result = decideMiddleware({ pathname: "/api/auth/logout", hasSessionCookie: false });
    expect(result).toEqual({ type: "next" });
  });

  it("lets / (root) through without a session cookie", () => {
    const result = decideMiddleware({ pathname: "/", hasSessionCookie: false });
    expect(result).toEqual({ type: "next" });
  });

  // --- Authenticated requests → always next ---

  it("lets authenticated requests to /admin through", () => {
    const result = decideMiddleware({ pathname: "/admin", hasSessionCookie: true });
    expect(result).toEqual({ type: "next" });
  });

  it("lets authenticated requests to /api/scrape-runs through", () => {
    const result = decideMiddleware({ pathname: "/api/scrape-runs/run-now", hasSessionCookie: true });
    expect(result).toEqual({ type: "next" });
  });

  it("lets authenticated requests to /transactions through", () => {
    const result = decideMiddleware({ pathname: "/transactions", hasSessionCookie: true });
    expect(result).toEqual({ type: "next" });
  });

  // --- Static and Next.js internals → next ---

  it("lets /_next/static paths through", () => {
    const result = decideMiddleware({ pathname: "/_next/static/chunk.js", hasSessionCookie: false });
    expect(result).toEqual({ type: "next" });
  });

  it("lets /favicon.ico through", () => {
    const result = decideMiddleware({ pathname: "/favicon.ico", hasSessionCookie: false });
    expect(result).toEqual({ type: "next" });
  });
});
