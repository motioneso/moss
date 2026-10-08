import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Throwaway entry only: no production-app scan, API proxy or authentication.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { entries: ["scheduled-task-creation.prototype.html"] },
  build: { rollupOptions: { input: "scheduled-task-creation.prototype.html" } },
  server: { host: "0.0.0.0", strictPort: true }
});
