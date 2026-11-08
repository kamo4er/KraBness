import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// В dev-режиме API и WebSocket проксируются на запущенный хаб.
const HUB = process.env.KAMHARN_HUB ?? "http://127.0.0.1:7420";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": HUB,
      "/ws": { target: HUB.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
