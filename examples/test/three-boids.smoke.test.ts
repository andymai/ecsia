// Smoke test for the @ecsia/three boids bridge example. Asserts the THREE side tracks the simulation:
// every bound Object3D matches its entity's ECS position, and the InstancedMesh's per-slot translations
// reproduce the flock — proving makeTransformSyncSystem + makeInstancedSyncSystem ran against real
// THREE objects (headless, no renderer).

import { describe, expect, test } from 'vitest'
import { main as threeBoids } from '../three-boids.js'

describe('example: three-boids (ecsia ↔ THREE bridge)', () => {
  test('bound Object3Ds and the InstancedMesh track the simulation exactly', () => {
    const r = threeBoids({ count: 64, ticks: 90, seed: 1 })

    expect(r.count).toBe(64)
    expect(r.ticks).toBe(90)

    // The transform-sync system copies columns → Object3D each frame: zero drift at end state.
    expect(r.maxObjectDrift).toBe(0)

    // The instanced mesh holds exactly one slot per boid.
    expect(r.instanceCount).toBe(64)
    expect(r.instanceTranslationsByX.length).toBe(64)

    // The instance translations are the SAME multiset as the Object3D positions (both fed from the same
    // columns). Compare sorted-by-x.
    const objByX = [...r.objectPositions].sort((a, b) => a.x - b.x)
    for (let i = 0; i < objByX.length; i++) {
      expect(r.instanceTranslationsByX[i]!.x).toBeCloseTo(objByX[i]!.x, 4)
      expect(r.instanceTranslationsByX[i]!.y).toBeCloseTo(objByX[i]!.y, 4)
      expect(r.instanceTranslationsByX[i]!.z).toBeCloseTo(objByX[i]!.z, 4)
    }

    // Cohesion actually pulled the flock together: the spread is far smaller than the 200-unit spawn box.
    const spread = Math.max(...r.objectPositions.map((p) => Math.hypot(p.x - r.centroid.x, p.y - r.centroid.y, p.z - r.centroid.z)))
    expect(spread).toBeLessThan(200)
  })

  test('is deterministic for a fixed seed', () => {
    const a = threeBoids({ count: 32, ticks: 40, seed: 7 })
    const b = threeBoids({ count: 32, ticks: 40, seed: 7 })
    expect(a.objectPositions).toEqual(b.objectPositions)
    expect(a.centroid).toEqual(b.centroid)
  })
})
