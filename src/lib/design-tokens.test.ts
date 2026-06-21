import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const globalsCssPath = resolve(__dirname, "../app/globals.css");
const source = readFileSync(globalsCssPath, "utf8");
const lineCount = source.split("\n").length;

const requiredThemeTokens = [
  "--color-background",
  "--color-foreground",
  "--color-card",
  "--color-card-foreground",
  "--color-popover",
  "--color-popover-foreground",
  "--color-primary",
  "--color-primary-foreground",
  "--color-secondary",
  "--color-secondary-foreground",
  "--color-muted",
  "--color-muted-foreground",
  "--color-accent",
  "--color-accent-foreground",
  "--color-destructive",
  "--color-destructive-foreground",
  "--color-border",
  "--color-input",
  "--color-ring",
  "--color-success",
  "--color-warning",
  "--color-info",
  "--color-credit",
  "--color-debit",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
] as const;

const brandColors = [
  { token: "--color-primary", hex: "#059669" },
  { token: "--color-secondary", hex: "#262626" },
] as const;

describe("src/app/globals.css design system baseline", () => {
  it("imports tailwindcss as the entry point", () => {
    expect(source).toMatch(/@import\s+["']tailwindcss["']\s*;/);
  });

  it("declares an @theme block that drives the design tokens", () => {
    expect(source).toMatch(/@theme\s*\{/);
  });

  it.each(requiredThemeTokens)("declares required token %s", (token) => {
    expect(source).toContain(token);
  });

  it.each(brandColors)("maps brand token $token to $hex", ({ token, hex }) => {
    const tokenRegex = new RegExp(`${token}\\s*:\\s*${hex.replace("#", "#")}`, "i");
    expect(source).toMatch(tokenRegex);
  });

  it("stays under the 100-line budget for the design system layer", () => {
    expect(lineCount).toBeLessThan(100);
  });
});
