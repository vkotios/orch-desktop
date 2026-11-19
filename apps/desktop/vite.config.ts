/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const bridgePort = Number(process.env.CHO_BRIDGE_PORT || 1421);

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  test: {
    // Limit contention between Windows process probes and on-disk fixtures.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1422,
        }
      : undefined,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${bridgePort}`,
        changeOrigin: true,
      },
    },
  },
});
