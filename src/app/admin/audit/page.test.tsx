import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminAuditDashboard } from "./page";
import type { AuditEvent } from "../../../modules/audit";

const admin = { id: "admin-1", role: "admin" } as const;
const viewer = { id: "viewer-1", role: "viewer" } as const;

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "evt-1",
    actorId: "550e8400-e29b-41d4-a716-446655440000",
    actorRole: "admin",
    action: "auth.login",
    target: "session",
    targetId: null,
    metadata: { ip: "203.0.113.10", method: "password" },
    createdAt: new Date("2026-06-07T13:45:00.000Z"),
    ...overrides,
  };
}

describe("AdminAuditDashboard — accessibility (T7)", () => {
  it("marks every column header with scope=col for screen readers", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard principal={admin} events={[makeEvent()]} page={1} hasNext={false} />,
    );

    // Collect every <th ...> opening tag (excluding <thead>).
    const thMatches = html.match(/<th(?:\s[^>]*)?>/g) ?? [];
    expect(thMatches.length).toBeGreaterThanOrEqual(6);
    thMatches.forEach((th) => expect(th).toContain('scope="col"'));
  });

  it("renders a screen-reader caption describing the table", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard principal={admin} events={[makeEvent()]} page={1} hasNext={false} />,
    );

    expect(html).toContain("<caption");
    expect(html).toContain("Registro de auditoría");
  });

  it("marks the current page with aria-current=page", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard principal={admin} events={[makeEvent()]} page={2} hasNext={true} />,
    );

    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Página 2");
  });

  it("labels pagination controls in Spanish with aria-labels", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard principal={admin} events={[makeEvent()]} page={2} hasNext={true} />,
    );

    expect(html).toContain('aria-label="Página anterior"');
    expect(html).toContain('aria-label="Página siguiente"');
    expect(html).toContain("Anterior");
    expect(html).toContain("Siguiente");
  });

  it("announces page changes via an aria-live region", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard principal={admin} events={[makeEvent()]} page={1} hasNext={false} />,
    );

    expect(html).toContain('aria-live="polite"');
  });
});

describe("AdminAuditDashboard — content clarity (T8)", () => {
  it("shows a human-readable actor label instead of the raw UUID", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard principal={admin} events={[makeEvent()]} page={1} hasNext={false} />,
    );

    // Visible short label + ellipsised id; full id only in aria-label.
    expect(html).toContain("Administrador");
    expect(html).toContain("550e8400…");
    expect(html).toContain(
      'aria-label="Administrador, identificador 550e8400-e29b-41d4-a716-446655440000"',
    );
    // The raw full UUID must never be the primary visible text.
    expect(html).not.toContain(">550e8400-e29b-41d4-a716-446655440000<");
  });

  it("labels system-initiated events (null role) as Sistema", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard
        principal={admin}
        events={[makeEvent({ actorId: null, actorRole: null, action: "ingestion.run" })]}
        page={1}
        hasNext={false}
      />,
    );

    expect(html).toContain("Sistema");
  });

  it("maps the viewer role to a human-readable Empleado label", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard
        principal={admin}
        events={[makeEvent({ actorRole: "viewer", actorId: "viewer-abc12345" })]}
        page={1}
        hasNext={false}
      />,
    );

    expect(html).toContain("Empleado");
  });

  it("falls back to Desconocido for an unmapped actor role, never the raw enum", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard
        principal={admin}
        events={[
          makeEvent({
            // "guest" is an unmapped role enum; it must never reach operators.
            actorRole: "guest",
            actorId: "9b1dec0a-3c8e-4f2a-9d6b-1e5f7a8c2b40",
          }),
        ]}
        page={1}
        hasNext={false}
      />,
    );

    expect(html).toContain("Desconocido");
    // The raw enum string must never reach the operator.
    expect(html).not.toContain("guest");
    // Full id stays in aria-label for traceability.
    expect(html).toContain("9b1dec0a-3c8e-4f2a-9d6b-1e5f7a8c2b40");
  });

  it("renders metadata as a property count, never as raw JSON", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard principal={admin} events={[makeEvent()]} page={1} hasNext={false} />,
    );

    expect(html).toContain("2 propiedades");
    // No raw JSON serialization leaks to the operator.
    expect(html).not.toContain('{"ip":');
    expect(html).not.toContain('{"ip"');
    // No inaccessible title tooltip remains on the metadata cell.
    expect(html).not.toContain('title="{');
  });

  it("shows an em dash for empty metadata", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard
        principal={admin}
        events={[makeEvent({ metadata: null })]}
        page={1}
        hasNext={false}
      />,
    );

    expect(html).toContain("—");
  });
});

describe("AdminAuditDashboard — access control", () => {
  it("denies non-admin principals without rendering the audit table", () => {
    const html = renderToStaticMarkup(
      <AdminAuditDashboard principal={viewer} events={[makeEvent()]} page={1} hasNext={false} />,
    );

    expect(html).toContain("Admin access required");
    expect(html).not.toContain("Audit events");
    expect(html).not.toContain("550e8400");
  });
});
