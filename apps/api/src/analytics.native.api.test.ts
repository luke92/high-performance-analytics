import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeNative } from "../test/support.js";
import { generateEvents, type AnalyticsEvent } from "./analytics/index.js";
import { ENGINE_HEADER, MAX_API_EVENTS } from "./analyticsRoutes.js";
import { createApp } from "./app.js";

const server = createApp().listen(0);
let baseUrl = "";

beforeAll(async () => {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function compute(body: unknown) {
  return fetch(`${baseUrl}/api/analytics/compute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const events = generateEvents({ seed: 11, count: 500 });

describe("engine selection (TypeScript, always available)", () => {
  it("defaults to the TypeScript engine and says so", async () => {
    const res = await compute({ events });
    expect(res.status).toBe(200);
    expect(res.headers.get(ENGINE_HEADER)).toBe("typescript");
  });

  it("accepts engine=typescript explicitly with the same result as the default", async () => {
    const implicit = await (await compute({ events })).text();
    const explicit = await compute({ events, engine: "typescript" });
    expect(explicit.headers.get(ENGINE_HEADER)).toBe("typescript");
    expect(await explicit.text()).toBe(implicit);
  });

  it.each([["gpu"], ["NATIVE"], [""], [1], [null], [true], [["native"]], [{ name: "native" }]])(
    "rejects engine=%j with 400 and no engine header",
    async (engine) => {
      const res = await compute({ events, engine });
      expect(res.status).toBe(400);
      expect(res.headers.get(ENGINE_HEADER)).toBeNull();
      expect(await res.json()).toEqual({
        error: "validation_error",
        message: "engine must be one of: typescript, native",
      });
    },
  );

  it("lists the engines and their availability", async () => {
    const body = (await (await fetch(`${baseUrl}/api/analytics/engines`)).json()) as {
      engines: { typescript: { available: boolean }; native: { available: boolean } };
    };
    expect(body.engines.typescript).toEqual({ available: true });
    expect(typeof body.engines.native.available).toBe("boolean");
  });
});

describeNative("engine selection (native)", () => {
  it("runs the native engine on request and reports it in the header", async () => {
    const res = await compute({ events, engine: "native" });
    expect(res.status).toBe(200);
    expect(res.headers.get(ENGINE_HEADER)).toBe("native");
  });

  it.each([
    ["500 generated events", { events }],
    ["custom histogram bins", { events, histogramBins: 37 }],
    ["an empty dataset", { events: [], histogramBins: 4 }],
    ["a single event", { events: [events[0]] }],
    ["boundary values", { events: [{ id: 1, timestamp: 0, eventType: "a", category: "b", value: -1e12 }, { id: 2, timestamp: 1, eventType: "a", category: "b", value: 1e12 }] }],
  ])("returns byte-identical JSON for both engines: %s", async (_name, body) => {
    const ts = await compute({ ...body, engine: "typescript" });
    const native = await compute({ ...body, engine: "native" });
    expect(native.status).toBe(200);
    expect(await native.text()).toBe(await ts.text());
  });

  it("handles bodies above the default 1mb limit with identical results", async () => {
    const big = generateEvents({ seed: 1, count: 20_000 });
    const ts = await (await compute({ events: big, engine: "typescript" })).text();
    const native = await compute({ events: big, engine: "native" });
    expect(native.status).toBe(200);
    expect(await native.text()).toBe(ts);
  });

  it("accepts exactly the maximum number of events and rejects one more with 413", async () => {
    const one = events[0] as AnalyticsEvent;
    const max = await compute({ events: new Array<AnalyticsEvent>(MAX_API_EVENTS).fill(one), engine: "native" });
    expect(max.status).toBe(200);
    const over = await compute({ events: new Array<AnalyticsEvent>(MAX_API_EVENTS + 1).fill(one), engine: "native" });
    expect(over.status).toBe(413);
    expect(over.headers.get(ENGINE_HEADER)).toBeNull();
    expect(((await over.json()) as { error: string }).error).toBe("payload_too_large");
  });

  const good = { id: 1, timestamp: 1000, eventType: "view", category: "books", value: 10 };
  it.each([
    ["missing events", {}],
    ["non-array events", { events: "x" }],
    ["null element", { events: [null] }],
    ["null value (a JSON-encoded NaN)", { events: [{ ...good, value: null }] }],
    ["value over the limit", { events: [{ ...good, value: 1e12 + 1 }] }],
    ["string id", { events: [{ ...good, id: "1" }] }],
    ["fractional id", { events: [{ ...good, id: 1.5 }] }],
    ["negative timestamp", { events: [{ ...good, timestamp: -1 }] }],
    ["bad category", { events: [{ ...good, category: "a b" }] }],
    ["missing field", { events: [{ id: 1, timestamp: 1, eventType: "a", category: "b" }] }],
    ["second event invalid", { events: [good, { ...good, eventType: "" }] }],
    ["bad histogramBins", { events: [good], histogramBins: 0 }],
    ["string histogramBins", { events: [good], histogramBins: "5" }],
    ["unknown field", { events: [good], nope: 1 }],
  ])("returns the same 400 response from both engines for %s", async (_name, body) => {
    const ts = await compute({ ...body, engine: "typescript" });
    const native = await compute({ ...body, engine: "native" });
    expect(ts.status).toBe(400);
    expect(native.status).toBe(400);
    expect(native.headers.get(ENGINE_HEADER)).toBeNull();
    expect(await native.json()).toEqual(await ts.json());
  });

  it("reports the loaded native module on the engines endpoint", async () => {
    const body = (await (await fetch(`${baseUrl}/api/analytics/engines`)).json()) as {
      engines: { native: { available: boolean; coreVersion?: string; napiVersion?: number } };
    };
    expect(body.engines.native).toMatchObject({ available: true, napiVersion: 8 });
    expect(body.engines.native.coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("leaves /api/health and /generate unchanged", async () => {
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
    const res = await fetch(`${baseUrl}/api/analytics/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed: 42, count: 2 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(ENGINE_HEADER)).toBeNull();
  });
});
