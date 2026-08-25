import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for scripts/launch-bank-browser.ps1 (Windows launcher).
//
// Portal identity and endpoint policy live in scripts/lib/bank-portal-endpoint
// and are covered by bank-portal-endpoint-ps1.test.ts. These tests cover what
// the launcher itself owns: profile isolation, start-URL safety, and the argv
// actually handed to the browser process.
// ---------------------------------------------------------------------------

const powershellBin = "powershell";
const hasPowershell =
  process.platform === "win32" &&
  spawnSync(powershellBin, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
  }).status === 0;

if (!hasPowershell && process.platform === "win32" && process.env.CI) {
  throw new Error(
    "launch-bank-browser.ps1 tests require powershell, but it was not found on PATH. " +
      "Windows CI must provide powershell; refusing to silently skip launcher coverage.",
  );
}

const describeIfPowershell = hasPowershell ? describe : describe.skip;
const scriptPath = join(process.cwd(), "scripts", "launch-bank-browser.ps1");

interface RunResult {
  status: number | null;
  stderr: string;
  plan: Record<string, string>;
}

function runLauncher(args: string[], overrides: Record<string, string> = {}): RunResult {
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("RD_SYNC_") || key === "BANK_CODE") continue;
    baseEnv[key] = value;
  }

  const result = spawnSync(
    powershellBin,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    { encoding: "utf8", env: { ...baseEnv, ...overrides } as NodeJS.ProcessEnv },
  );

  const plan: Record<string, string> = {};
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const match = line.match(/^plan\.([A-Za-z]+)=(.*)$/);
    if (match) plan[match[1]] = match[2];
  }
  return { status: result.status, stderr: result.stderr ?? "", plan };
}

async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rd-sync-ps-launcher-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "rd-sync-ps-launcher-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describeIfPowershell("launch-bank-browser.ps1 refuses what the endpoint policy refuses", () => {
  it("propagates an unknown portal identity as a failure", () => {
    const result = runLauncher(["-BankCode", "acme_bank", "-DryRun"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no es un portal conocido/i);
  });

  it("propagates a missing per-portal endpoint as a failure", () => {
    const result = runLauncher(["-BankCode", "bhd_personal", "-DryRun"], {
      RD_SYNC_CDP_URL: "http://127.0.0.1:9222",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RD_SYNC_BANK_BHD_PERSONAL_CDP_URL/);
  });
});

describeIfPowershell("launch-bank-browser.ps1 profile isolation", () => {
  it("derives a different profile dir per portal from identical configuration", () => {
    withTempDir((localAppData) => {
      const popular = runLauncher(["-BankCode", "popular", "-DryRun"], {
        LOCALAPPDATA: localAppData,
      });
      const bhd = runLauncher(["-BankCode", "bhd_personal", "-DryRun"], {
        LOCALAPPDATA: localAppData,
        RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9223",
      });

      expect(popular.plan.profileDir).not.toBe(bhd.plan.profileDir);
      expect(popular.plan.profileDir.endsWith("popular")).toBe(true);
      expect(bhd.plan.profileDir.endsWith("bhd_personal")).toBe(true);
      expect(popular.plan.profileDir.startsWith(localAppData)).toBe(true);
    });
  });

  it("portal-scopes a GLOBAL profile dir override so two portals never collide", () => {
    withTempDir((localAppData) => {
      const shared = join(localAppData, "shared-profile");
      const first = runLauncher(["-BankCode", "popular", "-DryRun"], {
        LOCALAPPDATA: localAppData,
        RD_SYNC_BANK_BROWSER_PROFILE_DIR: shared,
      });
      const second = runLauncher(["-BankCode", "bhd_personal", "-DryRun"], {
        LOCALAPPDATA: localAppData,
        RD_SYNC_BANK_BROWSER_PROFILE_DIR: shared,
        RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9223",
      });

      expect(first.plan.profileDir).toBe(join(shared, "popular"));
      expect(second.plan.profileDir).toBe(join(shared, "bhd_personal"));
    });
  });

  it("uses a per-portal profile dir override verbatim", () => {
    withTempDir((localAppData) => {
      const explicit = join(localAppData, "explicit-bhd-profile");
      const result = runLauncher(["-BankCode", "bhd_personal", "-DryRun"], {
        LOCALAPPDATA: localAppData,
        RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9223",
        RD_SYNC_BANK_BHD_PERSONAL_PROFILE_DIR: explicit,
      });

      expect(result.plan.profileDir).toBe(explicit);
    });
  });
});

