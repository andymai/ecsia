// The Atomics wave-completion fence and the three-tier wait. The main
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

/** Worker-side completion: the last decrementer wakes the waiter. */
export function completeWave(c: WaveCounter): void {
  if (Atomics.sub(c.view, REMAINING, 1) === 1) Atomics.notify(c.view, REMAINING)
}

export function setWaveError(c: WaveCounter): void {
  Atomics.store(c.view, ERROR, 1)
}

export function waveErrored(c: WaveCounter): boolean {
  return Atomics.load(c.view, ERROR) === 1
}

/** Default wave-fence deadline. Real waves complete in microseconds-to-milliseconds; a fence still
 * unacknowledged after this long means a worker died without ACKing (a crashed/killed worker can
 * never notify, and on the blocking tier the crash event can't even be delivered to the waiter).
 * Bounding the wait converts an infinite hang into a loud error. Override via PoolConfig for
 * legitimately long-running kernels. */
export const DEFAULT_FENCE_TIMEOUT_MS = 30_000

const fenceTimeout = (ms: number): Error =>
  new Error(`wave fence timed out after ${ms}ms — a worker likely crashed without acknowledging its wave (raise fenceTimeoutMs if kernels legitimately run this long)`)

/**
 * Build a WaveSync for the chosen tier. `await` MUST loop on Atomics.load(remaining) even after a
 * wake (spurious wakeups + the epoch guard), resolving only when remaining === 0 — or throw once
 * the fence deadline passes with the count still nonzero.
 */
export function makeWaveSync(tier: WaveSyncTier, fenceTimeoutMs: number = DEFAULT_FENCE_TIMEOUT_MS): WaveSync {
  function begin(c: WaveCounter, batchCount: number): void {
    Atomics.store(c.view, REMAINING, batchCount)
    Atomics.add(c.view, EPOCH, 1) // epoch bump: a stale notify from a previous round is ignored
    Atomics.store(c.view, ERROR, 0)
  }

  function awaitTier1(c: WaveCounter): Promise<void> {
    // Tier 1: Atomics.waitAsync — browser main thread (non-blocking). Loop until remaining === 0.
    const step = async (): Promise<void> => {
      const deadline = Date.now() + fenceTimeoutMs
      while (Atomics.load(c.view, REMAINING) !== 0) {
        const left = deadline - Date.now()
        if (left <= 0) throw fenceTimeout(fenceTimeoutMs)
        const r = waitAsync(c.view, REMAINING, Atomics.load(c.view, REMAINING) as number, Math.min(left, 1000))
        if (r.async) await (r.value as Promise<unknown>)
      }
    }
    return step()
  }

  function awaitTier2(c: WaveCounter): void {
    // Tier 2: blocking Atomics.wait — Node main thread or coordinator/worker may block directly.
    // Sliced waits: a blocked thread can't receive the crash event, so the deadline is the ONLY
    // way a dead worker's fence ever resolves here.
    const deadline = Date.now() + fenceTimeoutMs
    while (true) {
      const remaining = Atomics.load(c.view, REMAINING)
      if (remaining === 0) return
      const left = deadline - Date.now()
      if (left <= 0) throw fenceTimeout(fenceTimeoutMs)
      Atomics.wait(c.view, REMAINING, remaining, Math.min(left, 1000))
    }
  }

  async function awaitTier3(c: WaveCounter): Promise<void> {
    // Tier 3: promise-poll — SAB present, waitAsync absent. Poll on a microtask/timeout.
    const deadline = Date.now() + fenceTimeoutMs
    while (Atomics.load(c.view, REMAINING) !== 0) {
      if (Date.now() > deadline) throw fenceTimeout(fenceTimeoutMs)
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
