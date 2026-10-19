import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeAnalytics, generateEvents, type AnalyticsEvent, type AnalyticsResult } from "./analytics/index.js";
import { createApp } from "./app.js";
import { MAX_API_EVENTS } from "./analyticsRoutes.js";

const server = createApp().listen(0);
let baseUrl = "";

beforeAll(async () => {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function post(path: string, body: unknown, contentType = "application/json") {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/analytics/generate", () => {
  it("returns events and the resolved options", async () => {
    const res = await post("/api/analytics/generate", { seed: 42, count: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { options: unknown; events: AnalyticsEvent[] };
    expect(body.options).toEqual({ seed: 42, count: 3, startTimestamp: 1_700_000_000_000, intervalMs: 1000 });
    expect(body.events).toEqual(generateEvents({ seed: 42, count: 3 }));
  });

  it("is reproducible across requests", async () => {
    const a = await (await post("/api/analytics/generate", { seed: 7, count: 100 })).text();
    const b = await (await post("/api/analytics/generate", { seed: 7, count: 100 })).text();
    expect(a).toBe(b);
  });

  it("accepts exactly the maximum count", async () => {
    const res = await post("/api/analytics/generate", { seed: 1, count: MAX_API_EVENTS });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { events: unknown[] }).events).toHaveLength(MAX_API_EVENTS);
  });

  it.each([
    ["count above the API limit", { seed: 1, count: MAX_API_EVENTS + 1 }],
    ["missing seed", { count: 5 }],
    ["negative count", { seed: 1, count: -1 }],
    ["string count", { seed: 1, count: "5" }],
    ["unknown field", { seed: 1, count: 5, extra: true }],
    ["array body", []],
  ])("returns 400 for %s", async (_name, body) => {
    const res = await post("/api/analytics/generate", body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("validation_error");
    expect(json.message).toEqual(expect.any(String));
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await post("/api/analytics/generate", "{bad");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it.each(["null", "42", '"text"'])("returns 400 for the non-object JSON literal %s", async (literal) => {
    const res = await post("/api/analytics/generate", literal);
    expect(res.status).toBe(400);
  });

  it("returns 400 when the body is not JSON", async () => {
    const res = await post("/api/analytics/generate", "seed=1&count=2", "text/plain");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/analytics/compute", () => {
  const events = generateEvents({ seed: 3, count: 200 });

  it("returns the same result as the core", async () => {
    const res = await post("/api/analytics/compute", { events, histogramBins: 4 });
    expect(res.status).toBe(200);
    expect((await res.json()) as AnalyticsResult).toEqual(computeAnalytics(events, { histogramBins: 4 }));
  });

  it("handles an empty event list", async () => {
    const res = await post("/api/analytics/compute", { events: [] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyticsResult;
    expect(body.summary.count).toBe(0);
    expect(body.percentiles.p50).toBeNull();
  });

  it("accepts bodies larger than the default 1mb limit", async () => {
    const big = generateEvents({ seed: 1, count: 20_000 }); // ~2 MB of JSON
    const res = await post("/api/analytics/compute", { events: big });
    expect(res.status).toBe(200);
    expect(((await res.json()) as AnalyticsResult).summary.count).toBe(20_000);
  });

  it.each([
    ["missing events", {}],
    ["non-array events", { events: "x" }],
    ["invalid event", { events: [{ id: 1 }] }],
    ["non-finite value encoded as null", { events: [{ id: 1, timestamp: 1, eventType: "a", category: "b", value: null }] }],
    ["bad histogramBins", { events, histogramBins: 0 }],
    ["unknown field", { events, nope: 1 }],
    ["array body", []],
  ])("returns 400 for %s", async (_name, body) => {
    const res = await post("/api/analytics/compute", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("validation_error");
  });

  it("returns 413 when too many events are supplied", async () => {
    const one = events[0] as AnalyticsEvent;
    const res = await post("/api/analytics/compute", { events: new Array<AnalyticsEvent>(MAX_API_EVENTS + 1).fill(one) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("payload_too_large");
  });

  it("returns 413 when the body exceeds the byte limit", async () => {
    const res = await post("/api/analytics/compute", `{"events":[],"pad":"${"x".repeat(17 * 1024 * 1024)}"}`);
    expect(res.status).toBe(413);
  });
});

describe("existing endpoints", () => {
  it("GET /api/health is unchanged", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", uptimeSeconds: expect.any(Number) });
  });

  it("still returns 404 for unknown analytics routes", async () => {
    const res = await post("/api/analytics/nope", {});
    expect(res.status).toBe(404);
  });

  it("still enforces the 1mb limit outside the compute endpoint", async () => {
    const res = await post("/api/analytics/generate", `{"pad":"${"x".repeat(2 * 1024 * 1024)}"}`);
    expect(res.status).toBe(413);
  });
});
