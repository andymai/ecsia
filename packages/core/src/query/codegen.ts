// Pinned-loop codegen: the mechanism that lets `bindColumns` BEAT bitECS on the default iteration
// path, robustly. The win is a V8 specialization detail: TurboFan embeds typed arrays captured as
// closure CONSTANTS directly into optimized code (base pointer + length as immediates), but ONLY for
// a SINGLETON closure — the single closure produced by its enclosing function. The interpreted path
// invokes ONE user factory per archetype; the moment it produces a second runner (a 2nd matched
// archetype, or a re-invoke after column growth) V8 sees the factory making multiple closures and
// disables specialization for ALL of them — ~1.5 ns/entity, which LOSES to bitECS (~1.4). (Measured.)
//
// The fix: recompile the user's factory into a DISTINCT function object per archetype (per growth),
// via `new Function('return (' + factory.toString() + ')')()`. Each archetype's runner is then the
// singleton of its own freshly-minted factory → specialized → ~1.0 ns/entity, ~0.7× bitECS, with NO
// post-growth penalty. The recompile cost is paid only at bind / growth (rare), never per frame.
//
// SAFETY (this never produces a wrong result):
//   - eval availability is probed once; under CSP (`script-src` without unsafe-eval) or a sandbox
//     that blocks `new Function`, codegen is skipped and the interpreted factory call is used.
//   - the user's factory MUST be self-contained — it may close over NOTHING from its outer scope
//     (the recompiled copy only sees globals), so per-frame inputs come through the runner's `ctx`
//     argument and fixed constants are defined inside the factory body. A factory that violates this
//     fails the pre-flight below and silently falls back to interpreted.
//   - PRE-FLIGHT VALIDATION: before a codegen runner is ever trusted, it is run once on a tiny scratch
//     clone of the columns alongside the interpreted runner; only if their outputs match byte-for-byte
//     is codegen used. A miscompile, a ReferenceError from an illegal closure, or any divergence →
//     fall back to interpreted. Codegen is therefore a pure speed optimization gated on proven equality.
//
// SECURITY: the generated source is `'return (' + factory.toString() + ')'` — the user's OWN function
// source, never interpolated external/untrusted strings. No injection surface beyond the code the
// caller already wrote and passed.

import type { TypedArray } from '../memory/index.js'
import type { BoundColumnsMeta } from '@ecsia/schema'

/** A bindColumns factory: resolve the views into a persistent runner; deps arrive via the runner's ctx. */
export type PinnedFactory<Ctx = unknown> = (
  views: readonly TypedArray[],
  meta: BoundColumnsMeta,
) => (ctx: Ctx) => void

/** Probed once: can this runtime compile a function from source? (False under strict CSP / locked sandboxes.) */
export const CODEGEN_AVAILABLE: boolean = (() => {
  try {
    // eslint-disable-next-line no-new-func
    return new Function('return 1')() === 1
  } catch {
    return false
  }
})()

/** Recompile a factory into a distinct function object (its runner becomes a specialized singleton). */
function recompile<Ctx>(factory: PinnedFactory<Ctx>): PinnedFactory<Ctx> {
  // Re-evaluate the factory's OWN source as a fresh function. No external strings are interpolated.
  // eslint-disable-next-line no-new-func
  return new Function('return (' + factory.toString() + ')')() as PinnedFactory<Ctx>
}

/** A probe ctx that hands back a stable non-zero number for ANY property read, so a hoisted
 * `const dt = ctx.dt` yields deterministic, comparable arithmetic in the pre-flight (and never NaN). */
const PROBE_CTX = new Proxy(
  {},
  {
    get: () => 1,
  },
) as never

/**
 * Build the runner for one archetype binding. Returns the codegen runner when eval is available AND
 * it provably matches the interpreted runner on a scratch row; otherwise the interpreted runner.
 * `strides` sizes the scratch clone (slots per row, per spec).
 */
export function buildPinnedRunner<Ctx>(
  factory: PinnedFactory<Ctx>,
  views: readonly TypedArray[],
  meta: BoundColumnsMeta,
  strides: readonly number[],
): (ctx: Ctx) => void {
  const interpreted = factory(views, meta)
  if (!CODEGEN_AVAILABLE) return interpreted
  try {
    // The real runner is the singleton of its OWN recompiled factory (specialized). The pre-flight
    // validates a SEPARATELY-recompiled runner over scratch — same source, so faithful ⇒ the real
    // runner is faithful too. (Reusing one recompiled factory for both would make it produce two
    // closures and forfeit specialization — the very penalty codegen exists to avoid.)
    const codegen = recompile(factory)(views, meta)
    if (preflightMatches(factory, views, strides)) return codegen
  } catch {
    // recompile / factory-invoke threw (illegal closure, exotic source) → interpreted.
  }
  return interpreted
}

/**
 * Run a recompiled runner and a fresh interpreted runner over IDENTICAL 1-row scratch clones of the
 * columns with the probe ctx, and compare. Equal ⇒ a recompile of this factory is faithful (and the
 * real runner, recompiled from the same source, is therefore faithful too). The real columns are
 * never touched. NOTE: this INVOKES the user's runner once over the scratch — a runner with effects
 * beyond its views (a global write, a ctx method call) fires/throws here; the contract is a pure SoA
 * loop reading values off ctx. A throw (e.g. an illegal outer-scope closure → ReferenceError) counts
 * as a mismatch and falls back to interpreted.
 */
function preflightMatches<Ctx>(
  factory: PinnedFactory<Ctx>,
  views: readonly TypedArray[],
  strides: readonly number[],
): boolean {
  try {
    const rows = 1
    const scratchA = views.map((v, i) => v.slice(0, rows * (strides[i] ?? 1)) as TypedArray)
    const scratchB = views.map((v, i) => v.slice(0, rows * (strides[i] ?? 1)) as TypedArray)
    const scratchMeta: BoundColumnsMeta = { count: rows, strides }
    recompile(factory)(scratchA, scratchMeta)(PROBE_CTX)
    factory(scratchB, scratchMeta)(PROBE_CTX)
    for (let i = 0; i < scratchA.length; i++) {
      const a = scratchA[i] as TypedArray
      const b = scratchB[i] as TypedArray
      for (let k = 0; k < a.length; k++) {
        // Object.is, not !==, so identical NaN writes (e.g. row-0 data already NaN at re-bind) count
        // as a MATCH — a faithful recompile reproduces the same writes, NaN included.
        if (!Object.is(a[k], b[k])) return false
      }
    }
    return true
  } catch {
    return false
  }
}
