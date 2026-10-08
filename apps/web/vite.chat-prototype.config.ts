import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Separate, read-only design preview. No API proxy or application startup.
export default defineConfig({ plugins: [react()], server: { host: "0.0.0.0", strictPort: true } });
