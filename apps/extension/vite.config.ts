import { fileURLToPath } from "node:url";

import { crx } from "@crxjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

import manifest from "./manifest.config.ts";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // Functions passed to `page.evaluate` are serialized as source, so they must not be
    // down-leveled into code that depends on bundler helpers.
    target: "esnext",
    // `pnpm dev` is a watch build (see package.json): readable output and source maps.
    minify: mode !== "development",
    sourcemap: mode === "development",
    // The side panel bundles model catalogs and provider SDKs; it is loaded from disk.
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
}));
