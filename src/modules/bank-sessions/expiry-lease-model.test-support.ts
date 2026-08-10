import type {
  ConsumerAttemptState,
  EpisodePublicationState,
} from "./expiry-episodes";
import type { ExpiryTerminalFailureReason } from "./expiry-terminal-reconciliation";

export interface InvalidConsumerLeaseTuple {
  name: string;
  source: string | null;
  leaseExpiresAt: string | null;
  attemptState: ConsumerAttemptState | null;
  publicationState: EpisodePublicationState;
  publicationClaimToken: string | null;
  terminalFailureReason: ExpiryTerminalFailureReason | null;
}

export const INVALID_CONSUMER_LEASE_TUPLES = [
  { name: "lease without source", source: null, leaseExpiresAt: "2026-08-07T12:00:00.000Z", attemptState: "reserved", publicationState: "published", publicationClaimToken: "publication-token", terminalFailureReason: null },
  { name: "source without an attempt state", source: "scheduled", leaseExpiresAt: null, attemptState: null, publicationState: "published", publicationClaimToken: "publication-token", terminalFailureReason: null },
  { name: "active source without lease", source: "scheduled", leaseExpiresAt: null, attemptState: "reserved", publicationState: "published", publicationClaimToken: "publication-token", terminalFailureReason: null },
  { name: "unknown source", source: "unknown", leaseExpiresAt: "2026-08-07T12:00:00.000Z", attemptState: "reserved", publicationState: "published", publicationClaimToken: "publication-token", terminalFailureReason: null },
  { name: "scrape-time source marked published", source: "scrape_time", leaseExpiresAt: "2026-08-07T12:00:00.000Z", attemptState: "mutation_started", publicationState: "published", publicationClaimToken: "publication-token", terminalFailureReason: null },
  { name: "scheduled source without canonical publication", source: "scheduled", leaseExpiresAt: "2026-08-07T12:00:00.000Z", attemptState: "mutation_started", publicationState: "pending", publicationClaimToken: null, terminalFailureReason: null },
  { name: "scheduled source with a blank publication token", source: "scheduled", leaseExpiresAt: "2026-08-07T12:00:00.000Z", attemptState: "mutation_started", publicationState: "published", publicationClaimToken: " ", terminalFailureReason: null },
  { name: "resolved source with an active lease", source: "scheduled", leaseExpiresAt: "2026-08-07T12:00:00.000Z", attemptState: "resolved", publicationState: "published", publicationClaimToken: "publication-token", terminalFailureReason: null },
  { name: "manual recovery source with an active lease", source: "scrape_time", leaseExpiresAt: "2026-08-07T12:00:00.000Z", attemptState: "manual_recovery_required", publicationState: "pending", publicationClaimToken: null, terminalFailureReason: null },
  { name: "terminal failure source with an active lease", source: "scheduled", leaseExpiresAt: "2026-08-07T12:00:00.000Z", attemptState: "reserved", publicationState: "published", publicationClaimToken: "publication-token", terminalFailureReason: "job_missing" },
] as const satisfies readonly InvalidConsumerLeaseTuple[];

export function createLeaseExpiresAt(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}
