import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Throwaway entry only; no app startup, auth, API proxy or real task mutations.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { entries: ["scheduled-task-management.prototype.html"] },
  server: { host: "0.0.0.0", strictPort: true }
});
