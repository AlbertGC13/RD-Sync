import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BankSessionShell } from "./page";

const admin = { id: "admin-1", role: "admin" } as const;
const viewer = { id: "viewer-1", role: "viewer" } as const;

describe("BankSessionShell", () => {
  it("explains the admin-only physical token boundary for Popular sessions", () => {
    const html = renderToStaticMarkup(
      <BankSessionShell connectionId="popular-0000000000" principal={admin} />,
    );

    [
      "Popular session setup",
      "0000000000",
      "Token entry is admin-only",
      "Physical token device",
      "needs_admin_action",
    ].forEach((text) => expect(html).toContain(text));
    ["password=", "cookie=", "token="].forEach((text) => expect(html).not.toContain(text));
  });

  it("denies viewers without showing account or token instructions", () => {
    const html = renderToStaticMarkup(
      <BankSessionShell connectionId="popular-0000000000" principal={viewer} />,
    );

    expect(html).toContain("Admin access required");
    ["0000000000", "Token entry is admin-only", "Physical token device", "MFA"].forEach((text) => expect(html).not.toContain(text));
  });
});
