import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NewBankConnectionShell } from "./page";

const admin = { id: "admin-1", role: "admin" } as const;
const viewer = { id: "viewer-1", role: "viewer" } as const;

describe("NewBankConnectionShell", () => {
  it("shows the Popular-first connection setup shell for admins", () => {
    const html = renderToStaticMarkup(<NewBankConnectionShell principal={admin} />);

    [
      "New bank connection",
      "Banco Popular",
      "0000000000",
      "Current-day date search",
      "Continue to session setup",
    ].forEach((text) => expect(html).toContain(text));
    ["password=", "cookie=", "token="].forEach((text) => expect(html).not.toContain(text));
  });

  it("denies viewers before showing bank setup fields", () => {
    const html = renderToStaticMarkup(<NewBankConnectionShell principal={viewer} />);

    expect(html).toContain("Admin access required");
    ["0000000000", "Continue to session setup", "Token", "MFA"].forEach((text) => expect(html).not.toContain(text));
  });
});
