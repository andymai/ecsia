// Wave extraction + type-level conflict detection v1 + batch packing (scheduler.md §5). The reduced
// DAG is layered into waves (Kahn by in-degree); within a wave, two systems may run concurrently iff
// their access is DISJOINT at component-type granularity (WAVE-CONFLICT). This is the explicit
// REJECTION of becsy lane-merging: readers of a component run concurrently (§5.6).

import type { SystemId } from '@ecsia/schema'
import type { SystemBox } from '../planner/index.js'
import type { DAG } from './dag.js'

export interface SystemBatch {
  readonly systemId: SystemId
  /** 0..workerCount-1 for worker batches; -1 = main-thread slot. */
  readonly workerIndex: number
}

export interface ScheduleWave {
  /** Sequential rounds; rounds[r] runs after rounds[r-1] completes. Members of one round run concurrently. */
  readonly rounds: readonly (readonly SystemBatch[])[]
  /** Sum of maxSpawnsPerWave for systems dispatched to each worker this wave (reservation sizing). */
  readonly perWorkerSpawnHint: Uint32Array
}

export interface SchedulePlan {
  readonly waves: readonly ScheduleWave[]
  readonly systems: readonly SystemBox[]
  readonly accessStrideWords: number
  readonly workerCount: number
}

/**
 * Rule WAVE-CONFLICT (v1, scheduler.md §5.2, T5): A and B are concurrency-compatible iff write-sets
 * are disjoint AND neither writes what the other reads. Pure read–read overlap is allowed.
 * O(accessStrideWords) per pair — never per-entity, never per-archetype. This is the single seam a v2
 * column-level build narrows.
 */
export function concurrencyCompatible(a: SystemBox, b: SystemBox): boolean {
  const n = a.writeWords.length
  for (let w = 0; w < n; w++) {
    const aw = a.writeWords[w]!
    const bw = b.writeWords[w]!
    if (aw & bw) return false // write/write
    if (aw & b.readWords[w]!) return false // a-write / b-read
    if (a.readWords[w]! & bw) return false // a-read / b-write
  }
  return true
}

/** §5.1: topological layering by in-degree (Kahn). Deterministic intra-wave order: SystemId asc. */
function extractWaves(dag: DAG): SystemId[][] {
  const n = dag.n
  const indeg = new Int32Array(n)
  for (let u = 0; u < n; u++) {
    for (const v of dag.succ[u]!) indeg[v as unknown as number]! += 1
  }
  let ready: number[] = []
  for (let i = 0; i < n; i++) if (indeg[i] === 0) ready.push(i)
  const waves: SystemId[][] = []
  let placed = 0
  while (ready.length > 0) {
    ready.sort((a, b) => a - b) // deterministic order within a wave (§5.5)
    const wave = ready.map((i) => i as unknown as SystemId)
    waves.push(wave)
    placed += wave.length
    const next: number[] = []
    for (const u of ready) {
      for (const v of dag.succ[u]!) {
        const vn = v as unknown as number
        if (--indeg[vn]! === 0) next.push(vn)
      }
    }
    ready = next
  }
  if (placed !== n) {
    // A cycle slipped through — impossible after dag.ts cycle detection, but assert for safety (SCH-1).
    throw new Error(`wave extraction dropped systems (${placed}/${n}); a cycle escaped detection`)
  }
  return waves
}

/**
 * §5.3: partition a wave's systems into sequential rounds via greedy graph coloring over the
 * incompatibility graph (`A—B` iff !concurrencyCompatible). Worker-ineligible systems are pinned to a
 * main-thread slot (workerIndex -1); each round holds at most one main-thread slot.
 */
function packWave(wave: readonly SystemId[], systems: readonly SystemBox[], workerCount: number): ScheduleWave {
  interface RoundState {
    readonly members: SystemBatch[]
    readonly boxes: SystemBox[]
    hasMainThreadSlot: boolean
    nextWorker: number
  }
  const rounds: RoundState[] = []
  const perWorkerSpawn = new Uint32Array(Math.max(workerCount, 0))

  for (const id of wave) {
    const sb = systems[id as unknown as number]!
    let placed = false
    for (const round of rounds) {
      const compatible = round.boxes.every((other) => concurrencyCompatible(sb, other))
      if (!compatible) continue
      if (sb.workerEligible) {
        // Eligible system: assign to a worker slot if any worker exists, else the main-thread slot.
        if (workerCount > 0 && round.nextWorker < workerCount) {
          const wi = round.nextWorker
          round.nextWorker += 1
          round.members.push({ systemId: id, workerIndex: wi })
          round.boxes.push(sb)
          if (workerCount > 0) perWorkerSpawn[wi]! += sb.maxSpawnsPerWave
          placed = true
          break
        }
        if (workerCount === 0 && !round.hasMainThreadSlot) {
          round.hasMainThreadSlot = true
          round.members.push({ systemId: id, workerIndex: -1 })
          round.boxes.push(sb)
          placed = true
          break
        }
      } else if (!round.hasMainThreadSlot) {
        // Ineligible system: only the single main-thread slot per round (§5.3 pinning).
        round.hasMainThreadSlot = true
        round.members.push({ systemId: id, workerIndex: -1 })
        round.boxes.push(sb)
        placed = true
        break
      }
    }
    if (!placed) {
      const wi = sb.workerEligible && workerCount > 0 ? 0 : -1
      const round: RoundState = {
        members: [{ systemId: id, workerIndex: wi }],
        boxes: [sb],
        hasMainThreadSlot: wi === -1,
        nextWorker: wi === -1 ? 0 : 1,
      }
      if (wi >= 0) perWorkerSpawn[wi]! += sb.maxSpawnsPerWave
      rounds.push(round)
    }
  }

  return {
    rounds: rounds.map((r) => r.members),
    perWorkerSpawnHint: perWorkerSpawn,
  }
}

/** Build the immutable SchedulePlan from the reduced DAG (scheduler.md §5.4). */
export function buildPlan(
  systems: readonly SystemBox[],
  dag: DAG,
  accessStrideWords: number,
  workerCount: number,
): SchedulePlan {
  const waveIds = extractWaves(dag)
  const waves = waveIds.map((wave) => packWave(wave, systems, workerCount))
  return Object.freeze({
    waves,
    systems,
    accessStrideWords,
    workerCount,
  })
}
