import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listBankPortalIdentities } from "../src/modules/bank-adapters/bank-identities";
import { DEFAULT_CDP_URL } from "../src/worker/scraper/browser-runtime";

// ---------------------------------------------------------------------------
// Contract tests for scripts/lib/bank-portal-endpoint.ps1 — the portal identity
// and CDP endpoint resolution shared by the Windows launcher.
//
// The tests exercise the library's OWN rules (which identities exist, which
// portal may inherit a shared endpoint, which ports are valid, which
// collisions are refused). They never hand the library a port allocation and
// then assert that same allocation back.
// ---------------------------------------------------------------------------

const powershellBin = "powershell";
const hasPowershell =
  process.platform === "win32" &&
  spawnSync(powershellBin, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
  }).status === 0;

// On Windows CI this contract must never go silently untested.
if (!hasPowershell && process.platform === "win32" && process.env.CI) {
  throw new Error(
    "bank-portal-endpoint.ps1 tests require powershell, but it was not found on PATH. " +
      "Windows CI must provide powershell; refusing to silently skip launcher coverage.",
  );
}

const describeIfPowershell = hasPowershell ? describe : describe.skip;

const libPath = join(process.cwd(), "scripts", "lib", "bank-portal-endpoint.ps1");
const libText = readFileSync(libPath, "utf8");

// The bank code travels through the environment, never through the harness
// source, so a hostile value can never be interpolated into the script text.
const harnessSource = `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(libPath)}
$identity = Resolve-BankPortalCode ([Environment]::GetEnvironmentVariable('RDTEST_BANK_CODE','Process'))
if (-not $identity.ok) {
    Write-Output "error=$($identity.error)"
    Write-Output "message=$($identity.message)"
    exit 1
}
Write-Output "bankCode=$($identity.bankCode)"
$endpoint = Resolve-PortalCdpEndpoint $identity.bankCode
if (-not $endpoint.ok) {
    Write-Output "error=$($endpoint.error)"
    Write-Output "message=$($endpoint.message)"
    exit 1
}
Write-Output "cdpUrl=$($endpoint.cdpUrl)"
Write-Output "cdpPort=$($endpoint.cdpPort)"
Write-Output "cdpBind=$($endpoint.cdpBind)"
`;

interface ResolveResult {
  status: number | null;
  values: Record<string, string>;
}

/** Resolves one portal through the library with a curated environment. */
function resolvePortal(
  bankCode: string | null,
  overrides: Record<string, string> = {},
): ResolveResult {
  const dir = mkdtempSync(join(tmpdir(), "rd-sync-portal-endpoint-"));
  const harnessPath = join(dir, "harness.ps1");
  writeFileSync(harnessPath, harnessSource, "utf8");

  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("RD_SYNC_") || key === "BANK_CODE") continue;
    baseEnv[key] = value;
  }
  if (bankCode !== null) baseEnv.RDTEST_BANK_CODE = bankCode;

  try {
    const result = spawnSync(
      powershellBin,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
      { encoding: "utf8", env: { ...baseEnv, ...overrides } as NodeJS.ProcessEnv },
    );

    const values: Record<string, string> = {};
    for (const line of (result.stdout ?? "").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z]+)=(.*)$/);
      if (match) values[match[1]] = match[2];
    }
    return { status: result.status, values };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bank-portal-endpoint.ps1 shares one source of truth with the runtime", () => {
  it("declares the same default CDP origin as the worker", () => {
    const match = libText.match(/^\$DEFAULT_CDP_URL\s*=\s*"([^"]+)"/m);

    expect(match, "library must define $DEFAULT_CDP_URL").not.toBeNull();
    expect(new URL(match![1]).origin).toBe(new URL(DEFAULT_CDP_URL).origin);
  });

  it("knows exactly the portal identities the runtime knows", () => {
    const block = libText.match(/\$KNOWN_PORTAL_CODES\s*=\s*@\(([^)]*)\)/);
    expect(block, "library must define $KNOWN_PORTAL_CODES").not.toBeNull();

    const libraryCodes = [...block![1].matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
    const runtimeCodes = listBankPortalIdentities().map((identity) => identity.bankCode);

    expect([...libraryCodes].sort()).toEqual([...runtimeCodes].sort());
  });

  it("derives the debug port only from the CDP URL (no DEBUG_PORT knob)", () => {
    expect(libText).not.toMatch(/DEBUG_PORT/);
  });
});

