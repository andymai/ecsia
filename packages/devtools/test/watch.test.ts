// watchWorld (§2): per-frame deltas across REAL frames. We drive a real scheduler that spawns, writes,
// and despawns on known frames, then assert the EXACT delta counts the watcher reports at each tick —
// and that dispose() stops the callbacks cleanly.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, write } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import { watchWorld } from '../src/index.js'
import type { FrameDelta } from '../src/index.js'

describe('watchWorld — exact per-frame deltas over real frames', () => {
  function run() {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const world = createWorld({ components: [Health], maxEntities: 1024 })

    // Frame schedule:
    //  frame 0: spawn 3 entities.
    //  frame 1: write Health on all 3 (3 change-tracked writes).
    //  frame 2: despawn 1.
    //  frame 3: no-op.
    let n = 0
    const handles: number[] = []
    const Sys = defineSystem({
      name: 'Sys',
      read: [],
      write: [Health],
      run({ world: w, query }) {
        if (n === 0) {
          for (let i = 0; i < 3; i++) handles.push(w.spawnWith([Health, { hp: 10 }]) as number)
        } else if (n === 1) {
          for (const e of query(write(Health))) e.health.hp -= 1
        } else if (n === 2) {
          w.despawn(handles[0] as never)
        }
        n++
      },
    })

    const sched = createScheduler(world, [Sys])
    const frames: FrameDelta[] = []
    const watcher = watchWorld(world, { onFrame: (d) => frames.push(d) })
    return { sched, watcher, frames }
  }

  test('emits exactly one delta per tick with monotonic frame indices', () => {
    const { sched, watcher, frames } = run()
    for (let f = 0; f < 4; f++) {
      sched.update(1)
      watcher.tick()
    }
    expect(frames.length).toBe(4)
    expect(frames.map((f) => f.frame)).toEqual([0, 1, 2, 3])
    watcher.dispose()
  })

  test('spawned/despawned totals match the exact entity lifecycle', () => {
    const { sched, watcher, frames } = run()
    for (let f = 0; f < 4; f++) {
      sched.update(1)
      watcher.tick()
    }

    // Exactly 3 spawns and exactly 1 despawn observed across the run.
    expect(frames.reduce((s, f) => s + f.spawned, 0)).toBe(3)
    expect(frames.reduce((s, f) => s + f.despawned, 0)).toBe(1)

    // Net alive delta over the whole run is +2 (3 spawned − 1 despawned).
    expect(frames.reduce((s, f) => s + f.aliveDelta, 0)).toBe(2)
    watcher.dispose()
  })

  test('changed-component counts attribute the writes to the right component by name', () => {
    const { sched, watcher, frames } = run()
    for (let f = 0; f < 4; f++) {
      sched.update(1)
      watcher.tick()
    }

    // change-tracking fires on BOTH the spawn-time initial hp writes (frame 0, 3 entities) and the
    // explicit hp decrement (frame 1, 3 entities) → exactly 6 Health changes total, all named 'health'.
    const healthChanges = frames.reduce((s, f) => s + (f.changedComponents['health'] ?? 0), 0)
    expect(healthChanges).toBe(6)
    const changedTotal = frames.reduce((s, f) => s + f.changedTotal, 0)
    expect(changedTotal).toBe(6)

    // Per-frame distribution: 3 on the spawn frame, 3 on the write frame, 0 thereafter.
    expect(frames[0]!.changedComponents).toEqual({ health: 3 })
    expect(frames[1]!.changedComponents).toEqual({ health: 3 })
    expect(frames[2]!.changedComponents).toEqual({})
    expect(frames[3]!.changedComponents).toEqual({})

    // The watcher attributes every change to a SINGLE named bucket (no stray ids).
    for (const f of frames) expect(Object.keys(f.changedComponents).every((k) => k === 'health')).toBe(true)
    watcher.dispose()
  })

  test('archetypesCreated never goes negative and is positive when the first archetype appears', () => {
    const { sched, watcher, frames } = run()
    for (let f = 0; f < 4; f++) {
      sched.update(1)
      watcher.tick()
    }
    for (const f of frames) expect(f.archetypesCreated).toBeGreaterThanOrEqual(0)
    // Spawning the first Health entities materialized a new archetype.
    expect(frames.reduce((s, f) => s + f.archetypesCreated, 0)).toBeGreaterThanOrEqual(1)
    watcher.dispose()
  })

  test('dispose() stops callbacks — no further frames after disposal', () => {
    const { sched, watcher, frames } = run()
    for (let f = 0; f < 4; f++) {
      sched.update(1)
      watcher.tick()
    }
    const n = frames.length
    expect(n).toBe(4)

    watcher.dispose()
    // tick() after dispose is a no-op; further scheduler updates push nothing.
    sched.update(1)
    watcher.tick()
    sched.update(1)
    watcher.tick()
    expect(frames.length).toBe(n)

    // dispose is idempotent.
    expect(() => watcher.dispose()).not.toThrow()
  })

  test('every emitted delta is a plain serializable object', () => {
    const { sched, watcher, frames } = run()
    sched.update(1)
    watcher.tick()
    const round = JSON.parse(JSON.stringify(frames[0]))
    expect(typeof round.frame).toBe('number')
    expect(typeof round.spawned).toBe('number')
    expect(typeof round.changedComponents).toBe('object')
    watcher.dispose()
  })
})
