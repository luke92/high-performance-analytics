import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildParityFixture } from "./parityFixture.js";

describe("C++ parity fixture", () => {
  it("is up to date with the TypeScript reference (run `npm run fixtures:parity` to regenerate)", () => {
    const path = fileURLToPath(new URL("../../../cpp/tests/fixtures/parity.txt", import.meta.url));
    expect(readFileSync(path, "utf8")).toBe(buildParityFixture());
  });
});
