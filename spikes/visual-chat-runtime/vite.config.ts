import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { prepareRuntimeModule } from "./runtime-entry.js";

export default defineConfig(({ command, mode }) => ({
  plugins: [
    {
      name: "moss-evaluate-openui-entry",
      enforce: "pre",
      transform(source, id) {
        const code = prepareRuntimeModule(
          source,
          id,
          command === "serve" ? "development" : "production",
          // Only for the documented failing loader control; never an app setting.
          process.env.MOSS_OPENUI_NEGATIVE_LOADER === "1"
        );
        return code === undefined ? undefined : { code, map: null };
      }
    },
    react()
  ],
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { exclude: ["@openuidev/react-lang"] },
  build: {
    outDir: `dist/${mode === "baseline" ? "baseline" : "runtime"}`,
    rollupOptions: {
      input: fileURLToPath(
        new URL(mode === "baseline" ? "baseline.html" : "index.html", import.meta.url)
      )
    }
  }
}));
