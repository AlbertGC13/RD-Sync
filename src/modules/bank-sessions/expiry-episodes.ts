export type SessionEpisodeAuditKind = "expired" | "restored";
export type EpisodePublicationState = "pending" | "publishing" | "published" | "cancelled";
export const PUBLICATION_CLAIM_TIMEOUT_MS = 30_000;

export function parseEpisodePublicationState(value: string, token: string | null, failure: Date | null): EpisodePublicationState {
  const claimed = Boolean(token?.trim());
  if (((value === "pending" || value === "cancelled") && token === null && failure === null) || (value === "publishing" && claimed) || (value === "published" && claimed && failure === null)) return value as EpisodePublicationState;
  throw new Error("Invalid publication tuple");
}
function assertPublicationToken(token: string): void { if (!token.trim()) throw new Error("Publication token must be nonblank"); }
export interface BankSessionExpiryEpisode {
  bankCode: string;
  expiredEventId: string;
  runId: string;
  expiredAuditDelivered: boolean;
  restoredAuditDelivered: boolean;
  publicationState: EpisodePublicationState;
  publicationClaimToken: string | null;
  publicationFailureReportedAt: Date | null;
  updatedAt: Date;
}

export type EpisodeCloseResult = "closed" | "missing_or_stale";

export interface CreateBankSessionExpiryEpisodeInput {
  bankCode: string;
  expiredEventId: string;
  runId: string;
}

export interface GetOrCreateBankSessionExpiryEpisodeResult {
  episode: BankSessionExpiryEpisode;
  created: boolean;
}

export interface BankSessionExpiryEpisodeRepository {
  getOrCreate(input: CreateBankSessionExpiryEpisodeInput): Promise<GetOrCreateBankSessionExpiryEpisodeResult>;
  findByBankCode(bankCode: string): Promise<BankSessionExpiryEpisode | null>;
  isAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean>;
  markAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean>;
  claimPublication(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean>;
  markPublicationPublished(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean>;
  cancelPublication(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<boolean>;
  markPublicationFailureReported(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean>;
  close(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<EpisodeCloseResult>;
}
export async function publishExpiryEpisode(
  episodes: BankSessionExpiryEpisodeRepository,
  episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">,
  proposedToken: string,
  enqueue: (job: { bankCode: string; expiredEventId: string; runId: string; token: string }) => Promise<void>,
): Promise<boolean> {
  assertPublicationToken(proposedToken);
  const durable = await episodes.findByBankCode(episode.bankCode);
  if (!durable || durable.expiredEventId !== episode.expiredEventId || durable.runId !== episode.runId || durable.restoredAuditDelivered) return false;
  const token = durable.publicationClaimToken ?? proposedToken;
  if (!await episodes.claimPublication(episode, token)) return false;
  try {
    await enqueue({ bankCode: episode.bankCode, expiredEventId: episode.expiredEventId, runId: episode.runId, token });
  } catch (enqueueError) {
    try { await episodes.markPublicationFailureReported(episode, token); }
    catch (markerError) { throw new AggregateError([enqueueError, markerError], "Failed to enqueue expiry episode", { cause: enqueueError }); }
    throw enqueueError;
  }
  return episodes.markPublicationPublished(episode, token);
}
export class InMemoryBankSessionExpiryEpisodeRepository implements BankSessionExpiryEpisodeRepository {
  private readonly episodes = new Map<string, BankSessionExpiryEpisode>();
  constructor(private readonly clock: () => Date = () => new Date()) {}

  async getOrCreate(input: CreateBankSessionExpiryEpisodeInput): Promise<GetOrCreateBankSessionExpiryEpisodeResult> {
    const existing = this.episodes.get(input.bankCode);
    if (existing) return { episode: { ...existing }, created: false };

    const episode: BankSessionExpiryEpisode = {
      ...input,
      expiredAuditDelivered: false,
      restoredAuditDelivered: false,
      publicationState: "pending",
      publicationClaimToken: null,
      publicationFailureReportedAt: null,
      updatedAt: this.clock(),
    };
    this.episodes.set(input.bankCode, episode);
    return { episode: { ...episode }, created: true };
  }
  async claimPublication(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean> {
    assertPublicationToken(token);
    const staleBefore = new Date(this.clock().getTime() - PUBLICATION_CLAIM_TIMEOUT_MS);
    return this.updatePublication(episode, (current) =>
      !current.restoredAuditDelivered && (
        current.publicationState === "pending" || (
          current.publicationState === "publishing"
          && current.publicationClaimToken === token
          && (current.publicationFailureReportedAt !== null || current.updatedAt < staleBefore)
        )
      ), (current) => ({
      ...current, publicationState: "publishing", publicationClaimToken: token, publicationFailureReportedAt: null,
    }));
  }
  async markPublicationPublished(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean> {
    assertPublicationToken(token); return this.updatePublication(episode, (current) => !current.restoredAuditDelivered && current.publicationState === "publishing" && current.publicationClaimToken === token, (current) => ({ ...current, publicationState: "published", publicationFailureReportedAt: null }));
  }
  async cancelPublication(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<boolean> {
    return this.updatePublication(episode, (current) => current.publicationState === "pending" || current.publicationState === "publishing", (current) => ({ ...current, publicationState: "cancelled", publicationClaimToken: null, publicationFailureReportedAt: null }));
  }
  async markPublicationFailureReported(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean> {
    assertPublicationToken(token); return this.updatePublication(episode, (current) => current.publicationState === "publishing" && current.publicationClaimToken === token && current.publicationFailureReportedAt === null, (current) => ({ ...current, publicationFailureReportedAt: this.clock() }));
  }

  async findByBankCode(bankCode: string): Promise<BankSessionExpiryEpisode | null> {
    const episode = this.episodes.get(bankCode);
    return episode ? { ...episode } : null;
  }

  async isAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean> {
    const current = this.episodes.get(episode.bankCode);
    return Boolean(current && current.runId === episode.runId && current[`${kind}AuditDelivered`]);
  }

  async markAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean> {
    const current = this.episodes.get(episode.bankCode);
    const field = `${kind}AuditDelivered` as const;
    if (!current || current.runId !== episode.runId || current[field]) return false;
    this.episodes.set(episode.bankCode, { ...current, [field]: true });
    return true;
  }

  async close(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<EpisodeCloseResult> {
    const current = this.episodes.get(episode.bankCode);
    if (!current || current.runId !== episode.runId || current.expiredEventId !== episode.expiredEventId) {
      return "missing_or_stale";
    }
    this.episodes.delete(episode.bankCode);
    return "closed";
  }

  private async updatePublication(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">,
    canUpdate: (current: BankSessionExpiryEpisode) => boolean,
    update: (current: BankSessionExpiryEpisode) => BankSessionExpiryEpisode,
  ): Promise<boolean> {
    const current = this.episodes.get(episode.bankCode);
    if (!current || current.expiredEventId !== episode.expiredEventId || current.runId !== episode.runId || !canUpdate(current)) return false;
    this.episodes.set(episode.bankCode, { ...update(current), updatedAt: this.clock() });
    return true;
  }
}
