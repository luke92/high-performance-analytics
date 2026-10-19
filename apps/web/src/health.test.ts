import { describe, expect, it } from "vitest";
import { parseHealth } from "./health";

describe("parseHealth", () => {
  it("accepts a valid payload", () => {
    expect(parseHealth({ status: "ok", uptimeSeconds: 3 })).toEqual({ status: "ok", uptimeSeconds: 3 });
  });

  it.each([null, "ok", {}, { status: "down", uptimeSeconds: 1 }, { status: "ok" }])("rejects %j", (input) => {
    expect(() => parseHealth(input)).toThrow();
  });
});
