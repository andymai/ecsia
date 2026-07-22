// Every meaningful byte + cursor of a RollbackImage, as plain comparable data — the golden-image
// comparison the byte-identity assertions (RB-4, RB-6) are written against.

import type { RollbackImage } from '../src/index.js'

/** The image's private shape, read only to prove a restore is byte-identical. */
export interface ImageInternals {
  seq: number
  tick: number
  identity: {
    sparse: Uint32Array
    dense: Uint32Array
    generation: Uint32Array
    recordArchetypeId: Uint32Array
    recordArchetypeRow: Uint32Array
    aliveCount: number
    denseLen: number
    spawned: number
    despawned: number
  }
  bitmaskWords: Uint32Array
  bitmaskWordCount: number
  changeVersion: Uint32Array
  changeVersionCount: number
  bitmaskSparse: Map<number, Set<number>>
  archetypes: Map<number, { seq: number; count: number; held: number; rows: Uint32Array; cells: { data: ArrayLike<number>; length: number }[] }>
}

const prefix = (a: ArrayLike<number>, n: number): number[] => Array.from(a).slice(0, n)

export function digest(image: RollbackImage): unknown {
  const img = image as unknown as ImageInternals
  const n = img.identity.denseLen
  return {
    tick: img.tick,
    cursors: [img.identity.aliveCount, n, img.identity.spawned, img.identity.despawned],
    sparse: prefix(img.identity.sparse, n),
    dense: prefix(img.identity.dense, n),
    generation: prefix(img.identity.generation, n),
    recordArchetypeId: prefix(img.identity.recordArchetypeId, n),
    recordArchetypeRow: prefix(img.identity.recordArchetypeRow, n),
    bitmask: prefix(img.bitmaskWords, img.bitmaskWordCount),
    bitmaskSparse: [...img.bitmaskSparse].map(([k, s]) => [k, [...s].sort((a, b) => a - b)]),
    changeVersion: prefix(img.changeVersion, img.changeVersionCount),
    // Empty archetypes are dropped: an archetype absent from an image restores to count 0, so an
    // entry for one created after an earlier capture carries no state the other image lacks.
    archetypes: [...img.archetypes.entries()]
      .filter(([, a]) => a.seq === img.seq && (a.count > 0 || a.held > 0))
      .map(([id, a]) => [
        id,
        a.count,
        a.held,
        prefix(a.rows, a.count + a.held), // the held (deferred-dead) range is part of the image
        a.cells.map((c) => prefix(c.data, c.length)),
      ]),
  }
}
