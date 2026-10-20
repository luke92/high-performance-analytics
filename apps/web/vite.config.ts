import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The WebAssembly worker loads its module with a dynamic import, which needs ES-format workers.
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3001" },
  },
});