describeIfPowershell("bank-portal-endpoint.ps1 portal identity", () => {
  it("fails closed when no portal is named instead of guessing one", () => {
    const result = resolvePortal(null, {});

    expect(result.status).not.toBe(0);
    expect(result.values.error).toBe("missing_bank_code");
  });

  it("rejects a portal identity the runtime does not know", () => {
    const result = resolvePortal("acme_bank", {
      RD_SYNC_BANK_ACME_BANK_CDP_URL: "http://127.0.0.1:9230",
    });

    expect(result.status).not.toBe(0);
    expect(result.values.error).toBe("unknown_portal");
  });

  it("rejects a bank code carrying shell punctuation", () => {
    const result = resolvePortal("popular; del /q *", {});

    expect(result.status).not.toBe(0);
    expect(result.values.error).toBe("unknown_portal");
  });

  it("accepts the portal from the BANK_CODE environment variable", () => {
    const result = resolvePortal(null, {
      BANK_CODE: "banreservas_personas",
      RD_SYNC_BANK_BANRESERVAS_PERSONAS_CDP_URL: "http://127.0.0.1:9224",
    });

    expect(result.status).toBe(0);
    expect(result.values.bankCode).toBe("banreservas_personas");
  });
});

describeIfPowershell("bank-portal-endpoint.ps1 endpoint policy", () => {
  it("refuses a non-Popular portal with no endpoint of its own", () => {
    const result = resolvePortal("bhd_personal", {
      RD_SYNC_CDP_URL: "http://127.0.0.1:9222",
    });

    expect(result.status).not.toBe(0);
    expect(result.values.error).toBe("missing_endpoint");
    expect(result.values.message).toMatch(/RD_SYNC_BANK_BHD_PERSONAL_CDP_URL/);
  });

  it("lets Popular alone inherit the shared default endpoint", () => {
    const result = resolvePortal("popular", {});

    expect(result.status).toBe(0);
    expect(result.values.cdpPort).toBe(new URL(DEFAULT_CDP_URL).port);
  });

  it("lets Popular inherit the global endpoint override", () => {
    const result = resolvePortal("popular", { RD_SYNC_CDP_URL: "http://127.0.0.1:9402" });

    expect(result.status).toBe(0);
    expect(result.values.cdpPort).toBe("9402");
  });

  it("prefers the per-portal endpoint over the global one", () => {
    const result = resolvePortal("popular", {
      RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9401",
      RD_SYNC_CDP_URL: "http://127.0.0.1:9402",
    });

    expect(result.status).toBe(0);
    expect(result.values.cdpPort).toBe("9401");
  });

  it("refuses a port another known portal already claims", () => {
    const result = resolvePortal("bhd_personal", {
      RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9500",
      RD_SYNC_BANK_BANRESERVAS_PERSONAS_CDP_URL: "http://127.0.0.1:9500",
    });

    expect(result.status).not.toBe(0);
    expect(result.values.error).toBe("port_collision");
    expect(result.values.message).toMatch(/banreservas_personas/);
  });

  it("binds IPv6 loopback endpoints to ::1", () => {
    const result = resolvePortal("bhd_personal", {
      RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://[::1]:9223",
    });

    expect(result.status).toBe(0);
    expect(result.values.cdpBind).toBe("::1");
  });

  it("accepts the highest valid port", () => {
    const result = resolvePortal("popular", {
      RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:65535",
    });

    expect(result.status).toBe(0);
    expect(result.values.cdpPort).toBe("65535");
  });

  it.each([
    ["a non-loopback host", "http://10.0.0.5:9222"],
    ["port zero", "http://127.0.0.1:0"],
    ["a zero-padded port", "http://127.0.0.1:09222"],
    ["a port above the range", "http://127.0.0.1:65536"],
    ["no port at all", "http://127.0.0.1"],
    ["a path suffix", "http://127.0.0.1:9222/json"],
    ["embedded credentials", "http://user:pass@127.0.0.1:9222"],
    ["https instead of http", "https://127.0.0.1:9222"],
  ])("rejects %s", (_label, cdpUrl) => {
    const result = resolvePortal("popular", { RD_SYNC_BANK_POPULAR_CDP_URL: cdpUrl });

    expect(result.status).not.toBe(0);
    expect(result.values.error).toBe("invalid_endpoint");
  });
});
