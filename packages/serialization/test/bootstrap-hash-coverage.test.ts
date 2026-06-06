// The worker-side schemaHash recompute must reproduce core's hash for EVERY schema shape core
// folds into it: '!persist' per non-persisted field and '!prefabs' for a prefabs world. Without
// those, attachWorld rejected its own producer's bootstrap as "stale worker code" — zero-copy
// handoff was dead for any schema using field(t, { persist: false }) or prefabs: true.

import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, field } from '@ecsia/core'
import type { ComponentDef, Schema } from '@ecsia/core'
import { bootstrapForWorker, attachWorld } from '../src/index.js'
import type { WorldBootstrap } from '../src/index.js'

// Re-stamp shared:true with empty buffers (the attachWorld unit-test pattern) so the hash gate is
// exercised without needing a SAB-backed world.
const asShared = (boot: WorldBootstrap): WorldBootstrap =>
  ({ ...boot, shared: true, buffers: { columns: [], regions: [] } as never }) as WorldBootstrap

describe('attachWorld schemaHash — persist/prefabs coverage', () => {
  it('accepts its own producer bootstrap when a field is persist: false', () => {
    const P = defineComponent({ x: 'f32', cache: field('f32', { persist: false }) }, { name: 'p' })
    const world = createWorld({ components: [P as ComponentDef<Schema>] })
    expect(() => attachWorld(asShared(bootstrapForWorker(world)))).not.toThrow()
  })

  it('accepts its own producer bootstrap when prefabs are enabled', () => {
    const world = createWorld({ prefabs: true })
    expect(() => attachWorld(asShared(bootstrapForWorker(world)))).not.toThrow()
  })

  it('still rejects a genuinely mismatched registry', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const world = createWorld({ components: [P as ComponentDef<Schema>] })
    const boot = bootstrapForWorker(world)
    const tampered = {
      ...asShared(boot),
      registry: { ...boot.registry, schemaHash: (boot.registry.schemaHash ^ 1) >>> 0 },
    } as WorldBootstrap
    expect(() => attachWorld(tampered)).toThrow(/schemaHash mismatch/)
  })
})
