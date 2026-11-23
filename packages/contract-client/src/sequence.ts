/**
 * @file Automatic sequence number management with local speculative queue.
 * Prevents sequence collision errors when submitting consecutive transactions from the same account.
 */

export interface PendingSequence {
  sequence: bigint;
  timestamp: number;
}

export interface AccountSequenceState {
  currentSequence: bigint;
  pendingQueue: PendingSequence[];
  lock: Promise<void>;
}

/**
 * Manages speculative transaction sequence numbers across one or more Stellar accounts.
 */
export class AccountSequenceManager {
  private accounts = new Map<string, AccountSequenceState>();

  /**
   * Initializes or returns the sequence state for a given address.
   */
  private getOrCreateAccountState(address: string): AccountSequenceState {
    let state = this.accounts.get(address);
    if (!state) {
      state = {
        currentSequence: 0n,
        pendingQueue: [],
        lock: Promise.resolve(),
      };
      this.accounts.set(address, state);
    }
    return state;
  }

  /**
   * Acquires an atomic lock for mutations on a specific account address.
   */
  private async withLock<T>(address: string, operation: (state: AccountSequenceState) => Promise<T>): Promise<T> {
    const state = this.getOrCreateAccountState(address);
    let releaseLock: () => void = () => {};
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const previousLock = state.lock;
    state.lock = (async () => {
      try {
        await previousLock;
      } catch {
        // Ignore previous errors so subsequent operations are not permanently blocked
      }
      await nextLock;
    })();

    await previousLock;
    try {
      return await operation(state);
    } finally {
      releaseLock();
    }
  }

  /**
   * Atomically gets the next speculative sequence number for an account.
   * If this is the first call or the queue is empty, syncs from `fetchOnChain`.
   *
   * @param address - Stellar G-address of the source account.
   * @param fetchOnChain - Async callback to fetch current confirmed sequence from the network RPC.
   * @returns Next speculative sequence number as a bigint.
   */
  public async nextSequence(
    address: string,
    fetchOnChain: () => Promise<bigint | string>,
  ): Promise<bigint> {
    return this.withLock(address, async (state) => {
      if (state.currentSequence === 0n && state.pendingQueue.length === 0) {
        const rawOnChain = await fetchOnChain();
        state.currentSequence = BigInt(rawOnChain);
      }

      state.currentSequence += 1n;
      const assigned = state.currentSequence;
      state.pendingQueue.push({
        sequence: assigned,
        timestamp: Date.now(),
      });

      return assigned;
    });
  }

  /**
   * Gets the current speculative sequence number without incrementing.
   */
  public async getSequence(
    address: string,
    fetchOnChain?: () => Promise<bigint | string>,
  ): Promise<bigint> {
    return this.withLock(address, async (state) => {
      if (state.currentSequence === 0n && fetchOnChain) {
        const raw = await fetchOnChain();
        state.currentSequence = BigInt(raw);
      }
      return state.currentSequence;
    });
  }

  /**
   * Confirms that a transaction with the given sequence has successfully landed on-chain.
   * Prunes all pending sequences less than or equal to this sequence.
   */
  public async confirmSequence(address: string, sequence: bigint | string): Promise<void> {
    const seq = BigInt(sequence);
    return this.withLock(address, async (state) => {
      state.pendingQueue = state.pendingQueue.filter((item) => item.sequence > seq);
      if (seq > state.currentSequence) {
        state.currentSequence = seq;
      }
    });
  }

  /**
   * Handles a transaction failure by rolling back speculative state and optionally resyncing from RPC.
   *
   * @param address - Stellar G-address of the source account.
   * @param failedSequence - The sequence number of the transaction that failed.
   * @param fetchOnChain - Optional callback to resync the exact confirmed sequence from RPC.
   */
  public async rollbackSequence(
    address: string,
    failedSequence: bigint | string,
    fetchOnChain?: () => Promise<bigint | string>,
  ): Promise<void> {
    const failedSeq = BigInt(failedSequence);
    return this.withLock(address, async (state) => {
      // Remove failed sequence and any higher sequences that depended on it
      state.pendingQueue = state.pendingQueue.filter((item) => item.sequence < failedSeq);

      if (fetchOnChain) {
        const onChain = await fetchOnChain();
        const onChainSeq = BigInt(onChain);
        state.currentSequence = onChainSeq;
        // Re-adjust pending queue if any remaining
        state.pendingQueue = state.pendingQueue.filter((item) => item.sequence > onChainSeq);
      } else {
        // Rollback currentSequence to highest remaining pending or the failedSeq - 1
        const highestPending = state.pendingQueue.length > 0
          ? state.pendingQueue[state.pendingQueue.length - 1].sequence
          : failedSeq - 1n;
        state.currentSequence = highestPending;
      }
    });
  }

  /**
   * Returns the count of pending in-flight transactions for an account.
   */
  public getPendingCount(address: string): number {
    const state = this.accounts.get(address);
    return state ? state.pendingQueue.length : 0;
  }

  /**
   * Returns a copy of pending sequences currently tracked for an account.
   */
  public getPendingSequences(address: string): PendingSequence[] {
    const state = this.accounts.get(address);
    return state ? [...state.pendingQueue] : [];
  }

  /**
   * Resets sequence tracking for an address, or clears all accounts.
   */
  public reset(address?: string): void {
    if (address) {
      this.accounts.delete(address);
    } else {
      this.accounts.clear();
    }
  }
}

/** Global default singleton sequence manager instance */
export const defaultSequenceManager = new AccountSequenceManager();
