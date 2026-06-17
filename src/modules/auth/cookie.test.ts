import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_COOKIE_NAME,
  buildSessionCookieOptions,
  parseSessionCookie,
  readSessionTokenFromHeaders,
  serializeClearSessionCookie,
  serializeSessionCookie,
} from "./cookie";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session cookie helpers", () => {
  it("parses the session token from a cookie header among others", () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=abc.def; other=1`;
    expect(parseSessionCookie(header)).toBe("abc.def");
  });

  it("returns null when the session cookie is absent", () => {
    expect(parseSessionCookie("theme=dark; other=1")).toBeNull();
    expect(parseSessionCookie("")).toBeNull();
  });

  it("reads the token from a Headers object", () => {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=token123` });
    expect(readSessionTokenFromHeaders(headers)).toBe("token123");
    expect(readSessionTokenFromHeaders(new Headers())).toBeNull();
  });

  it("builds secure cookie options in production and insecure in dev", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(buildSessionCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    vi.stubEnv("NODE_ENV", "development");
    expect(buildSessionCookieOptions().secure).toBe(false);
  });

  it("serializes a Set-Cookie value with the security attributes", () => {
    const out = serializeSessionCookie("tok", buildSessionCookieOptions({ secure: true, maxAge: 100 }));
    expect(out).toContain(`${SESSION_COOKIE_NAME}=tok`);
    expect(out).toContain("HttpOnly");
    expect(out).toContain("Secure");
    expect(out).toContain("SameSite=lax");
    expect(out).toContain("Max-Age=100");
    expect(out).toContain("Path=/");
  });

  it("serializes a clearing cookie with Max-Age=0", () => {
    const out = serializeClearSessionCookie();
    expect(out).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(out).toContain("Max-Age=0");
    expect(out).toContain("HttpOnly");
  });
});
