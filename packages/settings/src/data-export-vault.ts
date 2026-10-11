import { createHash } from "node:crypto";

import type { AccessContext } from "@moss/db";
import { listVaultFilesRecursive, readVaultFileBytes, type VaultContextRunner } from "@moss/vault";

// These are storage namespaces owned by the export, attachment, workflow-artifact and Sports
// photo producers. They are not note-original roots, even if a file happens to end in .md.
const NON_NOTE_STORAGE_ROOTS = ["exports/", "attachments/", "workflows/", "sports/photos/"];

const LIMITATIONS = [
  "Only regular .md files in this owner's private vault are eligible; other extensions are not included.",
  "External linked folders and other owners' vaults are not read or included.",
  "Symbolic links are not followed or included.",
  "Export artifacts, attachments, workflow artifacts and Sports photo storage are not note originals.",
  "Downloaded-module data is not included in the supported account-record export.",
  "This is a portable export; there is no supported or tested restore flow."
];
const SIZE_POLICY =
  "Eligible files are read in full, without a silent byte or file-count cap. The archive is built in memory; very large exports may exceed worker memory.";

export interface ExportedMarkdownFile {
  readonly path: string;
  readonly encoding: "base64";
  readonly content: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface VaultFileExclusion {
  readonly path: string;
  readonly reason: "not-markdown" | "non-note-storage" | "read-failed";
}

export interface VaultFilesExportManifest {
  readonly scope: "owned-markdown";
  readonly root: "private-vault";
  readonly extension: ".md";
  readonly status: "complete" | "partial" | "unavailable";
  /** Completeness applies only to eligible owned Markdown files, never the whole account. */
  readonly complete: boolean;
  readonly eligibleFileCount: number | null;
  readonly includedCount: number;
  readonly excludedFiles: readonly VaultFileExclusion[];
  readonly limitations: readonly string[];
  readonly sizePolicy: string;
}

export interface OwnedMarkdownExport {
  readonly files: readonly ExportedMarkdownFile[];
  readonly manifest: VaultFilesExportManifest;
}

/** Account portability is independent of which notes currently have an ingestable root. */
export async function collectOwnedMarkdownNotes(
  vaultRunner: VaultContextRunner,
  accessContext: AccessContext
): Promise<OwnedMarkdownExport> {
  try {
    return await vaultRunner.withVaultContext(accessContext, async (vaultCtx) => {
      const paths = (await listVaultFilesRecursive(vaultCtx)).sort();
      const files: ExportedMarkdownFile[] = [];
      const excludedFiles: VaultFileExclusion[] = [];
      let eligibleFileCount = 0;
      let complete = true;

      for (const path of paths) {
        if (NON_NOTE_STORAGE_ROOTS.some((prefix) => path.startsWith(prefix))) {
          excludedFiles.push({ path, reason: "non-note-storage" });
          continue;
        }
        if (!path.endsWith(".md")) {
          excludedFiles.push({ path, reason: "not-markdown" });
          continue;
        }
        eligibleFileCount += 1;
        try {
          const bytes = await readVaultFileBytes(vaultCtx, path);
          files.push({
            path,
            encoding: "base64",
            content: bytes.toString("base64"),
            byteLength: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex")
          });
        } catch {
          // A disappearing/unreadable file is an explicit omission, not an empty original.
          // Do not include raw filesystem errors, which can carry absolute paths or contents.
          complete = false;
          excludedFiles.push({ path, reason: "read-failed" });
        }
      }

      return {
        files,
        manifest: {
          scope: "owned-markdown",
          root: "private-vault",
          extension: ".md",
          status: complete ? "complete" : "partial",
          complete,
          eligibleFileCount,
          includedCount: files.length,
          excludedFiles,
          limitations: LIMITATIONS,
          sizePolicy: SIZE_POLICY
        }
      };
    });
  } catch {
    return {
      files: [],
      manifest: {
        scope: "owned-markdown",
        root: "private-vault",
        extension: ".md",
        status: "unavailable",
        complete: false,
        eligibleFileCount: null,
        includedCount: 0,
        excludedFiles: [],
        limitations: [
          "Owned Markdown note files couldn't be read; none are included.",
          ...LIMITATIONS
        ],
        sizePolicy: SIZE_POLICY
      }
    };
  }
}
