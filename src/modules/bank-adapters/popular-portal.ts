import { popularBankCode } from "./popular";

/**
 * Selector evidence comes from an operator-captured, sanitized live DOM. It is
 * empirical, best-effort behavior for the trusted Popular profile and may drift.
 * This runtime-free configuration does not activate production auto-login.
 */
export const popularPortalConfig = {
  bankCode: popularBankCode,
  baseUrl: "https://ib.bpd.com.do",
  loginPathAllowlist: ["/"],
  usernameSelector: "input[name=\"username\"]",
  passwordSelector: "input[name=\"password\"]",
  submitSelector: "button[type=\"submit\"]",
  mfaIndicatorSelector: "input[name=\"token\"]",
  incompatibleFlowSelector: "[aria-modal=\"true\"]",
  dashboardPathIndicator: "/dashboard",
} as const;
