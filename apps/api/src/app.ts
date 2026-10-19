import express, { type Express, type NextFunction, type Request, type Response } from "express";

export interface HealthResponse {
  status: "ok";
  uptimeSeconds: number;
}

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    const body: HealthResponse = { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
    res.json(body);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Express recognises error handlers by their 4-argument signature.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = getHttpStatus(err);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "internal_error" : "bad_request" });
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
