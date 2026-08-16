import { createHash } from "node:crypto";

import { createAuditEvent, type AuditSink } from "../modules/audit";
import { BANK_SESSION_ACTIONS } from "../modules/audit/bank-actions";

const RETIRED_REASON = "legacy_expiry_publication_retired";
const RETIRED_TARGET = "bank_session_expiry_publication";
const ENVELOPE_KEYS = ["bankCode", "expiredEventId", "runId", "token"] as const;

interface LegacyExpiryPublicationEnvelope {
  bankCode: string;
  expiredEventId: string;
  runId: string;
  token: string;
}

export interface RetiredExpiryPublicationConsumerDependencies {
  auditSink: Pick<AuditSink, "record">;
}

export function createRetiredExpiryPublicationConsumer(dependencies: RetiredExpiryPublicationConsumerDependencies) {
  return async function consumeRetiredExpiryPublicationJob(data: unknown): Promise<{ status: "acknowledged" }> {
    const envelope = parseLegacyExpiryPublicationEnvelope(data);
    const hash = canonicalEnvelopeHash(envelope);
    await dependencies.auditSink.record(createAuditEvent({
      id: `${RETIRED_REASON}:${hash}`,
      actorId: "system:ingestion-worker",
      actorRole: null,
      action: BANK_SESSION_ACTIONS.LEGACY_EXPIRY_PUBLICATION_RETIRED,
      target: RETIRED_TARGET,
      metadata: {
        bankCode: envelope.bankCode,
        expiredEventId: envelope.expiredEventId,
        runId: envelope.runId,
        reason: RETIRED_REASON,
        outcome: "acknowledged",
      },
    }));
    return { status: "acknowledged" };
  };
}

function parseLegacyExpiryPublicationEnvelope(data: unknown): LegacyExpiryPublicationEnvelope {
  if (typeof data !== "object" || data === null || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) {
    throw new Error("Invalid expiry publication queue hint");
  }

  const descriptors = Object.getOwnPropertyDescriptors(data);
  if (Object.getOwnPropertySymbols(data).length !== 0 || Object.keys(descriptors).length !== ENVELOPE_KEYS.length) {
    throw new Error("Invalid expiry publication queue hint");
  }

  for (const key of ENVELOPE_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string" || !descriptor.value.trim()) {
      throw new Error("Invalid expiry publication queue hint");
    }
  }

  return {
    bankCode: descriptors.bankCode.value as string,
    expiredEventId: descriptors.expiredEventId.value as string,
    runId: descriptors.runId.value as string,
    token: descriptors.token.value as string,
  };
}

function canonicalEnvelopeHash(envelope: LegacyExpiryPublicationEnvelope): string {
  return createHash("sha256")
    .update(JSON.stringify([envelope.bankCode, envelope.expiredEventId, envelope.runId, envelope.token]))
    .digest("hex");
}
