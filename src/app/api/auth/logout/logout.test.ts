/**
 * Tests for createLogoutHandler factory.
 */

import { describe, it, expect } from "vitest";
import { createLogoutHandler } from "./route";
import { SESSION_COOKIE_NAME } from "../../../../modules/auth/cookie";

describe("createLogoutHandler", () => {
  it("returns 200 status", async () => {
    const handler = createLogoutHandler();
    const req = new Request("http://localhost/api/auth/logout", { method: "POST" });
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  it("sets Set-Cookie header with Max-Age=0 to clear the session", async () => {
    const handler = createLogoutHandler();
    const req = new Request("http://localhost/api/auth/logout", { method: "POST" });
    const res = await handler(req);
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).toContain(SESSION_COOKIE_NAME);
    expect(cookie).toContain("Max-Age=0");
  });

  it("response body contains { ok: true }", async () => {
    const handler = createLogoutHandler();
    const req = new Request("http://localhost/api/auth/logout", { method: "POST" });
    const res = await handler(req);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
