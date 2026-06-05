// The Atomics wave-completion fence (scheduler.md §7.1) and the three-tier wait (§7.3). The main
// thread dispatches a round's batches, then waits until every worker has decremented the SAB counter
// to zero. The tier is chosen ONCE at world creation by the capability probe (selectWaitTier, seams.ts).
//
// WaveCounter words: [0]=remaining [1]=epoch [2]=errorFlag [3]=padding.

import type { WaveCounter, WaveSync, WaveSyncTier } from '../executor/seams.js'
import { waitAsync } from './atomics-shim.js'

const REMAINING = 0
const EPOCH = 1
const ERROR = 2

/**
 * Words [0..3] are the control block (remaining, epoch, errorFlag, padding); words [4..4+workers)
 * are the per-worker buffer `head` each worker stores before completing, so the main thread reads the
 * record count after the fence without any postMessage on the hot path (tier-2 blocking-main path).
 */
export function makeWaveCounter(workers: number): WaveCounter {
  const sab = new SharedArrayBuffer((4 + Math.max(workers, 0)) * 4)
  return { sab, view: new Int32Array(sab) }
}

export function workerHead(c: WaveCounter, workerIndex: number): number {
  return Atomics.load(c.view, 4 + workerIndex)
}

/** Worker-side completion (scheduler.md §7.1): the last decrementer wakes the waiter. */
export function completeWave(c: WaveCounter): void {
  if (Atomics.sub(c.view, REMAINING, 1) === 1) Atomics.notify(c.view, REMAINING)
}

export function setWaveError(c: WaveCounter): void {
  Atomics.store(c.view, ERROR, 1)
}

export function waveErrored(c: WaveCounter): boolean {
  return Atomics.load(c.view, ERROR) === 1
}

/**
 * Build a WaveSync for the chosen tier. `await` MUST loop on Atomics.load(remaining) even after a
 * wake (spurious wakeups + the epoch guard), resolving only when remaining === 0 (SCH-8).
 */
export function makeWaveSync(tier: WaveSyncTier): WaveSync {
  function begin(c: WaveCounter, batchCount: number): void {
    Atomics.store(c.view, REMAINING, batchCount)
    Atomics.add(c.view, EPOCH, 1) // epoch bump: a stale notify from a previous round is ignored
    Atomics.store(c.view, ERROR, 0)
  }

  function awaitTier1(c: WaveCounter): Promise<void> {
    // Tier 1: Atomics.waitAsync — browser main thread (non-blocking). Loop until remaining === 0.
    const step = async (): Promise<void> => {
      while (Atomics.load(c.view, REMAINING) !== 0) {
        const r = waitAsync(c.view, REMAINING, Atomics.load(c.view, REMAINING) as number)
        if (r.async) await (r.value as Promise<unknown>)
      }
    }
    return step()
  }

  function awaitTier2(c: WaveCounter): void {
    // Tier 2: blocking Atomics.wait — Node main thread or coordinator/worker may block directly.
    while (true) {
      const remaining = Atomics.load(c.view, REMAINING)
      if (remaining === 0) return
      Atomics.wait(c.view, REMAINING, remaining)
    }
  }

  async function awaitTier3(c: WaveCounter): Promise<void> {
    // Tier 3: promise-poll — SAB present, waitAsync absent. Poll on a microtask/timeout.
    while (Atomics.load(c.view, REMAINING) !== 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  return {
    begin,
    complete: completeWave,
    await(c: WaveCounter): Promise<void> | void {
      switch (tier) {
        case 'waitAsync':
          return awaitTier1(c)
        case 'coordinator-block':
          return awaitTier2(c)
        case 'promise-poll':
          return awaitTier3(c)
        case 'postMessage':
          // No Atomics fence in the postMessage transport — the pool resolves the round on message
          // completion (pool.ts), so this is never reached. Provide a poll for safety.
          return awaitTier3(c)
      }
    },
  }
}
