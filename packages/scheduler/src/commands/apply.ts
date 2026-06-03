// Command application seam (command-buffer.md §7). M6 ships the SINGLE-THREAD degenerate path only:
// with zero workers, every structural op a system performed already took the synchronous
// direct-apply fast path on the main thread (command-buffer.md §2.2; world.md §4.4), so there are no
// per-worker command buffers to merge and `flushAll` is a NO-OP (command-buffer.md §7.1).
//
// The interface below is the contract M7 fills: M7 adds per-worker CommandBuffers and replaces the
// no-op body with the deterministic worker-index merge + validate-then-apply (command-buffer.md §8),
// WITHOUT changing the call sites in the executor (executor/run-wave.ts). This keeps M7 additive.

import type { Op } from './op.js'

/**
 * A staged structural intent (command-buffer.md §5). M6 routes these straight to the main-thread
 * world verbs (direct-apply); M7 decodes them from per-worker SAB command buffers in merge order.
 */
export interface StructuralIntent {
  readonly op: Op
}

export interface CommandSink {
  /**
   * Apply every worker's staged command buffer to the world in fixed worker-index order
   * (command-buffer.md §7.2). M6 single-thread: a no-op (no workers, nothing staged). The serial
   * flush slot still calls it unconditionally so the M7 worker path is a drop-in.
   */
  flushAll(): void
}

/** The M6 single-thread sink: structural ops never deferred, so the flush is empty work. */
export const directApplySink: CommandSink = {
  flushAll(): void {
    // command-buffer.md §7.1 degenerate case: zero workers → zero command buffers → no-op.
  },
}
