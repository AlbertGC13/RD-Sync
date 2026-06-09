import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminBankConnectionsDashboard, popularBankConnection } from "./page";

const admin = { id: "admin-1", role: "admin" } as const;
const viewer = { id: "viewer-1", role: "viewer" } as const;

describe("AdminBankConnectionsDashboard", () => {
  it("lists the Banco Popular connection shell for admins", () => {
    const html = renderToStaticMarkup(
      <AdminBankConnectionsDashboard principal={admin} connections={[popularBankConnection]} />,
    );

    [
      "Bank connections",
      "Banco Popular",
      "817985690",
      "Corriente",
      "Session action required",
      'href="/admin/bank-connections/popular-817985690/session"',
    ].forEach((text) => expect(html).toContain(text));
    ["password=", "cookie=", "token="].forEach((text) => expect(html).not.toContain(text));
  });

  it("denies viewers without exposing account, session, token, or MFA details", () => {
    const html = renderToStaticMarkup(
      <AdminBankConnectionsDashboard principal={viewer} connections={[popularBankConnection]} />,
    );

    expect(html).toContain("Admin access required");
    ["817985690", "Renew session", "Token", "MFA"].forEach((text) => expect(html).not.toContain(text));
  });
});
