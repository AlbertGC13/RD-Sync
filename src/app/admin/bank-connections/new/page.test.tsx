import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NewBankConnectionShell } from "./page";

const admin = { id: "admin-1", role: "admin" } as const;
const viewer = { id: "viewer-1", role: "viewer" } as const;

describe("NewBankConnectionShell", () => {
  it("shows the Popular-first connection setup shell for admins", () => {
    const html = renderToStaticMarkup(<NewBankConnectionShell principal={admin} />);

    [
      "Nueva conexión bancaria",
      "Banco Popular",
      "0000000000",
      "Búsqueda por fecha del día actual",
      "Continuar a configuración de sesión",
    ].forEach((text) => expect(html).toContain(text));
    ["password=", "cookie=", "token="].forEach((text) => expect(html).not.toContain(text));
  });

  it("denies viewers before showing bank setup fields", () => {
    const html = renderToStaticMarkup(<NewBankConnectionShell principal={viewer} />);

    expect(html).toContain("Acceso de administrador requerido");
    ["0000000000", "Continuar a configuración de sesión", "Token", "MFA"].forEach((text) => expect(html).not.toContain(text));
  });
});
