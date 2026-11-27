/**
 * Firewall approval for module server gates.
 *
 * Only disposable CI answers the graphical approval with a scripted approval.
 * The production helper still adds, checks and removes the real firewall rule.
 * Local runs return nothing, so the normal owner prompt still happens.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function ciFirewallApproval(target: string): Record<string, string> {
  if (process.env.GITHUB_ACTIONS !== "true") return {};
  if (spawnSync("sudo", ["-n", "ufw", "show", "added"], { stdio: "inherit" }).status !== 0) {
    throw new Error("The CI firewall approval needs passwordless sudo and ufw");
  }
  const standIn = join(target, "firewall-approve");
  writeFileSync(standIn, '#!/bin/sh\nexec sudo -n -- "$@"\n', { mode: 0o700 });
  chmodSync(standIn, 0o700);
  return { MOSS_FIREWALL_STAND_IN: standIn };
}