describeIfPowershell("launch-bank-browser.ps1 start URL safety", () => {
  it("prefers the per-portal start URL over the global one", () => {
    const result = runLauncher(["-BankCode", "popular", "-DryRun"], {
      RD_SYNC_BANK_POPULAR_START_URL: "https://per-portal.example/login",
      RD_SYNC_BANK_BROWSER_START_URL: "https://global.example/login",
    });

    expect(result.status).toBe(0);
    expect(result.plan.startUrl).toBe("https://per-portal.example/login");
  });

  it.each([
    ["javascript:", "javascript:alert(document.cookie)"],
    ["data:", "data:text/html,<script>fetch('//x')</script>"],
    ["file:", "file:///C:/Windows/System32/drivers/etc/hosts"],
    ["plain http", "http://ib.bpd.com.do"],
    ["a scheme-relative URL", "//evil.example/login"],
  ])("refuses a %s start URL instead of handing it to the browser", (_label, startUrl) => {
    const result = runLauncher(["-BankCode", "popular", "-DryRun"], {
      RD_SYNC_BANK_POPULAR_START_URL: startUrl,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/https:\/\/ o about:blank/);
  });
});

describeIfPowershell("launch-bank-browser.ps1 real browser argv", () => {
  it("hands the browser this portal's profile, port and start URL", () => {
    withTempDir((dir) => {
      const argvLog = join(dir, "argv.log");
      const fakeBrowser = join(dir, "fake-browser.cmd");
      writeFileSync(fakeBrowser, `@echo off\r\necho %*>> "${argvLog}"\r\n`, "utf8");
      const profileDir = join(dir, "bank profile");

      // The fake browser never exposes CDP, so the launcher reports that the
      // browser did not become ready — after handing it the real argv.
      const result = runLauncher(["-BankCode", "bhd_personal"], {
        RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9223",
        RD_SYNC_BANK_BHD_PERSONAL_PROFILE_DIR: profileDir,
        RD_SYNC_BANK_BROWSER_BIN: fakeBrowser,
        RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS: "1000",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/no expuso CDP/);

      const deadline = Date.now() + 10_000;
      while (!existsSync(argvLog) && Date.now() < deadline) {
        spawnSync(powershellBin, ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 200"]);
      }
      expect(existsSync(argvLog), "the browser process was never started").toBe(true);

      const argv = readFileSync(argvLog, "utf8");
      expect(argv).toContain("--remote-debugging-port=9223");
      expect(argv).toContain("--remote-debugging-address=127.0.0.1");
      expect(argv).toContain(`--user-data-dir="${profileDir}"`);
      expect(argv).toContain("https://ibp.bhd.com.do/#/login");
    });
  }, 30_000);
});

describeIfPowershell("launch-bank-browser.ps1 concurrent launches", () => {
  /** Holds a portal's launch lock from a separate process, as a live launch does. */
  function holdLaunchLock(profileDir: string): {
    release: () => Promise<void>;
    held: Promise<void>;
  } {
    mkdirSync(profileDir, { recursive: true });
    const lockPath = join(profileDir, ".launch.lock");
    const child = spawn(powershellBin, [
      "-NoProfile",
      "-Command",
      `$s = [System.IO.File]::Open(${JSON.stringify(lockPath)},` +
        " [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite," +
        " [System.IO.FileShare]::None); Write-Output 'held'; Start-Sleep -Seconds 20",
    ]);

    const held = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("held")) resolve();
      });
      child.on("error", reject);
      setTimeout(() => reject(new Error("lock holder never reported acquisition")), 15_000);
    });

    // The lock file must be closed before the temp dir can be removed, so the
    // caller awaits the holder's exit rather than just signalling it.
    const release = () =>
      new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        child.kill();
      });

    return { release, held };
  }

  it("refuses a second launch while one is in flight on the same portal", async () => {
    await withTempDirAsync(async (dir) => {
      const profileDir = join(dir, "profile");
      const holder = holdLaunchLock(profileDir);
      await holder.held;

      try {
        const argvLog = join(dir, "argv.log");
        const fakeBrowser = join(dir, "fake-browser.cmd");
        writeFileSync(fakeBrowser, `@echo off
echo %*>> "${argvLog}"
`, "utf8");

        const result = runLauncher(["-BankCode", "popular"], {
          RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9601",
          RD_SYNC_BANK_POPULAR_PROFILE_DIR: profileDir,
          RD_SYNC_BANK_BROWSER_BIN: fakeBrowser,
          RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS: "1000",
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/lanzamiento en curso/);
        expect(existsSync(argvLog), "no browser may start while the lock is held").toBe(false);
      } finally {
        await holder.release();
      }
    });
  }, 30_000);

  it("does not block a different portal", async () => {
    await withTempDirAsync(async (dir) => {
      const popularProfile = join(dir, "popular");
      const bhdProfile = join(dir, "bhd");
      const holder = holdLaunchLock(popularProfile);
      await holder.held;

      try {
        const argvLog = join(dir, "argv.log");
        const fakeBrowser = join(dir, "fake-browser.cmd");
        writeFileSync(fakeBrowser, `@echo off
echo %*>> "${argvLog}"
`, "utf8");

        const result = runLauncher(["-BankCode", "bhd_personal"], {
          RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9223",
          RD_SYNC_BANK_BHD_PERSONAL_PROFILE_DIR: bhdProfile,
          RD_SYNC_BANK_BROWSER_BIN: fakeBrowser,
          RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS: "1000",
        });

        expect(result.stderr).not.toMatch(/lanzamiento en curso/);
      } finally {
        await holder.release();
      }
    });
  }, 30_000);
});
