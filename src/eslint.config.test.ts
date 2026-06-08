import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

// The root eslint config is a flat-config .mjs module; it ships without a
// declaration file. The @ts-expect-error directive documents that this is
// intentional and will fail the build if a future .d.mts lands and the
// implicit-any error goes away.
// @ts-expect-error - no declaration file for the .mjs root config
import rawHexRule from "../eslint.config.mjs";

/** Minimal shape of an ESLint flat-config entry we read in these tests. */
type EslintFlatConfigEntry = {
  files?: string | string[];
  rules?: Record<string, unknown>;
};

/** Minimal shape of a single `no-restricted-syntax` rule object. */
type RawHexRuleEntry = {
  selector: string;
  message: string;
};

type EslintConfig = EslintFlatConfigEntry[];

function getConfig(): EslintConfig {
  const mod = rawHexRule as unknown;
  if (Array.isArray(mod)) return mod as EslintConfig;
  const def = (mod as { default?: EslintConfig }).default;
  return Array.isArray(def) ? def : [];
}

function isRawHexRuleEntry(rule: unknown): rule is RawHexRuleEntry {
  if (typeof rule !== "object" || rule === null) return false;
  const message = (rule as { message?: unknown }).message;
  return typeof message === "string" && message.includes("Raw hex");
}

function findRawHexConfig(config: EslintConfig): EslintFlatConfigEntry | undefined {
  return config.find((entry) => {
    const restricted = entry?.rules?.["no-restricted-syntax"];
    return Array.isArray(restricted) && restricted.some(isRawHexRuleEntry);
  });
}

function findRuleForScope(config: EslintConfig, filename: string): RawHexRuleEntry | undefined {
  for (const entry of config) {
    if (!entry?.files) continue;
    const patterns = Array.isArray(entry.files) ? entry.files : [entry.files];
    if (patterns.some((pattern) => minimatch(filename, pattern))) {
      const restricted = entry.rules?.["no-restricted-syntax"];
      if (Array.isArray(restricted)) {
        return restricted.find(isRawHexRuleEntry);
      }
    }
  }
  return undefined;
}

function minimatch(filename: string, pattern: string): boolean {
  if (pattern.endsWith("**/*.{ts,tsx}")) {
    const base = pattern.replace("**/*.{ts,tsx}", "");
    return filename.startsWith(base) && /\.(ts|tsx)$/.test(filename);
  }
  if (pattern.endsWith("/**/page.tsx")) {
    const base = pattern.replace("/**/page.tsx", "");
    return filename.startsWith(base) && filename.endsWith("/page.tsx");
  }
  return false;
}

describe("eslint raw-hex rule", () => {
  it("is configured to forbid raw hex literals in component files", () => {
    const config = getConfig();
    const block = findRawHexConfig(config);

    expect(block).toBeDefined();
    expect(block?.files).toBeDefined();
  });

  it("flags a raw hex literal in a component file using the loaded rule", () => {
    const config = getConfig();
    const linter = new Linter();
    const block = findRawHexConfig(config);
    const restrictedSyntax = block?.rules?.["no-restricted-syntax"] as unknown[] | undefined;
    const ruleObject = restrictedSyntax?.[1] as RawHexRuleEntry | undefined;

    expect(ruleObject).toBeDefined();

    const offendingCode = `
      export function Bad() {
        return <div style={{ color: "#0f766e" }}>x</div>;
      }
    `;

    const messages = linter.verify(offendingCode, {
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: {
        "no-restricted-syntax": ["error", ruleObject],
      },
    });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].message).toContain("Raw hex");
  });

  it("scope matching covers src/components/**/*.tsx", () => {
    const config = getConfig();
    const rule = findRuleForScope(config, "src/components/ui/button.tsx");

    expect(rule).toBeDefined();
  });

  it("scope matching covers src/app/**/page.tsx", () => {
    const config = getConfig();
    const rule = findRuleForScope(config, "src/app/(private)/transactions/page.tsx");

    expect(rule).toBeDefined();
  });

  it("scope matching also covers component test files (the rule has no test-file carve-out)", () => {
    const config = getConfig();
    const rule = findRuleForScope(config, "src/components/ui/button.test.tsx");

    expect(rule).toBeDefined();
  });

  it("scope matching's files array does not target .css files", () => {
    const config = getConfig();
    const block = findRawHexConfig(config);
    const files = block?.files;
    const patterns = Array.isArray(files) ? files : files ? [files] : [];

    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((pattern) => pattern.includes(".css"))).toBe(false);
  });
});
