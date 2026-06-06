// Bootstrap manifest / attach edge coverage. Exercises ONLY the main-thread
// constructible parts: the serial-phase guard, the manifest+registry shape, the schemaHash recompute
// gate in attachWorld, the not-shared rejection, and applyColumnsAdded's re-wrap. NO worker is spawned
// — the worker-side views are fabricated locally to drive the pure re-wrap logic.

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent, makeColumnLayout } from '@ecsia/core'
import type { ColumnKey, ColumnLayout, ComponentDef, Schema } from '@ecsia/core'
import { bootstrapForWorker, attachWorld, applyColumnsAdded } from '../src/index.js'
import type { WorldBootstrap, WorkerWorldView, ColumnsAdded } from '../src/bootstrap.js'

describe('bootstrapForWorker — serial-phase guard + manifest shape', () => {
  it('throws off the serial slot', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const world = createWorld({ components: [P as ComponentDef<Schema>] })
    world.__setPhase('wave')
    expect(() => bootstrapForWorker(world)).toThrow(/serial phase/)
    world.__setPhase('serial')
  })

  it('carries the producer schemaHash and per-component field tokens, no value bytes', () => {
    const P = defineComponent({ x: 'f32', who: 'eid' }, { name: 'p' })
    const world = createWorld({ components: [P as ComponentDef<Schema>] })
    world.spawnWith(P as ComponentDef<Schema>)
    const boot = bootstrapForWorker(world)
    expect(boot.registry.schemaHash).toBe(world.__serialize.schemaHash())
    const comp = boot.registry.components.find((c) => c.name === 'p')
    expect(comp).toBeDefined()
    // Field (name, token) pairs are carried so the worker can recompute the same hash.
    expect(comp?.fields.map((f) => f.name)).toEqual(['x', 'who'])
    // No SAB in a single-thread world → not shared, but the registry is still present.
    expect(boot.shared).toBe(false)
    expect(typeof boot.tick).toBe('number')
    expect(boot.registry.numComponentTypes).toBeGreaterThan(0)
  })
})

describe('attachWorld — gating', () => {
  it('refuses a non-shared bootstrap (shared backing required)', () => {
    const fake: WorldBootstrap = {
      shared: false,
      handleLayout: { indexBits: 22, generationBits: 10 } as never,
      capabilities: {} as never,
      buffers: { columns: [], regions: [] } as never,
      registry: { schemaHash: 0, components: [], relations: [], numComponentTypes: 0 },
      tick: 0,
    }
    expect(() => attachWorld(fake)).toThrow(/requires a shared/)
  })

  it('refuses a shared bootstrap whose registry hash does not match its components (stale worker code)', () => {
    // shared:true with a registry whose recomputed FNV-1a hash will NOT equal the stamped schemaHash
    // (we stamp a deliberately wrong value) → the
    const fake: WorldBootstrap = {
      shared: true,
      handleLayout: { indexBits: 22, generationBits: 10 } as never,
      capabilities: {} as never,
      buffers: { columns: [], regions: [] } as never,
      registry: {
        schemaHash: 0xdeadbeef, // wrong: real hash of [comp 'p' field 'x'/'f32'] differs
        components: [{ name: 'p', id: 0, fieldCount: 1, storage: 'packed', fields: [{ name: 'x', token: 'f32', persist: true }] }],
        relations: [],
        numComponentTypes: 1,
      },
      tick: 0,
    }
    expect(() => attachWorld(fake)).toThrow(/schemaHash mismatch/)
  })

  it('accepts a shared bootstrap whose registry hash is self-consistent, re-wrapping empty buffers', () => {
    // Build a registry, compute its real hash by trusting bootstrapForWorker on an equivalent world, and
    // feed THAT hash so the recompute gate passes. The buffer set is empty → empty column/region maps.
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const world = createWorld({ components: [P as ComponentDef<Schema>] })
    const realBoot = bootstrapForWorker(world)
    const shared: WorldBootstrap = {
      ...realBoot,
      shared: true,
      buffers: { columns: [], regions: [] } as never,
    }
    const view = attachWorld(shared)
    expect(view.schemaHash).toBe(realBoot.registry.schemaHash)
    expect(view.columns.size).toBe(0)
    expect(view.regions.size).toBe(0)
    expect(view.tick).toBe(realBoot.tick)
  })
})

describe('applyColumnsAdded — re-wraps newly-broadcast column SABs', () => {
  it('adds a live typed-array view over the new backing into the worker view', () => {
    const view: WorkerWorldView = {
      columns: new Map(),
      regions: new Map(),
      handleLayout: { indexBits: 22, generationBits: 10 } as never,
      capabilities: {} as never,
      schemaHash: 0,
      tick: 0,
    }
    const layout: ColumnLayout = makeColumnLayout('u32', 1)
    const backing = new SharedArrayBuffer(16) // 4 u32 lanes
    const notice: ColumnsAdded = {
      kind: 'columns-added',
      columns: [{ key: 'k1' as ColumnKey, backing: backing as never, layout }],
    }
    applyColumnsAdded(view, notice)
    const entry = view.columns.get('k1' as ColumnKey)
    expect(entry).toBeDefined()
    expect(entry?.layout).toBe(layout)
    expect(entry?.backing).toBe(backing)
    // The view is a real Uint32Array over the SAME backing — writing through it is observable.
    ;(entry?.view as Uint32Array)[0] = 0xabcdef
    expect(new Uint32Array(backing)[0]).toBe(0xabcdef)
  })
})
