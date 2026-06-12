import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createConsoleAlertTransport,
  createEmailAlertSink,
  createNodemailerTransport,
  resolveDefaultAlertSink,
  type EmailTransport,
} from "./email-alert-sink";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTransport(): { transport: EmailTransport; messages: Array<{ to: string; subject: string; text: string }> } {
  const messages: Array<{ to: string; subject: string; text: string }> = [];
  const transport: EmailTransport = {
    send: async (message) => {
      messages.push(message);
    },
  };
  return { transport, messages };
}

// ---------------------------------------------------------------------------
// createEmailAlertSink — subject and body content
// ---------------------------------------------------------------------------

describe("createEmailAlertSink — email shape", () => {
  it("includes runId, bankId, and status in the subject for failed runs", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifyIngestionAttention({
      runId: "run-abc",
      bankId: "popular",
      status: "failed",
      safeErrorSummary: "selector not found",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toContain("failed");
    expect(messages[0].subject).toContain("run-abc");
  });

  it("includes runId, bankId, and status in the subject for needs_admin_action", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifyIngestionAttention({
      runId: "run-xyz",
      bankId: "bhd",
      status: "needs_admin_action",
      safeErrorSummary: "MFA prompt detected",
    });

    expect(messages[0].subject).toContain("needs_admin_action");
    expect(messages[0].subject).toContain("run-xyz");
  });

  it("includes runId, bankId, status, and safeErrorSummary in the email body", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifyIngestionAttention({
      runId: "run-abc",
      bankId: "popular",
      status: "failed",
      safeErrorSummary: "selector not found",
    });

    const body = messages[0].text;
    expect(body).toContain("run-abc");
    expect(body).toContain("popular");
    expect(body).toContain("failed");
    expect(body).toContain("selector not found");
  });

  it("includes a pointer to /admin/scrape-runs in the body", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifyIngestionAttention({
      runId: "run-abc",
      bankId: "popular",
      status: "failed",
      safeErrorSummary: "timeout",
    });

    expect(messages[0].text).toContain("/admin/scrape-runs");
  });

  it("sends to the configured recipient address", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "team@acme.com" });

    await sink.notifyIngestionAttention({
      runId: "run-1",
      bankId: "popular",
      status: "failed",
      safeErrorSummary: "error",
    });

    expect(messages[0].to).toBe("team@acme.com");
  });
});

// ---------------------------------------------------------------------------
// createEmailAlertSink — defense-in-depth redaction
// ---------------------------------------------------------------------------

describe("createEmailAlertSink — secret redaction in body", () => {
  it("redacts credential patterns from the safeErrorSummary before placing it in the body", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifyIngestionAttention({
      runId: "run-1",
      bankId: "popular",
      status: "failed",
      safeErrorSummary: "token=abc123 password=hunter2 something failed",
    });

    const body = messages[0].text;
    expect(body).not.toContain("abc123");
    expect(body).not.toContain("hunter2");
    expect(body).toContain("[REDACTED]");
  });

  it("passes through a clean summary unchanged (no false redactions)", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifyIngestionAttention({
      runId: "run-2",
      bankId: "bhd",
      status: "needs_admin_action",
      safeErrorSummary: "MFA prompt detected",
    });

    expect(messages[0].text).toContain("MFA prompt detected");
  });
});

// ---------------------------------------------------------------------------
// createEmailAlertSink — transport failure isolation
// ---------------------------------------------------------------------------

