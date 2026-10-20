import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ValidationError } from "./analytics/index.js";
import { NativeUnavailableError } from "./native/loader.js";
import { analyticsRouter, COMPUTE_BODY_LIMIT, PayloadTooLargeError } from "./analyticsRoutes.js";

export interface HealthResponse {
  status: "ok";
  uptimeSeconds: number;
}

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  // Registered first so the larger limit wins; the parser below then skips the already-parsed body.
  app.use("/api/analytics/compute", express.json({ limit: COMPUTE_BODY_LIMIT }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/analytics", analyticsRouter());

  app.get("/api/health", (_req, res) => {
    const body: HealthResponse = { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
    res.json(body);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Express recognises error handlers by their 4-argument signature.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: "validation_error", message: err.message });
      return;
    }
    if (err instanceof NativeUnavailableError) {
      res.status(503).json({ error: "native_engine_unavailable", message: err.message });
      return;
    }
    if (err instanceof PayloadTooLargeError) {
      res.status(413).json({ error: "payload_too_large", message: err.message });
      return;
    }
    const status = getHttpStatus(err);
    if (status >= 500) console.error(err);
    const code = status >= 500 ? "internal_error" : status === 413 ? "payload_too_large" : "bad_request";
    res.status(status).json({ error: code });
  });

  return app;
}

function getHttpStatus(err: unknown): number {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 600) return status;
  }
  return 500;
}
