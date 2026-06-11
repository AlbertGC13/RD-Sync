import nodemailer from "nodemailer";

import type { AdminAlertSink } from "../queues";
import { redactDiagnosticText } from "../scraper";

// ---------------------------------------------------------------------------
// EmailTransport — thin abstraction over any mail delivery mechanism
// ---------------------------------------------------------------------------

export interface EmailTransport {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// createEmailAlertSink — core sink implementation
// ---------------------------------------------------------------------------

export function createEmailAlertSink(options: {
  transport: EmailTransport;
  recipient: string;
}): AdminAlertSink {
  return {
    async notifyIngestionAttention(event) {
      const { runId, bankId, status, safeErrorSummary } = event;
      const redactedSummary = redactDiagnosticText(safeErrorSummary);

      const subject = `[RD-Sync] Scrape run ${status}: ${runId}`;
      const text = [
        `RD-Sync ingestion alert`,
        ``,
        `Run ID : ${runId}`,
        `Bank   : ${bankId}`,
        `Status : ${status}`,
        `Summary: ${redactedSummary}`,
        ``,
        `Review at /admin/scrape-runs`,
      ].join("\n");

      try {
        await options.transport.send({ to: options.recipient, subject, text });
      } catch {
        // Transport failures must never propagate — the processor must keep running.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// createConsoleAlertTransport — dev/local fallback
// ---------------------------------------------------------------------------

export function createConsoleAlertTransport(): EmailTransport {
  return {
    async send(message) {
      console.warn(`[RD-Sync alert] to=${message.to} | subject=${message.subject} | ${message.text}`);
    },
  };
}

// ---------------------------------------------------------------------------
// createNodemailerTransport — production SMTP transport
// ---------------------------------------------------------------------------

export function createNodemailerTransport(
  smtpUrl: string,
  // Injectable for testing; defaults to nodemailer.createTransport.
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport,
): EmailTransport {
  const transporter = createTransport(smtpUrl);
  return {
    async send(message) {
      await transporter.sendMail({ to: message.to, subject: message.subject, text: message.text });
    },
  };
}

// ---------------------------------------------------------------------------
// resolveDefaultAlertSink — reads env vars, never throws at module load
// ---------------------------------------------------------------------------

export function resolveDefaultAlertSink(): AdminAlertSink {
  const smtpUrl = process.env.RD_SYNC_ALERT_SMTP_URL;
  const adminEmail = process.env.RD_SYNC_ADMIN_EMAIL;

  if (smtpUrl && adminEmail) {
    return createEmailAlertSink({
      transport: createNodemailerTransport(smtpUrl),
      recipient: adminEmail,
    });
  }

  return createEmailAlertSink({
    transport: createConsoleAlertTransport(),
    recipient: "admin@localhost",
  });
}