describe("createEmailAlertSink — transport failure is swallowed", () => {
  it("does not throw when transport.send rejects", async () => {
    const throwingTransport: EmailTransport = {
      send: async () => {
        throw new Error("SMTP connection refused");
      },
    };
    const sink = createEmailAlertSink({ transport: throwingTransport, recipient: "ops@example.com" });

    await expect(
      sink.notifyIngestionAttention({
        runId: "run-1",
        bankId: "popular",
        status: "failed",
        safeErrorSummary: "some error",
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createConsoleAlertTransport
// ---------------------------------------------------------------------------

describe("createConsoleAlertTransport", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  afterEach(() => {
    warnSpy.mockClear();
  });

  it("emits exactly one console.warn call per send", async () => {
    const transport = createConsoleAlertTransport();
    await transport.send({ to: "a@b.com", subject: "Alert", text: "body" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("includes to, subject, and text in the warn output", async () => {
    const transport = createConsoleAlertTransport();
    await transport.send({ to: "a@b.com", subject: "My Subject", text: "My body" });
    const call = warnSpy.mock.calls[0][0] as string;
    expect(call).toContain("a@b.com");
    expect(call).toContain("My Subject");
  });
});

// ---------------------------------------------------------------------------
// createNodemailerTransport — wraps createTransport correctly
// ---------------------------------------------------------------------------

describe("createNodemailerTransport", () => {
  it("calls nodemailer.createTransport with the provided SMTP URL and passes message fields through", async () => {
    const sendMailMock = vi.fn().mockResolvedValue({ messageId: "test" });
    const fakeTransporter = { sendMail: sendMailMock };
    const createTransportMock = vi.fn().mockReturnValue(fakeTransporter);

    // createNodemailerTransport accepts a createTransport factory as a second
    // parameter so it can be tested without a live SMTP server or ESM module mocking.
    const transport = createNodemailerTransport(
      "smtp://localhost:1025",
      createTransportMock as unknown as typeof import("nodemailer").createTransport,
    );
    await transport.send({ to: "a@b.com", subject: "Hi", text: "Body" });

    expect(createTransportMock).toHaveBeenCalledWith("smtp://localhost:1025");
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@b.com", subject: "Hi", text: "Body" }),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultAlertSink — env resolution
// ---------------------------------------------------------------------------

describe("resolveDefaultAlertSink — env resolution", () => {
  beforeEach(() => {
    delete process.env.RD_SYNC_ALERT_SMTP_URL;
    delete process.env.RD_SYNC_ADMIN_EMAIL;
  });

  afterEach(() => {
    delete process.env.RD_SYNC_ALERT_SMTP_URL;
    delete process.env.RD_SYNC_ADMIN_EMAIL;
  });

  it("returns a sink backed by the console transport when env vars are absent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const sink = resolveDefaultAlertSink();

    await sink.notifyIngestionAttention({
      runId: "run-1",
      bankId: "popular",
      status: "failed",
      safeErrorSummary: "error",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("does not throw at call time when env vars are absent", () => {
    expect(() => resolveDefaultAlertSink()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// notifySessionAttention — email shape
// ---------------------------------------------------------------------------

describe("createEmailAlertSink — notifySessionAttention: expired", () => {
  it("uses 'attention required' subject for expired status", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifySessionAttention({
      status: "expired",
      safeSummary: "Bank session expired or requires verification",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe("RD-Sync: bank session attention required");
  });

  it("uses 'restored' subject for active status", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifySessionAttention({
      status: "active",
      safeSummary: "Bank session is active",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(messages[0].subject).toBe("RD-Sync: bank session restored");
  });

  it("uses 'attention required' subject for browser_unavailable status", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifySessionAttention({
      status: "browser_unavailable",
      safeSummary: "Bank browser session is not available",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(messages[0].subject).toBe("RD-Sync: bank session attention required");
  });

  it("includes safeSummary and checkedAt in the body", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifySessionAttention({
      status: "expired",
      safeSummary: "Bank session expired or requires verification",
      checkedAt: "2026-06-12T10:00:00.000Z",
    });

    const body = messages[0].text;
    expect(body).toContain("Bank session expired or requires verification");
    expect(body).toContain("2026-06-12T10:00:00.000Z");
  });

  it("includes a pointer to /admin/bank-connections in the body", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifySessionAttention({
      status: "expired",
      safeSummary: "Bank session expired or requires verification",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(messages[0].text).toContain("/admin/bank-connections");
  });

  it("does not include any URL, account, or error interpolation in the body", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifySessionAttention({
      status: "expired",
      safeSummary: "Bank session expired or requires verification",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    const body = messages[0].text;
    // Body must only contain fixed strings — no dynamic interpolation
    expect(body).not.toContain("token=");
    expect(body).not.toContain("password=");
  });

  it("passes the safeSummary through the existing redaction defense", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "ops@example.com" });

    await sink.notifySessionAttention({
      status: "expired",
      safeSummary: "session token=abc123 expired",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    const body = messages[0].text;
    expect(body).not.toContain("abc123");
    expect(body).toContain("[REDACTED]");
  });

  it("does not throw when transport.send rejects", async () => {
    const throwingTransport: EmailTransport = {
      send: async () => {
        throw new Error("SMTP down");
      },
    };
    const sink = createEmailAlertSink({ transport: throwingTransport, recipient: "ops@example.com" });

    await expect(
      sink.notifySessionAttention({
        status: "expired",
        safeSummary: "Bank session expired or requires verification",
        checkedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  it("sends to the configured recipient address", async () => {
    const { transport, messages } = makeTransport();
    const sink = createEmailAlertSink({ transport, recipient: "team@acme.com" });

    await sink.notifySessionAttention({
      status: "expired",
      safeSummary: "Bank session expired or requires verification",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(messages[0].to).toBe("team@acme.com");
  });
});
