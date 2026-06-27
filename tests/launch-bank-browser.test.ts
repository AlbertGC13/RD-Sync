import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CDP_URL } from "../src/worker/scraper/browser-runtime";

const hasBash = spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;

// In CI, the absence of bash means the launcher contract goes completely
// untested — a silent describe.skip would hide that gap. Fail loudly instead.
// Locally (no CI env), skipping is acceptable for Windows-only dev runs.
if (!hasBash && process.env.CI) {
  throw new Error(
    "launch-bank-browser.sh tests require bash, but bash was not found on PATH. " +
      "CI must provide bash; refusing to silently skip launcher coverage.",
  );
}

const describeIfBash = hasBash ? describe : describe.skip;
const bashPwd = hasBash
  ? spawnSync("bash", ["-lc", "pwd"], { encoding: "utf8" }).stdout.trim()
  : "";
const windowsDrivePrefix = bashPwd.startsWith("/mnt/") ? "/mnt/" : "/";

function toBashPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return process.platform === "win32"
    ? normalized.replace(
        /^([A-Za-z]):/,
        (_match, drive: string) => `${windowsDrivePrefix}${drive.toLowerCase()}`,
      )
    : normalized;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function createSandbox(): {
  tempDir: string;
  logFile: string;
  env: Record<string, string>;
  cleanup: () => void;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "rd-sync-launcher-"));
  const binDir = join(tempDir, "bin");
  const profileDir = join(tempDir, "profile");
  const logFile = join(tempDir, "browser.log");
  mkdirSync(binDir);

  writeExecutable(join(binDir, "curl"), "#!/usr/bin/env bash\nexit 1\n");
  writeExecutable(join(binDir, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(join(binDir, "stat"), "#!/usr/bin/env bash\necho 1000\n");
  writeExecutable(join(binDir, "id"), "#!/usr/bin/env bash\necho 1000\n");

  return {
    tempDir,
    // Real OS path so the test can read what the launched argv was written to.
    logFile,
    env: {
      PATH: `${toBashPath(binDir)}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
      RD_SYNC_BANK_BROWSER_BIN: "/bin/echo",
      RD_SYNC_BANK_BROWSER_PROFILE_DIR: toBashPath(profileDir),
      RD_SYNC_BANK_BROWSER_LOG_FILE: toBashPath(logFile),
    },
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

/**
 * Reads a file that a backgrounded (`nohup ... &`) launch writes to. The browser
 * stub (/bin/echo) records the launched argv, but the write races the parent
 * script's exit, so we poll briefly until the expected content appears.
 */
async function readFileWhen(
  path: string,
  predicate: (content: string) => boolean,
  attempts = 40,
): Promise<string> {
  let content = "";
  for (let i = 0; i < attempts; i += 1) {
    try {
      content = readFileSync(path, "utf8");
      if (predicate(content)) return content;
    } catch {
      // File may not exist yet — the launch is detached via nohup.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return content;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runLauncher(env: Record<string, string>, bankCode = "popular") {
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const command = `${assignments} ${shellQuote(
    toBashPath(join(process.cwd(), "scripts", "launch-bank-browser.sh")),
  )} ${shellQuote(bankCode)}`;

  return spawnSync(
    "bash",
    ["-lc", command],
    { encoding: "utf8" },
  );
}

// This parity check needs no bash — it reads the script text directly — so it
// runs on every platform (including Windows-only dev) to guarantee the launcher
// and the worker can never default to mismatched CDP ports (HIGH-1 / LOW).
describe("launcher / worker shared CDP default parity", () => {
  it("launcher DEFAULT_CDP_URL full origin equals the worker's DEFAULT_CDP_URL origin", () => {
    const scriptPath = join(process.cwd(), "scripts", "launch-bank-browser.sh");
    const scriptText = readFileSync(scriptPath, "utf8");

    const match = scriptText.match(/^DEFAULT_CDP_URL="([^"]+)"/m);
    expect(match, "launcher must define DEFAULT_CDP_URL").not.toBeNull();

    // LOW-1: the contract is that the FULL value agrees, not merely the port.
    // Compare the whole origin (protocol + host + port) so a host drift (e.g.
    // localhost vs 127.0.0.1) can never slip past a port-only assertion.
    const launcherDefaultUrl = match![1];
    const launcherOrigin = new URL(launcherDefaultUrl).origin;
    const workerOrigin = new URL(DEFAULT_CDP_URL).origin;

    expect(launcherOrigin).toBe(workerOrigin);
  });

  it("the launcher no longer exposes a DEBUG_PORT knob (port comes only from the CDP URL)", () => {
    const scriptPath = join(process.cwd(), "scripts", "launch-bank-browser.sh");
    const scriptText = readFileSync(scriptPath, "utf8");

    // The legacy override must be fully removed so the CDP URL is the genuine
    // single source of truth for the debug port.
    expect(scriptText).not.toContain("RD_SYNC_BANK_BROWSER_DEBUG_PORT");
  });
});

describeIfBash("launch-bank-browser.sh", () => {
  it.each([
    ["non-loopback", "http://10.0.0.5:9333", "loopback"],
    ["ws protocol", "ws://127.0.0.1:9333", "http://loopback:puerto"],
    ["path-bearing", "http://127.0.0.1:9333/json/version", "http://loopback:puerto"],
  ])("rejects %s per-bank CDP URLs", (_caseName, cdpUrl, errorText) => {
    const sandbox = createSandbox();
    try {
      const result = runLauncher({
        ...sandbox.env,
        RD_SYNC_BANK_POPULAR_CDP_URL: cdpUrl,
        RD_SYNC_CDP_URL: "http://127.0.0.1:9222",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(errorText);
      // A rejected CDP URL must abort BEFORE any browser is launched: the log
      // file (created only on the launch path) must never appear.
      expect(existsSync(sandbox.logFile)).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  });

  it("warns when a per-bank CDP URL is set but no bank code is passed (MEDIUM-3)", () => {
    const sandbox = createSandbox();
    try {
      // No bank code argument, but a per-bank CDP override is present: the
      // override is ignored, so the launcher must warn the operator.
      const result = runLauncher(
        {
          ...sandbox.env,
          RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9333",
        },
        "",
      );

      expect(result.status).toBe(0);
      // The warning names the ignored variable so the operator knows to re-run
      // with the matching bank code.
      expect(result.stderr).toContain("RD_SYNC_BANK_POPULAR_CDP_URL");
      expect(result.stderr).toContain("SIN código de banco");
      // No URL/credential leakage: the override's value (port 9333) is never
      // echoed — only the variable name appears.
      expect(result.stderr).not.toContain("9333");
    } finally {
      sandbox.cleanup();
    }
  });

  it("lets per-bank CDP override global CDP and launches with that debug port", async () => {
    const sandbox = createSandbox();
    try {
      const result = runLauncher({
        ...sandbox.env,
        RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9333",
        RD_SYNC_CDP_URL: "http://127.0.0.1:9222",
      });

      expect(result.status).toBe(0);

      // Assert the REAL launched argv (the flags the browser receives), not just
      // the human-readable banner.
      const launchedArgv = await readFileWhen(sandbox.logFile, (content) =>
        content.includes("--remote-debugging-port=9333"),
      );
      expect(launchedArgv).toContain("--remote-debugging-port=9333");
      expect(launchedArgv).toContain("--remote-debugging-address=127.0.0.1");
    } finally {
      sandbox.cleanup();
    }
  });

  it("falls back to global CDP when per-bank CDP is absent", async () => {
    const sandbox = createSandbox();
    try {
      const result = runLauncher({
        ...sandbox.env,
        RD_SYNC_CDP_URL: "http://127.0.0.1:9444",
      });

      expect(result.status).toBe(0);

      const launchedArgv = await readFileWhen(sandbox.logFile, (content) =>
        content.includes("--remote-debugging-port=9444"),
      );
      expect(launchedArgv).toContain("--remote-debugging-port=9444");
      expect(launchedArgv).toContain("--remote-debugging-address=127.0.0.1");
    } finally {
      sandbox.cleanup();
    }
  });

  it("derives a bank-scoped default profile dir when no explicit profile dir is set", () => {
    const sandbox = createSandbox();
    const home = join(sandbox.tempDir, "home");
    mkdirSync(home);
    try {
      // Rebuild env WITHOUT the explicit profile/log overrides so the script
      // falls through to its bank-scoped default under $HOME.
      const env: Record<string, string> = {
        PATH: sandbox.env.PATH,
        RD_SYNC_BANK_BROWSER_BIN: sandbox.env.RD_SYNC_BANK_BROWSER_BIN,
        HOME: toBashPath(home),
        RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9333",
      };

      const result = runLauncher(env);

      expect(result.status).toBe(0);
      // Default profile must be bank-scoped:
      // <home>/.local/share/rd-sync/bank-browser/popular
      expect(result.stdout).toContain("bank-browser/popular");
    } finally {
      sandbox.cleanup();
    }
  });

  it("bank-scopes a GLOBAL profile dir override so two banks never collide (MEDIUM-1)", () => {
    const sandbox = createSandbox();
    try {
      // sandbox.env sets the GLOBAL RD_SYNC_BANK_BROWSER_PROFILE_DIR (…/profile).
      const result = runLauncher(
        {
          ...sandbox.env,
          RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9333",
        },
        "popular",
      );

      expect(result.status).toBe(0);
      // The global override must be suffixed with the bank code.
      expect(result.stdout).toContain("profile/popular");
    } finally {
      sandbox.cleanup();
    }
  });

  it("uses a per-bank profile dir override verbatim — no bank-code suffix (MEDIUM-1)", () => {
    const sandbox = createSandbox();
    try {
      const perBankDir = toBashPath(join(sandbox.tempDir, "perbank"));
      const result = runLauncher(
        {
          PATH: sandbox.env.PATH,
          RD_SYNC_BANK_BROWSER_BIN: sandbox.env.RD_SYNC_BANK_BROWSER_BIN,
          RD_SYNC_BANK_BROWSER_LOG_FILE: sandbox.env.RD_SYNC_BANK_BROWSER_LOG_FILE,
          RD_SYNC_BANK_POPULAR_PROFILE_DIR: perBankDir,
          RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9333",
        },
        "popular",
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("perbank");
      // An explicit per-bank path must NOT get the bank code appended.
      expect(result.stdout).not.toContain("perbank/popular");
    } finally {
      sandbox.cleanup();
    }
  });
});
