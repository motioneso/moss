import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { jarvisModuleSettingsPlugin, jarvisModuleWebPlugin } from "@moss/settings-ui/vite";
import { prepareOpenUiModule } from "./openui-runtime";

const apiTarget = process.env.JARVIS_API_PROXY_TARGET ?? "http://localhost:3000";
const rootDir = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [
    {
      name: "moss-openui-runtime",
      enforce: "pre",
      transform(source, id) {
        const code = prepareOpenUiModule(
          source,
          id,
          command === "serve" ? "development" : "production"
        );
        return code === undefined ? undefined : { code, map: null };
      }
    },
    react(),
    jarvisModuleSettingsPlugin({ rootDir }),
    jarvisModuleWebPlugin({ rootDir })
  ],
  optimizeDeps: { exclude: ["@openuidev/react-lang"] },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Origin", apiTarget);
          });
        }
      },
      "/health": {
        target: apiTarget,
        changeOrigin: true
      }
    }
  },
  preview: {
    port: 4173
  }
}));
