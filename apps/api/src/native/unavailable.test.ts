// Runs without a built addon: the native engine must fail clearly, never fall back to TypeScript.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "hpa-addon-"));
const corrupt = join(dir, "corrupt.node");
writeFileSync(corrupt, "this is not a shared library");

// The loader reads HPA_ADDON_PATH once; each file gets a fresh module registry in Vitest,
// so the value set here applies to every import below.
process.env["HPA_ADDON_PATH"] = join(dir, "does-not-exist.node");
vi.spyOn(console, "warn").mockImplementation(() => undefined);
vi.spyOn(console, "error").mockImplementation(() => undefined);

const { createApp } = await import("../app.js");
const { getNativeStatus } = await import("./loader.js");
const { nativeComputeAnalytics } = await import("./nativeEngine.js");

const server = createApp().listen(0);
let baseUrl = "";

beforeAll(async () => {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  fetch(`${baseUrl}/api/analytics/compute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const events = [{ id: 1, timestamp: 1000, eventType: "view", category: "books", value: 10 }];

describe("native engine unavailable (addon file missing)", () => {
  it("reports not_built without throwing at load time", () => {
    expect(getNativeStatus()).toEqual({ available: false, reason: "not_built" });
  });

  it("returns 503 for engine=native and does not claim any engine", async () => {
    const res = await post({ events, engine: "native" });
    expect(res.status).toBe(503);
    expect(res.headers.get("x-analytics-engine")).toBeNull();
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("native_engine_unavailable");
    expect(body.message).not.toContain(dir); // no server paths leak to clients
  });

  it("still serves the default and explicit TypeScript engine", async () => {
    for (const body of [{ events }, { events, engine: "typescript" }]) {
      const res = await post(body);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-analytics-engine")).toBe("typescript");
    }
  });

  it("validates the request before touching the native engine", async () => {
    const res = await post({ events: "nope", engine: "native" });
    expect(res.status).toBe(503); // engine selection is valid; the addon is what is missing
    expect((await post({ events, engine: "bogus" })).status).toBe(400);
  });

  it("lists the native engine as unavailable", async () => {
    const body = (await (await fetch(`${baseUrl}/api/analytics/engines`)).json()) as { engines: unknown };
    expect(body.engines).toEqual({
      typescript: { available: true },
      native: { available: false, reason: "not_built" },
    });
  });

  it("makes the programmatic wrapper throw instead of falling back", () => {
    expect(() => nativeComputeAnalytics(events)).toThrow("not available");
  });
});

describe("native engine unavailable (file is not a loadable module)", () => {
  it("reports load_failed, again without crashing", async () => {
    vi.resetModules();
    process.env["HPA_ADDON_PATH"] = corrupt;
    const loader = await import("./loader.js");
    expect(loader.getNativeStatus()).toEqual({ available: false, reason: "load_failed" });
    expect(() => loader.getNativeAddon()).toThrow(loader.NativeUnavailableError);
  });
});
