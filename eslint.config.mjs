import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{3,8}$/;

const eslintConfig = [
  ...nextVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "src/generated/prisma/**",
      "test-results/**",
      "src/app/globals.css",
    ],
  },
  {
    // Design system guard (REQ-DS-001): raw hex colors must not appear in
    // component code or top-level page entry points. Colors belong in the
    // design tokens defined in src/app/globals.css (`@theme` block). This
    // keeps the palette swappable from a single source of truth and prevents
    // the codebase from drifting away from the locked teal/deep-blue brand.
    //
    // Scope rationale:
    // - `src/components/**` covers every reviewable UI primitive and feature
    //   component. A stray `#0f766e` here would silently re-introduce the
    //   legacy raw-hex style we are removing.
    // - `src/app/**/page.tsx` covers the route entry points where a designer
    //   might be tempted to inline a color in a className string.
    //
    // Test files are intentionally excluded so fixtures (e.g. stub
    // `style={{ color: "#fff" }}` snapshots) can exercise the rule without
    // flipping the lint exit code in CI.
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/page.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=/${HEX_COLOR_REGEX.source}/]`,
          message:
            "Raw hex colors are forbidden in components and page entry points. Use the design tokens from src/app/globals.css (e.g. `bg-primary`, `text-foreground`) instead.",
        },
      ],
    },
  },
];

export default eslintConfig;
