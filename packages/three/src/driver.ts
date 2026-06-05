// Frame driver (P4 deliverable 4): a tiny loop that advances the world and renders. In a browser it
// runs on requestAnimationFrame; in Node/tests there is no rAF, so `tick(dt)` is driven manually. The
// driver owns NO ECS knowledge — it just calls `update(dt)` (a scheduler's `.update` or any world-step
// fn) then `render()`.
//
// FIXED TIMESTEP (determinism note): with `fixedTimestep` set, the driver accumulates real elapsed time
// and runs `update(fixedTimestep)` zero-or-more whole steps per frame, carrying the remainder. This
// makes the simulation deterministic w.r.t. step COUNT for a given total elapsed time — identical step
// inputs regardless of frame pacing — which is what you want for reproducible physics/gameplay. `render`
// is called ONCE per frame (after the catch-up steps), so rendering is decoupled from the sim rate. With
// no `fixedTimestep`, the driver is variable-step: one `update(dt)` per frame with the real frame delta.
//
// The accumulator can grow unbounded if a frame stalls badly (the "spiral of death"); `maxSubSteps`
// caps the steps run per frame and discards the rest of the backlog so the loop recovers instead of
// freezing. Default 8.

export interface ThreeDriverOptions {
  /** Advance the simulation by `dt` seconds. Typically `scheduler.update`. */
  readonly update: (dt: number) => void
  /** Draw the current state. Called once per frame after the sim step(s). */
  readonly render: () => void
  /**
   * Fixed simulation step in seconds (e.g. 1/60). When set, the driver runs whole `update(fixedTimestep)`
   * steps to consume accumulated real time (deterministic step count). When omitted, the driver is
   * variable-step (one `update(realDelta)` per frame).
   */
  readonly fixedTimestep?: number
  /** Max fixed steps per frame before the backlog is discarded (anti spiral-of-death). Default 8. */
  readonly maxSubSteps?: number
  /**
   * The requestAnimationFrame to schedule on. Defaults to the global `requestAnimationFrame` when it
   * exists (browser). Pass one explicitly to drive a custom loop; leave undefined in Node and call
   * `tick(dt)` manually.
   */
  readonly requestAnimationFrame?: (cb: (timeMs: number) => void) => number
  /** The cancelAnimationFrame paired with the rAF above. */
  readonly cancelAnimationFrame?: (id: number) => void
}

export interface ThreeDriver {
  /** Begin the rAF loop. No-op if already running or no rAF is available (Node — use `tick`). */
  start(): void
  /** Stop the rAF loop. */
  stop(): void
  /** True while the rAF loop is running. */
  readonly running: boolean
  /**
   * Advance one frame by `dt` real seconds and render. The manual entry point for Node/tests (and the
   * loop body the rAF callback calls). Honours `fixedTimestep` (accumulates) when configured. Returns
   * the number of `update` calls made this frame.
   */
  tick(dt: number): number
}

// We don't pull in the DOM lib (this package is renderer-core only), so probe the rAF globals through a
// typed view of globalThis rather than the ambient DOM declarations.
interface RafGlobals {
  requestAnimationFrame?: (cb: (timeMs: number) => void) => number
  cancelAnimationFrame?: (id: number) => void
}

const defaultRaf = (): ((cb: (timeMs: number) => void) => number) | undefined => {
  const g = globalThis as unknown as RafGlobals
  return typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame.bind(globalThis) : undefined
}

const defaultCaf = (): ((id: number) => void) | undefined => {
  const g = globalThis as unknown as RafGlobals
  return typeof g.cancelAnimationFrame === 'function' ? g.cancelAnimationFrame.bind(globalThis) : undefined
}

export function createThreeDriver(opts: ThreeDriverOptions): ThreeDriver {
  const { update, render, fixedTimestep } = opts
  const maxSubSteps = opts.maxSubSteps ?? 8
  const raf = opts.requestAnimationFrame ?? defaultRaf()
  const caf = opts.cancelAnimationFrame ?? defaultCaf()

  let running = false
  let frameId: number | null = null
  let lastTimeMs: number | null = null
  let accumulator = 0

  const tick = (dt: number): number => {
    let steps = 0
    if (fixedTimestep !== undefined && fixedTimestep > 0) {
      accumulator += dt
      while (accumulator >= fixedTimestep && steps < maxSubSteps) {
        update(fixedTimestep)
        accumulator -= fixedTimestep
        steps++
      }
      // Discard a runaway backlog so the loop recovers rather than spiralling.
      if (accumulator >= fixedTimestep) accumulator = 0
    } else {
      update(dt)
      steps = 1
    }
    render()
    return steps
  }

  const frame = (timeMs: number): void => {
    if (!running) return
    const dt = lastTimeMs === null ? 0 : (timeMs - lastTimeMs) / 1000
    lastTimeMs = timeMs
    tick(dt)
    if (running && raf !== undefined) frameId = raf(frame)
  }

  return {
    start() {
      if (running || raf === undefined) return
      running = true
      lastTimeMs = null
      accumulator = 0
      frameId = raf(frame)
    },
    stop() {
      running = false
      if (frameId !== null && caf !== undefined) caf(frameId)
      frameId = null
    },
    get running() {
      return running
    },
    tick,
  }
}
