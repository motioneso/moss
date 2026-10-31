/** Session keys the warm-pool idle sweep spares. The api replaces the whole set over RPC (#3854). */
export class KeepWarmKeys {
  private keys: ReadonlySet<string> = new Set();

  readonly set = (sessionKeys: readonly string[]): void => {
    this.keys = new Set(sessionKeys);
  };

  readonly read = async (): Promise<ReadonlySet<string>> => this.keys;
}
