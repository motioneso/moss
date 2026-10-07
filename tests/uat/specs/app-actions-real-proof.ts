/** Match the unnormalized complete card text, never a whitespace-normalized/truncated command. */
export function isExactNativeReadSummary(actual: string | null, requestedCommand: string): boolean {
  // ACP's card renderer truncates a command at 200 characters. The requested fixture command
  // must be shorter, so a truncated longer proposal cannot equal this complete expected text.
  return (
    requestedCommand.length < 200 && actual === `The agent wants to use Bash: ${requestedCommand}`
  );
}
