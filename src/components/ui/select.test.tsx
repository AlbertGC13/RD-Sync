import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

describe("Select", () => {
  it("exports the Select subcomponents", () => {
    // Radix primitives are objects that wrap multiple subcomponents.
    expect(Select).toBeDefined();
    expect(SelectTrigger).toBeDefined();
    expect(SelectValue).toBeDefined();
    expect(SelectContent).toBeDefined();
    expect(SelectItem).toBeDefined();
  });

  it("renders the trigger with the placeholder text", () => {
    const html = renderToStaticMarkup(
      <Select>
        <SelectTrigger aria-label="Bank">
          <SelectValue placeholder="Choose bank" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="popular">Popular</SelectItem>
        </SelectContent>
      </Select>,
    );

    expect(html).toContain("Choose bank");
  });
});
