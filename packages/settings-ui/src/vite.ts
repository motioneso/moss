import {
  emitVirtualModule,
  emitWebVirtualModule,
  scanModuleSettings,
  scanModuleWeb,
  SHELL_RESERVED_WEB_PATHS
} from "./scanner.ts";

export {
  emitVirtualModule,
  emitWebVirtualModule,
  scanModuleSettings,
  scanModuleWeb,
  SHELL_RESERVED_WEB_PATHS
};

export function jarvisModuleSettingsPlugin(options: { readonly rootDir?: string } = {}) {
  const virtualId = "virtual:moss-module-settings";
  const resolvedId = `\0${virtualId}`;

  return {
    name: "moss-module-settings",
    resolveId(id: string) {
      return id === virtualId ? resolvedId : undefined;
    },
    load(this: { addWatchFile?: (file: string) => void }, id: string) {
      if (id !== resolvedId) return undefined;
      const result = scanModuleSettings({ rootDir: options.rootDir ?? process.cwd() });
      for (const file of result.manifestFiles) this.addWatchFile?.(file);
      return emitVirtualModule(result);
    }
  };
}

export function jarvisModuleWebPlugin(options: { readonly rootDir?: string } = {}) {
  const virtualId = "virtual:moss-module-web";
  const resolvedId = `\0${virtualId}`;

  return {
    name: "moss-module-web",
    resolveId(id: string) {
      return id === virtualId ? resolvedId : undefined;
    },
    load(this: { addWatchFile?: (file: string) => void }, id: string) {
      if (id !== resolvedId) return undefined;
      const result = scanModuleWeb({ rootDir: options.rootDir ?? process.cwd() });
      for (const file of result.manifestFiles) this.addWatchFile?.(file);
      for (const file of result.packageFiles) this.addWatchFile?.(file);
      return emitWebVirtualModule(result);
    }
  };
}
