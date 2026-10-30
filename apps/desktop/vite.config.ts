import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const bridgePort = Number(process.env.CHO_BRIDGE_PORT || 1421);

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
