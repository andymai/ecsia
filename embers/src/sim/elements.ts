// The element table: ids, matter categories, physical properties, transitions, and the render
// palette — one source of truth for the CA kernel, the brush UI, and the WebGL palette uniforms.
//
// 18 elements: core movers (sand/water/wall/fire/smoke/steam/oil/acid), thermal
// (lava/ice/glass/salt), explosives (gunpowder/nitro/fuse), life (plant/wood/virus).

export const E_NONE = 0
export const E_WALL = 1
export const E_SAND = 2
export const E_WATER = 3
export const E_OIL = 4
export const E_FIRE = 5
export const E_SMOKE = 6
export const E_STEAM = 7
export const E_ACID = 8
export const E_LAVA = 9
export const E_ICE = 10
export const E_GLASS = 11
export const E_SALT = 12
export const E_GUNPOWDER = 13
export const E_NITRO = 14
export const E_FUSE = 15
export const E_PLANT = 16
export const E_WOOD = 17
export const E_VIRUS = 18
export const ELEM_COUNT = 19

export const CAT_EMPTY = 0
export const CAT_SOLID = 1
export const CAT_POWDER = 2
export const CAT_LIQUID = 3
export const CAT_GAS = 4

/** Matter category per element. */
export const CATEGORY = new Uint8Array([
  CAT_EMPTY, // NONE
  CAT_SOLID, // WALL
  CAT_POWDER, // SAND
  CAT_LIQUID, // WATER
  CAT_LIQUID, // OIL
  CAT_GAS, // FIRE
  CAT_GAS, // SMOKE
  CAT_GAS, // STEAM
  CAT_LIQUID, // ACID
  CAT_LIQUID, // LAVA
  CAT_SOLID, // ICE
  CAT_SOLID, // GLASS
  CAT_POWDER, // SALT
  CAT_POWDER, // GUNPOWDER
  CAT_LIQUID, // NITRO
  CAT_SOLID, // FUSE
  CAT_SOLID, // PLANT
  CAT_SOLID, // WOOD
  CAT_SOLID, // VIRUS
])

/**
 * Density ranks displacement: a mover sinks through anything with strictly lower density.
 * Gases: lower = rises harder. Scale is relative, not physical.
 */
export const DENSITY = new Float32Array([
  0, // NONE
  100, // WALL
  40, // SAND
  10, // WATER
  8, // OIL
  1, // FIRE
  0.6, // SMOKE
  0.5, // STEAM
  11, // ACID
  45, // LAVA
  100, // ICE
  100, // GLASS
  38, // SALT
  36, // GUNPOWDER
  9, // NITRO
  100, // FUSE
  100, // PLANT
  100, // WOOD
  100, // VIRUS
])

/** Ignition chance per neighbor-contact per tick (0 = fireproof). Consumed with ctx.rng(). */
export const FLAMMABLE = new Float32Array([
  0, 0, 0, 0,
  0.5, // OIL
  0, 0, 0,
  0, // ACID (corrosive, not flammable)
  0, 0, 0, 0,
  0.9, // GUNPOWDER (explodes via its own rule; this triggers it)
  0.9, // NITRO (same)
  0.35, // FUSE (lights, doesn't vanish)
  0.22, // PLANT
  0.06, // WOOD (slow smolder)
  0.4, // VIRUS (fire cures)
])

/** Spawn temperature. */
export const SPAWN_T = new Float32Array([
  22, 22, 22, 22, 22,
  900, // FIRE
  120, // SMOKE
  110, // STEAM
  22, // ACID
  1600, // LAVA
  -30, // ICE
  22, 22, 22, 22, 22, 22, 22, 22,
])

/** Initial life for lifetimed elements (ticks); 0 = immortal. */
export const SPAWN_LIFE = new Int32Array([
  0, 0, 0, 0, 0,
  48, // FIRE
  240, // SMOKE
  0, // STEAM (condenses by temperature, not age)
  600, // ACID (each bite costs extra life)
  0, 0, 0, 0, 0, 0,
  10, // FUSE burn ticks per cell once lit
  0, 0,
  360, // VIRUS dies out
])

export interface ElementInfo {
  id: number
  name: string
  brush: boolean
}

/** Brush-selectable roster in UI display order (NONE is the eraser, shown as ERASE). */
export const ROSTER: ElementInfo[] = [
  { id: E_SAND, name: 'SAND', brush: true },
  { id: E_WATER, name: 'WATER', brush: true },
  { id: E_WALL, name: 'WALL', brush: true },
  { id: E_FIRE, name: 'FIRE', brush: true },
  { id: E_OIL, name: 'OIL', brush: true },
  { id: E_ACID, name: 'ACID', brush: true },
  { id: E_LAVA, name: 'LAVA', brush: true },
  { id: E_ICE, name: 'ICE', brush: true },
  { id: E_SALT, name: 'SALT', brush: true },
  { id: E_GLASS, name: 'GLASS', brush: true },
  { id: E_GUNPOWDER, name: 'POWDER', brush: true },
  { id: E_NITRO, name: 'NITRO', brush: true },
  { id: E_FUSE, name: 'FUSE', brush: true },
  { id: E_WOOD, name: 'WOOD', brush: true },
  { id: E_PLANT, name: 'PLANT', brush: true },
  { id: E_VIRUS, name: 'VIRUS', brush: true },
  { id: E_STEAM, name: 'STEAM', brush: true },
  { id: E_SMOKE, name: 'SMOKE', brush: true },
  { id: E_NONE, name: 'ERASE', brush: true },
]

/** Base color per element (sRGB 0..255) + per-grain variation amount + HDR emissive strength. */
export const PALETTE: { rgb: [number, number, number]; vary: number; emit: number }[] = [
  { rgb: [0, 0, 0], vary: 0, emit: 0 }, // NONE
  { rgb: [92, 96, 104], vary: 0.08, emit: 0 }, // WALL
  { rgb: [216, 172, 106], vary: 0.22, emit: 0 }, // SAND
  { rgb: [48, 110, 208], vary: 0.1, emit: 0 }, // WATER
  { rgb: [96, 78, 40], vary: 0.14, emit: 0 }, // OIL
  { rgb: [255, 140, 40], vary: 0.5, emit: 2.6 }, // FIRE
  { rgb: [70, 70, 76], vary: 0.3, emit: 0 }, // SMOKE
  { rgb: [176, 196, 210], vary: 0.2, emit: 0 }, // STEAM
  { rgb: [140, 240, 80], vary: 0.18, emit: 0.35 }, // ACID
  { rgb: [255, 92, 24], vary: 0.35, emit: 1.9 }, // LAVA
  { rgb: [160, 210, 240], vary: 0.1, emit: 0 }, // ICE
  { rgb: [130, 160, 170], vary: 0.06, emit: 0 }, // GLASS
  { rgb: [228, 228, 224], vary: 0.14, emit: 0 }, // SALT
  { rgb: [56, 52, 48], vary: 0.2, emit: 0 }, // GUNPOWDER
  { rgb: [120, 220, 160], vary: 0.12, emit: 0.25 }, // NITRO
  { rgb: [176, 108, 60], vary: 0.12, emit: 0 }, // FUSE
  { rgb: [70, 160, 60], vary: 0.24, emit: 0 }, // PLANT
  { rgb: [124, 84, 48], vary: 0.18, emit: 0 }, // WOOD
  { rgb: [200, 60, 210], vary: 0.35, emit: 0.6 }, // VIRUS
]
