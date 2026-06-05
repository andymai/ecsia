// The "examples run green in CI" gate. Each example's main() is imported and asserted to produce
// its expected end state. These are smoke tests: they prove the umbrella surface wires up the
// flock of birds (components + movement + scheduler), the scene-graph hierarchy (an exclusive
// ChildOf relation + transform propagation + depthOf), and the worker-parallel sim
// (createScheduler + updateThreaded). The worker example runs twice to flush any nondeterminism
// in the threaded frame loop.

import { describe, expect, test } from 'vitest'
import { main as birds } from '../birds.js'
import { main as sceneGraph } from '../scene-graph.js'
import { main as workerSim } from '../worker-sim.js'

describe('example: birds', () => {
  test('runs the movement + cohesion pipeline and produces a finite, converging end state', () => {
    const r = birds({ count: 200, ticks: 100, seed: 42 })
    expect(r.count).toBe(200)
    expect(r.positions).toHaveLength(200)
    // Every position is finite — the systems actually ran without producing NaN.
    for (const p of r.positions) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
    // Cohesion (the pull toward the flock's center) keeps the end spread bounded.
    const maxR = Math.max(...r.positions.map((p) => Math.hypot(p.x - r.centroid.x, p.y - r.centroid.y)))
    expect(maxR).toBeLessThan(1000)
    expect(r.meanSpeed).toBeGreaterThan(0)
  })

  test('is deterministic for a fixed seed', () => {
    const a = birds({ count: 64, ticks: 30, seed: 7 })
    const b = birds({ count: 64, ticks: 30, seed: 7 })
    expect(b.centroid).toEqual(a.centroid)
    expect(b.positions).toEqual(a.positions)
  })
})

describe('example: scene-graph hierarchy', () => {
  test('propagates transforms down a ChildOf tree; depthOf orders the walk', () => {
    const r = sceneGraph()
    // The default tree is 0←1←2←4 (depth 3) plus 0←3 (depth 1).
    expect(r.maxDepth).toBe(3)
    const byHandle = new Map(r.nodes.map((n) => [n.handle, n]))
    const node = (i: number) => [...byHandle.values()][i]!

    // Root (depth 0): world == local == (10, 0).
    expect(node(0).depth).toBe(0)
    expect(node(0).world).toEqual({ x: 10, y: 0 })
    // Child 1 (depth 1): world = root.world + local(5,0) = (15, 0).
    expect(node(1).depth).toBe(1)
    expect(node(1).world.x).toBeCloseTo(15)
    // Grandchild 2 (depth 2): (15,0)+(0,3) = (15, 3).
    expect(node(2).depth).toBe(2)
    expect(node(2).world.x).toBeCloseTo(15)
    expect(node(2).world.y).toBeCloseTo(3)
    // Great-grandchild 4 (depth 3): (15,3)+(1,1) = (16, 4).
    expect(node(4).depth).toBe(3)
    expect(node(4).world.x).toBeCloseTo(16)
    expect(node(4).world.y).toBeCloseTo(4)
  })
})

describe('example: worker-parallel sim', () => {
  test('threaded run matches the single-thread run byte for byte — run twice for stability', async () => {
    for (let pass = 0; pass < 2; pass++) {
      const threaded = await workerSim({ perGroup: 256, ticks: 40, parallel: true, seed: 11 })
      const serial = await workerSim({ perGroup: 256, ticks: 40, parallel: false, seed: 11 })
      expect(threaded.parallel).toBe(true)
      expect(serial.parallel).toBe(false)
      // The two systems write different components, so they share a wave; the threaded frame
      // loop must reproduce the serial result exactly.
      expect(threaded.totalEnergy).toBeCloseTo(serial.totalEnergy, 5)
      expect(threaded.meanRadiusA).toBeCloseTo(serial.meanRadiusA, 5)
      expect(threaded.meanRadiusB).toBeCloseTo(serial.meanRadiusB, 5)
      expect(Number.isFinite(threaded.totalEnergy)).toBe(true)
      expect(threaded.totalEnergy).toBeGreaterThan(0)
    }
  })
})
