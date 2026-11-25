import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// These controls change the real host source, not a test double. Run only in an isolated
// builder worktree, serially, and always restore the original bytes before returning.
type Control = { file: string; test: string; marker: string; weaken: (source: string) => string };
function replace(source: string, before: string, after: string): string {
  if (!source.includes(before)) throw new Error(`Control no longer matches: ${before}`);
  return source.replace(before, after);
}
function guard(source: string, message: string): string {
  const messageAt = source.indexOf(`"${message}"`);
  const start = source.lastIndexOf("ensure!(", messageAt);
  const end = source.indexOf(");", messageAt) + 2;
  if (messageAt < 0 || start < 0 || end < 2) throw new Error(`Missing guard: ${message}`);
  return source.slice(0, start) + source.slice(end);
}
const unavailable = "Module is unavailable for this account";
const controls: Control[] = [
  {
    file: "application.rs",
    test: "account_switch_is_owner_only",
    marker: "PRIVATE-SWITCH-MARKER",
    weaken: (s) => guard(s, unavailable)
  },
  {
    file: "invocation.rs",
    test: "invocations_are_owner_only",
    marker: "PRIVATE-CODE-MARKER",
    weaken: (s) => guard(s, unavailable)
  },
  {
    file: "invocation.rs",
    test: "collaboration::",
    marker: "PRIVATE-CODE-MARKER",
    weaken: (s) => guard(s, unavailable)
  },
  {
    file: "frame.rs",
    test: "assets_are_owner_only",
    marker: "PRIVATE-ASSET-MARKER",
    weaken: (s) => guard(s, unavailable)
  },
  {
    file: "frame.rs",
    test: "screen_is_owner_only",
    marker: "PRIVATE-ASSET-MARKER",
    weaken: (s) => guard(s, unavailable)
  },
  {
    file: "frame.rs",
    test: "navigation_is_owner_only",
    marker: "PRIVATE-NAV-MARKER",
    weaken: (s) => replace(s, "!installed.visible_to(access)", "false")
  },
  {
    file: "chat_tools.rs",
    test: "chat_tool_listing_is_owner_only",
    marker: "PRIVATE-TOOL-MARKER",
    weaken: (s) => replace(s, "!installed.visible_to(access)", "false")
  },
  {
    file: "local_lifecycle.rs",
    test: "catalog_is_owner_only",
    marker: "PRIVATE-CATALOG-MARKER",
    weaken: (s) => replace(s, ".filter(|m| m.visible_to(access))", ".filter(|_| true)")
  },
  {
    file: "local_lifecycle.rs",
    test: "package_files_are_owner_only",
    marker: "PRIVATE-ASSET-MARKER",
    weaken: (s) => {
      const at = s.indexOf("pub fn package_for_account");
      return s.slice(0, at) + guard(s.slice(at), unavailable);
    }
  },
  {
    file: "store.rs",
    test: "package_files_are_owner_only",
    marker: "PRIVATE-ASSET-MARKER",
    weaken: (s) => guard(s, "Local package reads need the builder account")
  },
  {
    file: "store.rs",
    test: "portable_exports_omit_local_packages",
    marker: "PRIVATE-EXPORT-MARKER",
    weaken: (s) =>
      replace(
        s,
        '.filter(|(_, m)| m.local_owner.is_none() && !m.manifest.id.starts_with("local."))',
        ".filter(|_| true)"
      )
  },
  {
    file: "local_lifecycle.rs",
    test: "removal_is_owner_only",
    marker: "PRIVATE-REMOVE-MARKER",
    weaken: (s) => guard(s, unavailable)
  },
  {
    file: "recovery.rs",
    test: "snapshot_listing_and_restore_are_owner_only",
    marker: "PRIVATE-SNAPSHOT-MARKER",
    weaken: (s) =>
      replace(
        s,
        's.module\n                        .starts_with(&format!("local.{}.", access.actor_user_id()))',
        's.module.starts_with("local.")'
      )
  },
  {
    file: "recovery.rs",
    test: "snapshot_resolution_is_owner_only",
    marker: "PRIVATE-SNAPSHOT-MARKER",
    weaken: (s) => guard(s, unavailable)
  },
  {
    file: "recovery.rs",
    test: "snapshot_listing_and_restore_are_owner_only",
    marker: "PRIVATE-SNAPSHOT-MARKER",
    // Resolution now checks the owner before restore's existing management check.
    // Remove both layers to prove the restore assertion reaches the protected action.
    weaken: (s) => replace(guard(s, unavailable), "self.manage(access, &module)?;", "")
  },
  {
    file: "services.rs",
    test: "collaboration::",
    marker: "PRIVATE-EVENT-MARKER",
    weaken: (s) => replace(s, "provider_entry.visible_to(access)", "true")
  },
  ...[
    "Local packages cannot use install-wide storage",
    "Local SQL must be owner-only",
    "Local credentials must be account-scoped",
    "Local packages cannot declare a core lifecycle",
    "Local dependencies must belong to the same account",
    "Local settings must be account-scoped"
  ].map((message) => ({
    file: "local_packages.rs",
    test: "local_declarations_cannot_escape_account_scope",
    marker: "PRIVATE-DECLARATION-MARKER",
    weaken: (s: string) => guard(s, message)
  }))
];
export function negativeControls(env: NodeJS.ProcessEnv): void {
  for (const control of controls) {
    const path = `rust-spike/module-host/src/${control.file}`;
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, control.weaken(original));
      const result = spawnSync(
        "cargo",
        [
          "+1.95.0",
          "test",
          "--offline",
          "--locked",
          "--manifest-path",
          "rust-spike/module-host/Cargo.toml",
          "--test",
          "phase6_local_isolation",
          control.test,
          "--",
          "--nocapture",
          "--test-threads=1"
        ],
        { env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
      );
      const output = result.stdout + result.stderr;
      if (
        result.status !== 101 ||
        !output.includes(control.marker) ||
        !output.includes("test result: FAILED")
      ) {
        process.stderr.write(output);
        throw new Error(
          `Negative control failed to expose marker: ${control.file}/${control.test}`
        );
      }
      console.log(
        `Removed ${control.file} guard: ${control.test} exposed ${control.marker} (exit 101)`
      );
    } finally {
      writeFileSync(path, original);
    }
  }
}
