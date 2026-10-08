import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Throwaway entry only: no production-app scan, API proxy or authentication.
export default defineConfig({
  plugins: [react()],
  // This config builds only the fictional review entry, never the production app.
  define: { "import.meta.env.DEV": "true" },
  optimizeDeps: { entries: ["proactive-updates.prototype.html"] },
  build: { rollupOptions: { input: "proactive-updates.prototype.html" } },
  server: { host: "0.0.0.0", strictPort: true }
});
