import { useEffect, useState } from "react";
import { fetchHealth, type Health } from "./health";

type State = { kind: "loading" } | { kind: "ok"; health: Health } | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((health) => setState({ kind: "ok", health }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>High Performance Analytics</h1>
      <p>Placeholder. The TypeScript vs native C++ vs WebAssembly comparison arrives in later stages.</p>
      <p>
        API: {state.kind === "loading" && "checking..."}
        {state.kind === "ok" && `ok (uptime ${state.health.uptimeSeconds}s)`}
        {state.kind === "error" && `unreachable - ${state.message}`}
      </p>
    </main>
  );
}
