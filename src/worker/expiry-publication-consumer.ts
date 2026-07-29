import { createHash } from "node:crypto";
import {
  reserveExpiryPublicationConsumerClaim,
  type ExpiryPublicationPreClaimGate,
} from "../modules/bank-sessions/expiry-publication-consumer";
import type {
  BankSessionExpiryEpisodeRepository,
  ExpiryPublicationEnvelope,
} from "../modules/bank-sessions/expiry-episodes";
import type { IngestionJob, IngestionResult } from "./queues";

export interface ExpiryPublicationConsumerDependencies {
  episodes: Pick<BankSessionExpiryEpisodeRepository, "findByBankCode" | "claimConsumerAttempt" | "markConsumerResolved">;
  gate: ExpiryPublicationPreClaimGate;
  resolveAccountFingerprint(bankCode: string): string | undefined;
  ingest(job: IngestionJob): Promise<IngestionResult>;
}

export function createExpiryPublicationConsumer(dependencies: ExpiryPublicationConsumerDependencies) {
  return async function consumeExpiryPublication(queuedHint: unknown): Promise<IngestionResult | null> {
    const claim = await reserveExpiryPublicationConsumerClaim(
      dependencies.episodes,
      queuedHint,
      dependencies.gate,
    );
    if (claim.status !== "claim_acquired" && claim.status !== "claim_resumed") {
      return null;
    }

    // reserveExpiryPublicationConsumerClaim validates this untrusted hint first.
    const envelope = queuedHint as ExpiryPublicationEnvelope;
    const accountFingerprint = dependencies.resolveAccountFingerprint(envelope.bankCode);
    if (!accountFingerprint) {
      await dependencies.episodes.markConsumerResolved(envelope, claimToken(envelope));
      return null;
    }

    return dependencies.ingest({
      data: {
        runId: envelope.runId,
        bankId: envelope.bankCode,
        expiredEventId: envelope.expiredEventId,
        accountFingerprint,
      },
    });
  };

}
function claimToken(envelope: ExpiryPublicationEnvelope): string {
  return createHash("sha256")
    .update(JSON.stringify([envelope.bankCode, envelope.expiredEventId, envelope.runId, envelope.token]))
    .digest("hex");
}
