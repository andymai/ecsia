// The binding registry ( deliverable 1): a world-scoped map EntityHandle → THREE.Object3D, with
// automatic teardown when the entity goes away. This is the seam every other bridge piece reads: the
// transform-sync system walks the ECS columns and writes into the Object3D `objectOf(handle)` returns.
//
// Auto-unbind: we register an onRemove observer per bound component-set? No — entities carry arbitrary
// components, so there is no single component whose removal means "despawned". Instead we drive
// teardown off the world's despawn lifecycle directly. The public reactive surface that fires on
// despawn is the onRemove observer (despawn enqueues a remove for every held
// component, so onRemove(C) fires for each held C). But a registry that must catch EVERY despawn
// regardless of which components an entity holds cannot key off one component. So we expose an
// explicit `sweep()` the driver calls each frame AND, for the common case, an onRemove observer over a
// caller-supplied "anchor" component (typically the position component the renderer syncs). When the
// anchor is removed/despawned the binding is dropped. Both paths are lenient-read safe: the observer
// handler only reads `e.handle` (a pooled-ref-stable scalar), never a rich field of a dying entity.

import type { EntityHandle, ComponentDef, Schema } from '@ecsia/schema'
import type { ObserverHandle } from '@ecsia/core'
import { onRemove } from '@ecsia/core'
import type { Object3D, Scene } from 'three'
import type { WorldLike } from './schema.js'

export interface ThreeBindings {
  /** Associate `object3d` with `handle`. If `scene` was provided, the object is added to it. Re-binding
   * a handle replaces (and detaches from the scene) the previous object. */
  bind(handle: EntityHandle, object3d: Object3D): void
  /** Drop the binding for `handle` (and remove its object from the scene if one was provided). No-op if
   * unbound. Returns the object that was bound, or undefined. */
  unbind(handle: EntityHandle): Object3D | undefined
  /** The Object3D bound to `handle`, or undefined. */
  objectOf(handle: EntityHandle): Object3D | undefined
  /** True if `handle` currently has a bound object. */
  has(handle: EntityHandle): boolean
  /** Number of live bindings. */
  readonly size: number
  /** Iterate the live (handle, object) pairs. */
  entries(): IterableIterator<[EntityHandle, Object3D]>
  /**
   * Auto-unbind when `anchor` is removed from an entity OR the entity despawns (onRemove fires on both,
   * ). Returns the observer handle so the caller can dispose it; registering twice for
   * the same anchor is idempotent (the second call returns the existing handle). The handler reads only
   * `e.handle` — a scalar safe to read under the lenient pooled-ref rules even for a dying entity.
   */
  autoUnbindOn(anchor: ComponentDef<Schema>): ObserverHandle
  /**
   * Drop every binding whose entity is no longer alive (`world.isAlive(handle) === false`). The
   * belt-and-suspenders path for entities despawned without an `autoUnbindOn` anchor. O(size). The frame
   * driver / scheduler can call this once per frame; most apps prefer `autoUnbindOn` (O(despawns)).
   */
  sweep(): number
  /** Drop all bindings (detaching every object from the scene). */
  clear(): void
}

export function createThreeBindings(world: WorldLike, scene?: Scene): ThreeBindings {
  // Keyed by entity INDEX, not the full handle: an onRemove observer fires with the entity's
  // POST-despawn handle (the slot generation is already bumped at drain time), so a handle-keyed map
  // would miss the despawned entity. The index is the stable identity across generations, so bind() and
  // the observer's unbind() resolve to the same slot. The bind-time handle is stored alongside the
  // object so `entries()` and `sweep()` (isAlive) can report/test it.
  const map = new Map<number, { handle: EntityHandle; object: Object3D }>()
  const anchorObservers = new Map<number, ObserverHandle>()
  const indexOf = (handle: EntityHandle): number => world.decodeHandle(handle).index as unknown as number

  const detach = (object3d: Object3D): void => {
    if (scene !== undefined && object3d.parent === scene) scene.remove(object3d)
  }

  const unbind = (handle: EntityHandle): Object3D | undefined => {
    const index = indexOf(handle)
    const prev = map.get(index)
    if (prev === undefined) return undefined
    map.delete(index)
    detach(prev.object)
    return prev.object
  }

  return {
    bind(handle, object3d) {
      const index = indexOf(handle)
      const prev = map.get(index)
      if (prev !== undefined && prev.object !== object3d) detach(prev.object)
      map.set(index, { handle, object: object3d })
      if (scene !== undefined && object3d.parent === null) scene.add(object3d)
    },
    unbind,
    objectOf(handle) {
      return map.get(indexOf(handle))?.object
    },
    has(handle) {
      return map.has(indexOf(handle))
    },
    get size() {
      return map.size
    },
    *entries() {
      for (const { handle, object } of map.values()) {
        yield [handle, object] as [EntityHandle, Object3D]
      }
    },
    autoUnbindOn(anchor) {
      const id = anchor.id as unknown as number
      const existing = anchorObservers.get(id)
      if (existing !== undefined) return existing
      const sub = world.observe(onRemove(anchor), (e) => {
        // Index slots recycle before the frame-end drain runs: a same-frame despawn+spawn can hand
        // this index to a NEW entity that bound its own object — and the despawn event's handle
        // carries the BUMPED generation, so it aliases the new tenant's handle exactly (handle
        // equality cannot discriminate). The declarative rule instead: a binding survives iff its
        // entity is alive AND still carries the anchor at drain time.
        const entry = map.get(indexOf(e.handle))
        if (entry === undefined) return
        if (!world.isAlive(entry.handle) || !world.has(entry.handle, anchor)) unbind(entry.handle)
      })
      // Wrap dispose so a disposed handle is not cached forever — returning the dead handle on the
      // next autoUnbindOn(anchor) would leave auto-unbind silently inert for that anchor.
      const wrapped: ObserverHandle = {
        ...sub,
        dispose: () => {
          anchorObservers.delete(id)
          sub.dispose()
        },
      }
      anchorObservers.set(id, wrapped)
      return wrapped
    },
    sweep() {
      let dropped = 0
      for (const [index, entry] of [...map]) {
        if (!world.isAlive(entry.handle)) {
          map.delete(index)
          detach(entry.object)
          dropped++
        }
      }
      return dropped
    },
    clear() {
      for (const { object } of map.values()) detach(object)
      map.clear()
    },
  }
}
