/**
 * Shared bank constants and label maps — the single source of truth consumed
 * by both the backend (run-now API) and the operator-facing UI.
 *
 * Centralizing these here prevents the backend whitelist and the UI
 * affordance labels from drifting. Previously the supported-bank id list and
 * the display-name map were duplicated across `run-now.ts`,
 * `trigger-scrape-button.tsx`, `run-action-affordances.tsx`, and the
 * scrape-runs page. The bank display name now derives from `BANKS` so the
 * branding metadata and the operator-facing label never disagree.
 */

import type { ScrapeRunStatus } from "../worker/queues";

export interface BankMeta {
  id: string;
  name: string;
  color: string;
  logoSrc: string;
}

export const BANKS: Record<string, BankMeta> = {
  popular: {
    id: "popular",
    name: "Banco Popular",
    color: "#00C1D5",
    logoSrc: "/banks/popular.svg",
  },
  bhd: {
    id: "bhd",
    name: "BHD",
    color: "#54AD4D",
    logoSrc: "/banks/bhd.svg",
  },
  banreservas: {
    id: "banreservas",
    name: "Banreservas",
    color: "#264E72",
    logoSrc: "/banks/banreservas.svg",
  },
};

export function getBankMeta(bankId: string): BankMeta {
  return (
    BANKS[bankId] ?? {
      id: bankId,
      name: bankId,
      color: "#525252",
      logoSrc: "/banks/default.svg",
    }
  );
}

/**
 * Mirrored whitelist of bank codes currently wired for manual "Run now"
 * triggers. This is NOT dynamically derived from the adapter registry at
 * runtime — it is a hardcoded list kept in sync by parity tests
 * (`banks.test.ts`). The backend run-now validation resolves through the
 * server-side registry directly (authoritative); this list exists only so
 * the client-side UI can render the correct affordance labels without
 * bundling Node-only adapter registry deps.
 *
 * Adding a new bank here requires also registering its adapter in
 * `src/modules/bank-adapters/registry.ts` (and implementing the scraper
 * profile).
 */
export const SUPPORTED_RUN_NOW_BANK_CODES = ["popular"] as const;
export type SupportedRunNowBankCode = (typeof SUPPORTED_RUN_NOW_BANK_CODES)[number];

/**
 * Bank the page-level "Run now" trigger targets when no card is selected.
 * Falls back to the only scraper currently shipping.
 */
export const DEFAULT_RUN_NOW_BANK_CODE: SupportedRunNowBankCode = "popular";

export function isSupportedRunNowBankCode(value: string): value is SupportedRunNowBankCode {
  return (SUPPORTED_RUN_NOW_BANK_CODES as readonly string[]).includes(value);
}

/**
 * Operator-facing bank display name. Derived from `BANKS` so the branding
 * metadata and the toast/UI label always agree — no second name map to keep
 * in sync. Falls back to the raw bankId defensively.
 */
export function bankDisplayName(bankId: string): string {
  return BANKS[bankId]?.name ?? bankId;
}

/**
 * Localized, operator-facing Spanish labels for every scrape-run status.
 * Mirrors the worker queue contract — adding a new status to the domain
 * requires a label here too, otherwise the raw underscored status would leak
 * to the operator UI.
 */
const SCRAPE_RUN_STATUS_LABELS: Record<ScrapeRunStatus, string> = {
  queued: "En cola",
  running: "En curso",
  succeeded: "Completada",
  failed: "Fallida",
  needs_admin_action: "Necesita acción administrativa",
};

export function scrapeRunStatusLabel(status: ScrapeRunStatus): string {
  return SCRAPE_RUN_STATUS_LABELS[status];
}

/**
 * Bank-connection session statuses surfaced to operators on the admin
 * banking pages. Mirrors the `AdminBankConnection["sessionStatus"]` union so
 * the badge never echoes the raw underscored enum (e.g. `needs_admin_action`)
 * to a Dominican banking operator. This is the single source of truth — the
 * admin bank-connections pages import from here instead of redefining the map.
 */
export type BankSessionStatus = "active" | "needs_admin_action" | "expired";

export const BANK_SESSION_STATUS_LABELS: Record<BankSessionStatus, string> = {
  active: "Sesión activa",
  needs_admin_action: "Necesita acción administrativa",
  expired: "Sesión expirada",
};

export function bankSessionStatusLabel(status: BankSessionStatus): string {
  return BANK_SESSION_STATUS_LABELS[status];
}
