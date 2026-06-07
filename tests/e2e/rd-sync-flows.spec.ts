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

    await expect(page.getByRole("heading", { name: "Recent transactions", exact: true })).toBeVisible();
    await expect(page.getByRole("form", { name: "Transaction filters" })).toBeVisible();
    await expect(page.getByText("No recent transactions are available")).toBeVisible();
    await expect(page.getByText("Scrape run operations")).toHaveCount(0);
    await expect(page.getByText("MFA/session handling")).toHaveCount(0);
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

    await expect(page.getByRole("heading", { name: "Scrape run operations" })).toBeVisible();
    await expect(page.getByText("Admin intervention required")).toBeVisible();
    await expect(page.getByText("Resume only after session renewal is completed by an admin.")).toBeVisible();
    await expect(page.getByText("Confirm the alert contains no credentials, cookies, or raw bank session data.")).toBeVisible();
    await expect(page.getByText("session-token=")).toHaveCount(0);

    await context.close();
  });
});
