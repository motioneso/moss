// Thin wrapper. The manifest shape and validator live in module-registry so instances can verify
// the same format the publisher writes. Kept so existing script imports keep working.
export * from "../../packages/module-registry/src/distribution/cli-tools-manifest.js";
