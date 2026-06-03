// Localized shim for Atomics.waitAsync (lib ES2023 omits it; it is the ES2024 addition). The runtime
// (Node >= 20, capable browsers) provides it; we only need the type to call it on the tier-1 path.
// Probed at runtime before use (selectWaitTier), so on engines that lack it this code never runs.

export interface WaitAsyncResult {
  readonly async: boolean
  readonly value: 'ok' | 'not-equal' | 'timed-out' | Promise<'ok' | 'timed-out'>
}

interface AtomicsWithWaitAsync {
  waitAsync?(typedArray: Int32Array, index: number, value: number, timeout?: number): WaitAsyncResult
}

export function hasWaitAsync(): boolean {
  return typeof (Atomics as AtomicsWithWaitAsync).waitAsync === 'function'
}

/** Call Atomics.waitAsync. Caller MUST have probed `hasWaitAsync()` first. */
export function waitAsync(view: Int32Array, index: number, value: number): WaitAsyncResult {
  const fn = (Atomics as AtomicsWithWaitAsync).waitAsync
  if (fn === undefined) throw new Error('Atomics.waitAsync unavailable (probe with hasWaitAsync first)')
  return fn(view, index, value)
}
