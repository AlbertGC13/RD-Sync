import { describe, expect, it } from "vitest";

import { sanitizeNextParam } from "./next-redirect-sanitizer";

describe("sanitizeNextParam", () => {
  it("passes through a plain relative path", () => {
    expect(sanitizeNextParam("/x")).toBe("/x");
  });

  it("passes through a relative path with query string", () => {
    expect(sanitizeNextParam("/a?b=1")).toBe("/a?b=1");
  });

  it("passes through a nested relative path", () => {
    expect(sanitizeNextParam("/admin/audit")).toBe("/admin/audit");
  });

  it("blocks protocol-relative URLs starting with //", () => {
    expect(sanitizeNextParam("//evil.com")).toBe("/");
  });

  it("blocks absolute https URLs", () => {
    expect(sanitizeNextParam("https://evil.com")).toBe("/");
  });

  it("blocks absolute http URLs", () => {
    expect(sanitizeNextParam("http://evil.com/path")).toBe("/");
  });

  it("blocks javascript: URIs", () => {
    expect(sanitizeNextParam("javascript:alert(1)")).toBe("/");
  });

  it("blocks data: URIs", () => {
    expect(sanitizeNextParam("data:text/html,evil")).toBe("/");
  });

  it("defaults to / for undefined", () => {
    expect(sanitizeNextParam(undefined)).toBe("/");
  });

  it("defaults to / for null", () => {
    expect(sanitizeNextParam(null)).toBe("/");
  });

  it("defaults to / for empty string", () => {
    expect(sanitizeNextParam("")).toBe("/");
  });

  it("blocks values that do not start with /", () => {
    expect(sanitizeNextParam("evil.com/path")).toBe("/");
  });
});
