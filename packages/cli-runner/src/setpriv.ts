/**
 * Command lines for setpriv (util-linux): the only way to carry specific Linux
 * capabilities across an account switch. setuid()/setgid() alone — what Node's
 * `spawn({ uid, gid })` options do — clear a process's capability sets on the
 * way to a non-root account. setpriv can instead place capabilities in the
 * ambient set, the one kind that survives a program start, so a switched
 * account keeps exactly the capabilities named and none of root's others.
 */

export interface SetprivCommand {
  readonly command: string;
  readonly args: string[];
}

/**
 * Switch to an account and raise the named capabilities as inheritable and
 * ambient, then run the given program. Used once, by the launcher itself,
 * to hand the cli-runner child exactly the capabilities it needs (change file
 * ownership, switch account, switch group) instead of the full root it would
 * otherwise keep or the nothing a plain uid/gid switch would leave it with.
 */
export function buildSetprivRaiseCommand(
  command: string,
  args: readonly string[],
  identity: { uid: number; gid: number },
  capabilities: readonly string[]
): SetprivCommand {
  const capList = capabilities.map((cap) => `+${cap}`).join(",");
  return {
    command: "setpriv",
    args: [
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      "--init-groups",
      `--inh-caps=${capList}`,
      `--ambient-caps=${capList}`,
      "--",
      command,
      ...args
    ]
  };
}

/**
 * Switch to an account and drop every inheritable and ambient capability,
 * then run the given program. Used for every process started for a person
 * (the agent itself, and a build/exec command): the launcher that starts
 * these now carries ambient capabilities of its own, which would otherwise
 * pass to each of them across the program start and let any launched agent
 * switch to any account.
 */
export function buildSetprivDropCommand(
  command: string,
  args: readonly string[],
  identity: { uid: number; gid: number }
): SetprivCommand {
  return {
    command: "setpriv",
    args: [
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      "--init-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      command,
      ...args
    ]
  };
}
