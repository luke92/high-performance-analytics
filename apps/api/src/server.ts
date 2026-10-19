import { createApp } from "./app.js";

const port = Number(process.env["PORT"] ?? 3001);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env["PORT"]}`);
}

const server = createApp().listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
