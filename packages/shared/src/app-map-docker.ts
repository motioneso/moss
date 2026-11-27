import type { CoreAppErrorDeclaration, CoreAppRemediationDeclaration } from "./app-map-core.js";

export const DOCKER_EXPORT_ERRORS: readonly CoreAppErrorDeclaration[] = [
  {
    code: "docker_export_refused",
    runtime: "rust",
    class: "prerequisite",
    remediationRef: "rust-docker-export-source",
    description:
      "The Linux Docker-host move exporter refused the source identity, mount inventory, durable stop fence or archive capture. A failed capture leaves the source stopped where fencing already succeeded."
  }
];

export const DOCKER_EXPORT_REMEDIATIONS: readonly CoreAppRemediationDeclaration[] = [
  {
    id: "rust-docker-export-source",
    runtime: "rust",
    scope: "system",
    description:
      "On the Docker host, check the exporter reason, disable external restart services and file writers, identify every app and worker container, classify every persistent mount, and retry with a new archive path. Keep the source stopped until the later import reconciles the move; retain its fence receipt and recovery words."
  }
];
