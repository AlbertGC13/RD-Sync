/**
 * Canonical audit action constants for bank credential, auto-login,
 * circuit breaker, kill-switch, adapter, and session domains.
 *
 * All bank-related audit events MUST use these exact string values.
 * Shorthand like bare "disabled" is prohibited — it is ambiguous between
 * kill-switch and adapter toggle.
 *
 * @see specs/multi-bank-auto-login/spec.md — Canonical Audit Action Table
 */

export const BANK_CREDENTIAL_ACTIONS = {
  SET: "bank_credential.set",
  ROTATE: "bank_credential.rotate",
  TEST: "bank_credential.test",
  DECRYPT_USE: "bank_credential.decrypt_use",
} as const;

export const BANK_AUTOLOGIN_ACTIONS = {
  ATTEMPTED: "bank_autologin.attempted",
  SUCCEEDED: "bank_autologin.succeeded",
  FAILED: "bank_autologin.failed",
  SKIPPED: "bank_autologin.skipped",
  NEEDS_ADMIN_ACTION: "bank_autologin.needs_admin_action",
} as const;

export const BANK_BREAKER_ACTIONS = {
  OPENED: "bank_breaker.opened",
  RESET: "bank_breaker.reset",
} as const;

export const BANK_KILLSWITCH_ACTIONS = {
  AUTO_LOGIN_ENABLED: "bank_killswitch.auto_login_enabled",
  AUTO_LOGIN_DISABLED: "bank_killswitch.auto_login_disabled",
} as const;

export const BANK_ADAPTER_ACTIONS = {
  ENABLED: "bank_adapter.enabled",
  DISABLED: "bank_adapter.disabled",
} as const;

export const BANK_SESSION_ACTIONS = {
  EXPIRED: "bank_session.expired",
  RESTORED: "bank_session.restored",
  UNAVAILABLE: "bank_session.unavailable",
} as const;

export const BANK_BROWSER_CAPACITY_ACTIONS = {
  WARNING: "bank_browser_capacity.warning",
  RECOVERED: "bank_browser_capacity.recovered",
} as const;
