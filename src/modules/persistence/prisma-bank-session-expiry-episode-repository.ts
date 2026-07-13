import type { PrismaClient } from "../../generated/prisma/client";
import type {
  BankSessionExpiryEpisode,
  BankSessionExpiryEpisodeRepository,
  CreateBankSessionExpiryEpisodeInput,
  EpisodeCloseResult,
  GetOrCreateBankSessionExpiryEpisodeResult,
  SessionEpisodeAuditKind,
} from "../bank-sessions/expiry-episodes";

type EpisodeRow = {
  bankCode: string;
  expiredEventId: string;
  runId: string;
  expiredAuditDeliveredAt: Date | null;
  restoredAuditDeliveredAt: Date | null;
};

function mapRow(row: EpisodeRow): BankSessionExpiryEpisode {
  return {
    bankCode: row.bankCode,
    expiredEventId: row.expiredEventId,
    runId: row.runId,
    expiredAuditDelivered: row.expiredAuditDeliveredAt !== null,
    restoredAuditDelivered: row.restoredAuditDeliveredAt !== null,
  };
}

/** Raw parameterized SQL keeps this repository independent of generated output. */
export class PrismaBankSessionExpiryEpisodeRepository implements BankSessionExpiryEpisodeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getOrCreate(input: CreateBankSessionExpiryEpisodeInput): Promise<GetOrCreateBankSessionExpiryEpisodeResult> {
    const inserted = await this.prisma.$queryRaw<EpisodeRow[]>`
      INSERT INTO "BankSessionExpiryEpisode" ("bankCode", "expiredEventId", "runId", "updatedAt")
      VALUES (${input.bankCode}, ${input.expiredEventId}, ${input.runId}, NOW())
      ON CONFLICT ("bankCode") DO NOTHING
      RETURNING "bankCode", "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt"
    `;
    if (inserted[0]) return { episode: mapRow(inserted[0]), created: true };

    const existing = await this.prisma.$queryRaw<EpisodeRow[]>`
      SELECT "bankCode", "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt"
      FROM "BankSessionExpiryEpisode" WHERE "bankCode" = ${input.bankCode}
    `;
    if (!existing[0]) throw new Error("Bank session expiry episode was not available after insert conflict");
    return { episode: mapRow(existing[0]), created: false };
  }

  async findByBankCode(bankCode: string): Promise<BankSessionExpiryEpisode | null> {
    const rows = await this.prisma.$queryRaw<EpisodeRow[]>`
      SELECT "bankCode", "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt"
      FROM "BankSessionExpiryEpisode" WHERE "bankCode" = ${bankCode}
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async isAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean> {
    const rows = kind === "expired"
      ? await this.prisma.$queryRaw<{ deliveredAt: Date | null }[]>`
          SELECT "expiredAuditDeliveredAt" AS "deliveredAt" FROM "BankSessionExpiryEpisode"
          WHERE "bankCode" = ${episode.bankCode} AND "runId" = ${episode.runId}
        `
      : await this.prisma.$queryRaw<{ deliveredAt: Date | null }[]>`
          SELECT "restoredAuditDeliveredAt" AS "deliveredAt" FROM "BankSessionExpiryEpisode"
          WHERE "bankCode" = ${episode.bankCode} AND "runId" = ${episode.runId}
        `;
    return rows[0]?.deliveredAt !== null && rows[0] !== undefined;
  }

  async markAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean> {
    const updated = kind === "expired"
      ? await this.prisma.$queryRaw<{ bankCode: string }[]>`
          UPDATE "BankSessionExpiryEpisode" SET "expiredAuditDeliveredAt" = NOW(), "updatedAt" = NOW()
          WHERE "bankCode" = ${episode.bankCode} AND "runId" = ${episode.runId} AND "expiredAuditDeliveredAt" IS NULL
          RETURNING "bankCode"
        `
      : await this.prisma.$queryRaw<{ bankCode: string }[]>`
          UPDATE "BankSessionExpiryEpisode" SET "restoredAuditDeliveredAt" = NOW(), "updatedAt" = NOW()
          WHERE "bankCode" = ${episode.bankCode} AND "runId" = ${episode.runId} AND "restoredAuditDeliveredAt" IS NULL
          RETURNING "bankCode"
        `;
    return updated.length === 1;
  }

  async close(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<EpisodeCloseResult> {
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM "BankSessionExpiryEpisode"
      WHERE "bankCode" = ${episode.bankCode} AND "expiredEventId" = ${episode.expiredEventId} AND "runId" = ${episode.runId}
    `;
    return deleted === 1 ? "closed" : "missing_or_stale";
  }
}
