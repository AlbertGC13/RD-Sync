import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

describe("Tooltip", () => {
  it("exports the four Tooltip subcomponents", () => {
    // Radix primitives are objects that wrap multiple subcomponents.
    expect(Tooltip).toBeDefined();
    expect(TooltipProvider).toBeDefined();
    expect(TooltipTrigger).toBeDefined();
    expect(TooltipContent).toBeDefined();
  });

  it("renders the trigger element with hover text", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent>Tooltip text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    // Radix mounts the trigger on render; the content is a portal opened on hover.
    expect(html).toContain("Hover me");
  });
});
