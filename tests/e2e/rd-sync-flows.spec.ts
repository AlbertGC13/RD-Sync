import { expect, test } from "@playwright/test";

const viewerHeaders = {
  "x-rd-sync-user-id": "viewer-e2e",
  "x-rd-sync-role": "viewer",
};

const reviewerHeaders = {
  "x-rd-sync-user-id": "reviewer-e2e",
  "x-rd-sync-role": "reviewer",
};

const adminHeaders = {
  "x-rd-sync-user-id": "admin-e2e",
  "x-rd-sync-role": "admin",
};

test.describe("RD-Sync MVP flows", () => {
  test("viewer sees an employee-safe transactions dashboard", async ({ page }) => {
    await page.goto("/transactions?bankId=popular&query=factura");

    await expect(page.getByRole("heading", { name: "Transacciones recientes", exact: true })).toBeVisible();
    await expect(page.getByRole("form", { name: "Filtros de transacciones" })).toBeVisible();
    await expect(page.getByText("No hay transacciones recientes disponibles")).toBeVisible();
    await expect(page.getByText("Operaciones de extracción")).toHaveCount(0);
    await expect(page.getByText("Gestión de MFA / sesión")).toHaveCount(0);
  });

  test("unauthorized callers are denied transaction data", async ({ request }) => {
    const response = await request.get("/api/transactions");

    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  test("viewer cannot update transaction review state", async ({ request }) => {
    const response = await request.patch("/api/transactions/tx-e2e-review/review", {
      headers: viewerHeaders,
      data: { reviewState: "seen" },
    });

    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "Role viewer is not allowed" });
  });

  test("reviewer marks a fixture transaction as seen", async ({ request }) => {
    const response = await request.patch("/api/transactions/tx-e2e-review/review", {
      headers: reviewerHeaders,
      data: { reviewState: "seen" },
    });

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      transaction: expect.objectContaining({
        id: "tx-e2e-review",
        reviewState: "seen",
      }),
    });
  });

  test("admin sees the MFA/session intervention path", async ({ browser }) => {
    const context = await browser.newContext({ extraHTTPHeaders: adminHeaders });
    const page = await context.newPage();

    await page.goto("/admin/scrape-runs");

    await expect(page.getByRole("heading", { name: "Operaciones de extracción" })).toBeVisible();
    await expect(page.getByText("Intervención administrativa requerida")).toBeVisible();
    await expect(page.getByText("Reanuda solo después de que un administrador complete la renovación de sesión.")).toBeVisible();
    await expect(page.getByText("Confirma que la alerta no contenga credenciales, cookies ni datos crudos de sesión bancaria.")).toBeVisible();
    await expect(page.getByText("session-token=")).toHaveCount(0);

    await context.close();
  });
});
