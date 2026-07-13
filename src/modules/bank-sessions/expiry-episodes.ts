export type SessionEpisodeAuditKind = "expired" | "restored";

export interface BankSessionExpiryEpisode {
  bankCode: string;
  expiredEventId: string;
  runId: string;
  expiredAuditDelivered: boolean;
  restoredAuditDelivered: boolean;
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

/** Persists one unresolved expiry episode per bank with atomic winner election. */
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
  close(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<EpisodeCloseResult>;
}

export class InMemoryBankSessionExpiryEpisodeRepository implements BankSessionExpiryEpisodeRepository {
  private readonly episodes = new Map<string, BankSessionExpiryEpisode>();

  async getOrCreate(input: CreateBankSessionExpiryEpisodeInput): Promise<GetOrCreateBankSessionExpiryEpisodeResult> {
    const existing = this.episodes.get(input.bankCode);
    if (existing) return { episode: { ...existing }, created: false };

    const episode: BankSessionExpiryEpisode = {
      ...input,
      expiredAuditDelivered: false,
      restoredAuditDelivered: false,
    };
    this.episodes.set(input.bankCode, episode);
    return { episode: { ...episode }, created: true };
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
}
