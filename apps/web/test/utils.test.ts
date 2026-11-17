import { describe, expect, it } from "vitest";
import { cn } from "../src/lib/utils";

describe("cn", () => {
  it("joins class names and skips falsy values", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("accepts conditional objects and nested arrays", () => {
    expect(cn({ active: true, hidden: false }, ["x", ["y"]])).toBe("active x y");
  });

  it("lets a later Tailwind utility override a conflicting earlier one", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
  });

  it("keeps unrelated utilities", () => {
    expect(cn("flex", "items-center", "gap-2")).toBe("flex items-center gap-2");
  });

  it("returns an empty string for no input", () => {
    expect(cn()).toBe("");
  });
});
