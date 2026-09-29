import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
      "@server": fileURLToPath(new URL("../server", import.meta.url)),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://localhost:4123" } },
});
