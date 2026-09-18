import type { Repository, WalletRow } from './database.js';
import type { Command, CommandResult } from './service.js';
/** The timer is only a wake-up. Due work lives in SQLite and is rediscovered after a restart. */
export class NodeSwapRunner {
  private running?: Promise<void>;
  private closed = false;
  constructor(
    private readonly repo: Repository,
    private readonly dispatch: (row: WalletRow, command: Command) => Promise<CommandResult>,
  ) {}
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run() {
    const rows = await this.repo.db.all<WalletRow>(
      `SELECT DISTINCT w.* FROM wallets w JOIN swap_authority s ON s.wallet_id=w.id
      WHERE w.scope=? AND (s.next_at<=? OR s.dirty=1) ORDER BY s.next_at LIMIT 12`,
      [this.repo.scope, Date.now()],
    );
    // Bounded concurrency across wallets; dispatch serializes within each wallet.
    for (let i = 0; i < rows.length && !this.closed; i += 3) {
      await Promise.all(
        rows.slice(i, i + 3).map(async (row) => {
          try {
            await this.dispatch(row, { kind: 'swap-tick' });
          } catch {
            console.error({ event: 'swap_runner_retry', walletId: row.id });
          }
        }),
      );
    }
  }
  async stop() {
    this.closed = true;
    await this.running;
  }
}
