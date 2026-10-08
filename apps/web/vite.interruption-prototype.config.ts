import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Throwaway entry only; no production routing, authentication or API proxy.
export default defineConfig({
  plugins: [react()],
  define: { "import.meta.env.DEV": "true" },
  base: "./",
  optimizeDeps: { entries: ["interruption-preferences.prototype.html"] },
  build: { rollupOptions: { input: "interruption-preferences.prototype.html" } },
  server: { host: "0.0.0.0", strictPort: true }
});
