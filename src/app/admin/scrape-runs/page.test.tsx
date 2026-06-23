import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  default as AdminScrapeRunsPage,
  AdminScrapeRunsDashboard,
  summarizeScrapeRuns,
  type AdminScrapeRun,
} from "./page";
import { signSession } from "../../../modules/auth/session";

const TEST_SECRET = "test-secret-for-page-test";

function makeAdminToken() {
  return signSession(
    { userId: "admin-1", role: "admin", expiresAt: Date.now() + 86_400_000 },
    TEST_SECRET,
  );
}

// Mock next/headers: cookies() returns an admin session cookie.
// getCurrentPrincipal() will call getAuthSecret() then verifySession().
vi.mock("next/headers", () => ({
  headers: vi.fn(),
  cookies: vi.fn().mockImplementation(async () => ({
    get: (name: string) =>
      name === "rd_sync_session" ? { value: makeAdminToken() } : undefined,
  })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/admin/scrape-runs",
}));

const runs: AdminScrapeRun[] = [
  {
    id: "run-1",
    bankId: "popular",
    status: "needs_admin_action",
    startedAt: "2026-06-07T13:45:00.000Z",
    endedAt: "2026-06-07T13:46:00.000Z",
    insertedCount: 0,
    skippedCount: 0,
    safeErrorSummary: "La sesión bancaria requiere acción MFA del administrador",
  },
  {
    id: "run-2",
    bankId: "banreservas",
    status: "succeeded",
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:02:00.000Z",
    insertedCount: 12,
    skippedCount: 3,
    safeErrorSummary: null,
  },
  {
    id: "run-3",
    bankId: "bhd",
    status: "failed",
    startedAt: "2026-06-07T11:00:00.000Z",
    endedAt: "2026-06-07T11:01:00.000Z",
    insertedCount: 0,
    skippedCount: 0,
    safeErrorSummary: "Selector de tabla de transacciones no encontrado",
  },
];

describe("AdminScrapeRunsDashboard", () => {
  it("does not render hard-coded preview runs from the page when local preview is disabled", async () => {
    const previousSecret = process.env.RD_SYNC_AUTH_SECRET;
    const previousPreview = process.env.RD_SYNC_DEV_PREVIEW;

    try {
      // Provide the auth secret so getCurrentPrincipal can verify the cookie.
      process.env.RD_SYNC_AUTH_SECRET = TEST_SECRET;
      delete process.env.RD_SYNC_DEV_PREVIEW;

      const html = renderToStaticMarkup(await AdminScrapeRunsPage());

      expect(html).toContain("Aún no se registran corridas de extracción");
      expect(html).not.toContain("La sesión bancaria requiere acción MFA del administrador");
      expect(html).not.toContain("preview-run-");
    } finally {
      if (previousSecret === undefined) {
        delete process.env.RD_SYNC_AUTH_SECRET;
      } else {
        process.env.RD_SYNC_AUTH_SECRET = previousSecret;
      }
      if (previousPreview === undefined) {
        delete process.env.RD_SYNC_DEV_PREVIEW;
      } else {
        process.env.RD_SYNC_DEV_PREVIEW = previousPreview;
      }
    }
  });

  it("renders operational health and admin intervention guidance for admins in Spanish", () => {
    const html = renderToStaticMarkup(
      <AdminScrapeRunsDashboard principal={{ id: "admin-1", role: "admin" }} runs={runs} />,
    );

    // Spanish visible contracts (operator-facing copy for Dominican banking staff):
    expect(html).toContain("Operaciones de extracción");
    expect(html).toContain("Necesita acción admin");
    expect(html).toContain("Intervención administrativa requerida");
    expect(html).toContain("Reanuda solo después de que un administrador complete la renovación de sesión.");
    expect(html).toContain("Banreservas");
    expect(html).toContain("12 insertadas");
    // The needs-admin-action run's safe summary is rendered (Spanish fixture).
    expect(html).toContain("La sesión bancaria requiere acción MFA del administrador");
    // Negative guarantees: no secrets in the rendered HTML.
    expect(html).not.toContain("token=");
    expect(html).not.toContain("password=");
  });

  it("denies non-admin users with a Spanish denial page and without leaking run details", () => {
    const html = renderToStaticMarkup(
      <AdminScrapeRunsDashboard principal={{ id: "viewer-1", role: "viewer" }} runs={runs} />,
    );

    expect(html).toContain("Acceso administrativo requerido");
    expect(html).toContain("Solo los administradores pueden ver la salud de la extracción o gestionar la intervención de MFA/sesión.");
    expect(html).not.toContain("La sesión bancaria requiere acción MFA del administrador");
    expect(html).not.toContain("Reanuda solo después");
  });

  it("summarizes failed, succeeded, and attention-needed runs", () => {
    expect(summarizeScrapeRuns(runs)).toEqual({
      total: 3,
      succeeded: 1,
      failed: 1,
      needsAdminAction: 1,
      inserted: 12,
      skipped: 3,
    });
  });

  it("renders an honest empty state when no real scrape runs are recorded", () => {
    const html = renderToStaticMarkup(
      <AdminScrapeRunsDashboard principal={{ id: "admin-1", role: "admin" }} runs={[]} />,
    );

    expect(html).toContain("Aún no se registran corridas de extracción");
    expect(html).toContain("Cuando se conecte una cuenta bancaria y el planificador esté activo, las corridas aparecerán aquí.");
    expect(html).not.toContain("La sesión bancaria requiere acción MFA del administrador");
  });

  it("exposes FR-012 affordances with run-now active and session actions deferred", () => {
    const html = renderToStaticMarkup(
      <AdminScrapeRunsDashboard principal={{ id: "admin-1", role: "admin" }} runs={runs} />,
    );

    expect(html).toContain("Ejecutar ahora");
    expect(html).toContain("Desactivar conexión");
    expect(html).toContain("Renovar sesión");
    expect(html).toContain('aria-label="Acciones de corrida"');
    expect(html).toContain('aria-label="Programar una nueva corrida de extracción ahora"');
    expect(html).toContain('aria-disabled="true"');
  });

  it("denies admin scrape-runs access when only a query-param preview flag is provided (no real admin principal)", () => {
    // Behaviour test for blocker C — proves that query-param-based preview
    // admin access is denied by the dashboard, matching the API surface.
    // A null principal simulates the "no cookie, no headers, no proxy trust"
    // case that an attacker probing ?previewRole=admin would land on.
    const html = renderToStaticMarkup(
      <AdminScrapeRunsDashboard principal={null} runs={[]} />,
    );

    // Denial page is rendered for unauthenticated callers.
    expect(html).toContain("Acceso administrativo requerido");
    // Run operations and any operator data must NOT leak.
    expect(html).not.toContain("Operaciones de extracción");
    expect(html).not.toContain("La sesión bancaria requiere acción MFA del administrador");
    expect(html).not.toContain("Reanuda solo después");
  });

  it("disables the page-level Run Now button when an active Popular run exists", () => {
    const activeRuns: AdminScrapeRun[] = [
      { ...runs[0], id: "run-active", status: "running" },
    ];
    const html = renderToStaticMarkup(
      <AdminScrapeRunsDashboard principal={{ id: "admin-1", role: "admin" }} runs={activeRuns} />,
    );

    // The page-level button must render disabled so operators cannot
    // schedule a duplicate concurrent run for the same bank.
    const runNowButton = html.match(/<button[^>]*>Ejecutar ahora<\/button>/)?.[0];
    expect(runNowButton).toBeDefined();
    expect(runNowButton).toContain('disabled=""');
  });
});
