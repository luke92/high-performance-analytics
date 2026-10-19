export interface Health {
  status: "ok";
  uptimeSeconds: number;
}

export function parseHealth(value: unknown): Health {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record["status"] === "ok" && typeof record["uptimeSeconds"] === "number") {
      return { status: "ok", uptimeSeconds: record["uptimeSeconds"] };
    }
  }
  throw new Error("Unexpected health response shape");
}

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch("/api/health", signal ? { signal } : {});
  if (!res.ok) throw new Error(`Health check failed with HTTP ${res.status}`);
  return parseHealth(await res.json());
}
