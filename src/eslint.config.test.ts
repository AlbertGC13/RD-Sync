// @ts-expect-error - eslint.config.mjs has no type declarations
import rawHexRule from "../eslint.config.mjs";

import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

// Helper: load the raw-hex no-restricted-syntax block from the flat config.
function findRawHexConfig(config) {
  return config.find(
    (entry) =>
      entry?.rules?.["no-restricted-syntax"]?.some?.((rule) =>
        typeof rule === "object" && rule.message?.includes("Raw hex"),
      ),
  );
}

function findRuleForScope(config, filename) {
  for (const entry of config) {
    if (!entry?.files) continue;
    const patterns = Array.isArray(entry.files) ? entry.files : [entry.files];
    if (patterns.some((pattern) => minimatch(filename, pattern))) {
      const restricted = entry.rules?.["no-restricted-syntax"];
      if (Array.isArray(restricted)) {
        return restricted.find(
          (rule) => typeof rule === "object" && rule.message?.includes("Raw hex"),
        );
      }
    }
  }
  return undefined;
}

function minimatch(filename, pattern) {
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
    const config = rawHexRule.default ?? rawHexRule;
    const block = findRawHexConfig(config);

    expect(block).toBeDefined();
    expect(block?.files).toBeDefined();
  });

  it("flags a raw hex literal in a component file", () => {
    const linter = new Linter();

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
        "no-restricted-syntax": [
          "error",
          {
            selector: 'Literal[value=/^#[0-9A-Fa-f]{3,8}$/]',
            message: "Raw hex colors are forbidden in components and page entry points.",
          },
        ],
      },
    });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].message).toContain("Raw hex");
  });

  it("scope matching covers src/components/**/*.tsx", () => {
    const config = rawHexRule.default ?? rawHexRule;
    const rule = findRuleForScope(config, "src/components/ui/button.tsx");

    expect(rule).toBeDefined();
  });

  it("scope matching covers src/app/**/page.tsx", () => {
    const config = rawHexRule.default ?? rawHexRule;
    const rule = findRuleForScope(config, "src/app/(private)/transactions/page.tsx");

    expect(rule).toBeDefined();
  });

  it("scope matching does not cover nested css files", () => {
    const config = rawHexRule.default ?? rawHexRule;
    const rule = findRuleForScope(config, "src/app/globals.css");

    expect(rule).toBeUndefined();
  });
});
