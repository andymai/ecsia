// Wave visualizer: explain the WHY of a schedule, not just the what. Reads the scheduler's
// immutable, frozen `SchedulePlan` (the public plan-introspection types) and derives, as a plain
// serializable PlanExplain: the waves/batches with per-system access + worker-eligibility, the
// component-level access CONFLICTS that forced systems apart, and the systems PINNED to the main thread.

import type { SchedulePlan, SchedulerHandle, SystemBox } from '@ecsia/scheduler'
import type { PlanExplain, WaveExplain, BatchExplain, SystemExplain, ConflictExplain, PinExplain } from './types.js'

/** Accept either a built SchedulerHandle or its `.plan` directly. */
export type PlanLike = SchedulePlan | SchedulerHandle

function planOf(input: PlanLike): SchedulePlan {
  return 'plan' in input ? input.plan : input
}

/**
 * Explain a plan. `names` maps ComponentId → a human name; pass the inspector's componentNameMap, or
 * omit it to render ids as `#id`. The plan carries dense ComponentIds (incl. synthetic pair ids), so a
 * name miss is rendered, never thrown.
 */
export function explainPlan(input: PlanLike, names?: ReadonlyMap<number, string>): PlanExplain {
  const plan = planOf(input)
  const nameOf = (id: number): string => names?.get(id) ?? `#${id}`
  const systems = plan.systems

  const explainSystem = (sb: SystemBox): SystemExplain => ({
    name: sb.name,
    reads: (sb.readIds as readonly number[]).map((c) => nameOf(c)),
    writes: (sb.writeIds as readonly number[]).map((c) => nameOf(c)),
    publishes: sb.publishTopics.map((t) => t.name),
    consumes: sb.consumeTopics.map((t) => t.name),
    workerEligible: sb.workerEligible,
  })

  // --- waves / batches: each round is a concurrent batch; round order is the within-wave sequence ---
  const waves: WaveExplain[] = plan.waves.map((wave, index) => {
    const batches: BatchExplain[] = wave.rounds.map((round) => ({
      systems: round.map((batch) => explainSystem(systems[batch.systemId as unknown as number]!)),
    }))
    return { index, batches }
  })

  // --- pinned: every system landing in a main-thread slot (workerIndex -1). Reason discriminates
  // the structural ineligibility cause (rich fields) from an eligible-but-main-thread placement
  // (e.g. a single-threaded plan, workers === 0). Topic consumers stopped being a pin cause when
  // worker-side consume shipped — a consumer pins only if its components carry rich fields. ---
  const pinReason = (sb: SystemBox): PinExplain['reason'] => {
    if (sb.workerEligible) return 'main-thread'
    return 'rich-fields'
  }
  const pinnedSeen = new Set<number>()
  const pinned: PinExplain[] = []
  for (const wave of plan.waves) {
    for (const round of wave.rounds) {
      for (const batch of round) {
        if (batch.workerIndex !== -1) continue
        const id = batch.systemId as unknown as number
        if (pinnedSeen.has(id)) continue
        pinnedSeen.add(id)
        const sb = systems[id]!
        pinned.push({ system: sb.name, reason: pinReason(sb) })
      }
    }
  }

  // --- conflicts: a pair of systems with overlapping access (write-write or read-write, the
  // WAVE-CONFLICT rule) that the plan ACTUALLY separated — i.e. it placed them in
  // different waves, or in different rounds of the same wave. Two systems whose access overlaps but
  // that the plan kept CONCURRENT (same round) were NOT forced apart: the scheduler suppressed the
  // edge via an `inAnyOrderWith` deny (or they only read-read overlap), so reporting them would lie
  // about the schedule. We read the real placement here rather than re-deriving the ordering decision,
  // so the list never drifts from what the scheduler did. Reported per offending component so the user
  // sees exactly WHICH datum forced the ordering. Pair order (a,b) is plan SystemId-ascending. ---

  // Map each placed systemId → its (wave, round) coordinate in the real plan.
  const placement = new Map<number, { wave: number; round: number }>()
  plan.waves.forEach((wave, wi) => {
    wave.rounds.forEach((round, ri) => {
      for (const batch of round) placement.set(batch.systemId as unknown as number, { wave: wi, round: ri })
    })
  })
  // Two systems are concurrent iff the plan put them in the SAME wave AND the SAME round.
  const separated = (i: number, j: number): boolean => {
    const pa = placement.get(i)
    const pb = placement.get(j)
    if (pa === undefined || pb === undefined) return true
    return pa.wave !== pb.wave || pa.round !== pb.round
  }

  const conflicts: ConflictExplain[] = []
  for (let i = 0; i < systems.length; i++) {
    const a = systems[i]!
    const aReads = new Set((a.readIds as readonly number[]).map((c) => c as number))
    const aWrites = new Set((a.writeIds as readonly number[]).map((c) => c as number))
    for (let j = i + 1; j < systems.length; j++) {
      if (!separated(i, j)) continue // deny-suppressed / read-read concurrent pair — not forced apart
      const b = systems[j]!
      const bReads = new Set((b.readIds as readonly number[]).map((c) => c as number))
      const bWrites = new Set((b.writeIds as readonly number[]).map((c) => c as number))
      const reported = new Set<number>()
      for (const c of aWrites) {
        if (bWrites.has(c)) {
          conflicts.push({ a: a.name, b: b.name, on: nameOf(c), kind: 'write-write' })
          reported.add(c)
        }
      }
      for (const c of aWrites) {
        if (reported.has(c)) continue
        if (bReads.has(c)) {
          conflicts.push({ a: a.name, b: b.name, on: nameOf(c), kind: 'read-write' })
          reported.add(c)
        }
      }
      for (const c of bWrites) {
        if (reported.has(c)) continue
        if (aReads.has(c)) {
          conflicts.push({ a: a.name, b: b.name, on: nameOf(c), kind: 'read-write' })
          reported.add(c)
        }
      }
    }
  }

  return { waves, conflicts, pinned }
}
