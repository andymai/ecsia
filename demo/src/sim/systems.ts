// The serial game systems + the Steer twins. Everything structural or gameplay-stateful runs here,
// on the main thread, in DAG-deterministic order; the only worker-eligible systems are the four
// cohort Steer systems, whose bodies below are the arithmetic twins of kernels.ts (both call
// stepEnemy from shared.ts). Every serial system reads MainPin (an object<T> component) — that is
// what pins it to the main thread so the auto-threading path can never dispatch it kernel-less.
//
// Determinism inventory: PRNG consumed only here, in fixed system/iteration order; structural ops
// (spawn/despawn) only here, always AFTER iteration ends (collect-then-apply); worker kernels do
// pure field writes. That is why serial == threaded == replay, byte for byte, at any worker count.
//
// Pooled-ref discipline: world.entity() reuses ONE ref — every loop below copies fields to locals
// (or scratch lists) before the next lookup, and queries are never iterated nested.

import { defineSystem, read, write } from '@ecsia/kit'
import type { EntityHandle, SystemDef, World } from '@ecsia/kit'
import type { SimDefs } from './components.js'
import { SpatialGrid } from './grid.js'
import {
  ARENA_H,
  ARENA_W,
  BOSS_CONTACT_DPS,
  BOSS_HP,
  BOSS_RADIUS,
  BOSS_SPEED,
  BOSS_TICK,
  BULLET_DMG,
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_TTL,
  CONTACT_DPS,
  COHORTS,
  DIR_X,
  DIR_Y,
  DT,
  FIRE_CD,
  FIRE_RANGE,
  GEM_PICKUP,
  KIND_AGI,
  KIND_BRUTE,
  KIND_HP,
  KIND_MOTH,
  KIND_RADIUS,
  LOOP_TICKS,
  NOVA_RADIUS,
  PLAYER_HP,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  cos1,
  echoMultiplier,
  sin1,
  spawnRate,
  stepEnemy,
} from './shared.js'

export const ENEMY_CAP = 45000

export const FX_ENEMY_DEATH = 0
export const FX_PLAYER_DEATH = 1
export const FX_PICKUP = 2
export const FX_NOVA = 3
export const FX_BOSS_DEATH = 4
export const FX_GHOST_FADE = 5
export const FX_BOSS_SPAWN = 6

export interface FxEvent {
  x: number
  y: number
  kind: number
}

/** Per-run mutable context shared between the systems and the orchestrator (main.ts). */
export interface RunCtx {
  dirAt(slot: number, tick: number): number
  liveSlot: number
  overdrive: number
  echoes: number
  rng(): number
  grid: SpatialGrid
  fx: FxEvent[]
  kills: number
  liveDead: boolean
  bossDown: boolean
  spawnAcc: number
  spawnCounter: number
}

const steerOut = new Float32Array(5)
const beaconScratch = new Float32Array(16 * 2)

interface PlayerScratch {
  h: EntityHandle
  x: number
  y: number
  hp: number
  pow: number
  slot: number
  dirty: boolean
}

export function makeSystems(defs: SimDefs, ctx: RunCtx): SystemDef[] {
  const { EPos, EVel, EMeta, Player, Bullet, Gem, Boss, MainPin, Beacon } = defs

  const Players = defineSystem({
    name: 'Players',
    read: [MainPin],
    write: [Player],
    publish: [Beacon],
    run({ query, publish, tick }) {
      const t = tick as unknown as number
      for (const e of query(write(Player)) as Iterable<{ player: { x: number; y: number; hp: number; cd: number; inv: number; pow: number; slot: number } }>) {
        const p = e.player
        if (p.hp > 0) {
          const dir = ctx.dirAt(p.slot, t)
          if (dir < 0) {
            // A ghost's recorded life ended here: it fades from the timeline.
            p.hp = 0
            ctx.fx.push({ x: p.x, y: p.y, kind: FX_GHOST_FADE })
          } else {
            let x = p.x + DIR_X[dir]! * PLAYER_SPEED * DT
            let y = p.y + DIR_Y[dir]! * PLAYER_SPEED * DT
            if (x < PLAYER_RADIUS) x = PLAYER_RADIUS
            else if (x > ARENA_W - PLAYER_RADIUS) x = ARENA_W - PLAYER_RADIUS
            if (y < PLAYER_RADIUS) y = PLAYER_RADIUS
            else if (y > ARENA_H - PLAYER_RADIUS) y = ARENA_H - PLAYER_RADIUS
            p.x = x
            p.y = y
            if (p.cd > 0) p.cd -= DT
            if (p.inv > 0) p.inv -= DT
          }
        }
        publish(Beacon, { slot: p.slot, x: p.x, y: p.y, alive: p.hp > 0 ? 1 : 0 })
      }
    },
  })

  const steer = (c: number): SystemDef =>
    defineSystem({
      name: `Steer${c}`,
      read: [],
      write: [EPos[c]!, EVel[c]!],
      consume: [Beacon],
      run({ query, consume, dt }) {
        let bn = 0
        for (const ev of consume(Beacon) as Iterable<{ slot: number; x: number; y: number; alive: number }>) {
          if (ev.alive !== 0 && bn < 16) {
            beaconScratch[bn * 2] = ev.x
            beaconScratch[bn * 2 + 1] = ev.y
            bn++
          }
        }
        if (bn === 0) return
        query(write(EPos[c]!), write(EVel[c]!)).eachChunk((chunk) => {
          const xs = chunk.column(EPos[c]!, 'x') as Float32Array
          const ys = chunk.column(EPos[c]!, 'y') as Float32Array
          const vxs = chunk.column(EVel[c]!, 'vx') as Float32Array
          const vys = chunk.column(EVel[c]!, 'vy') as Float32Array
          const phs = chunk.column(EVel[c]!, 'phase') as Float32Array
          const ags = chunk.column(EVel[c]!, 'agi') as Float32Array
          const n = chunk.count
          for (let r = 0; r < n; r++) {
            const x = xs[r]!
            const y = ys[r]!
            let tx = beaconScratch[0]!
            let ty = beaconScratch[1]!
            let best = (tx - x) * (tx - x) + (ty - y) * (ty - y)
            for (let b = 1; b < bn; b++) {
              const bx = beaconScratch[b * 2]!
              const by = beaconScratch[b * 2 + 1]!
              const d = (bx - x) * (bx - x) + (by - y) * (by - y)
              if (d < best) {
                best = d
                tx = bx
                ty = by
              }
            }
            stepEnemy(x, y, vxs[r]!, vys[r]!, phs[r]!, ags[r]!, tx, ty, dt, steerOut)
            xs[r] = steerOut[0]!
            ys[r] = steerOut[1]!
            vxs[r] = steerOut[2]!
            vys[r] = steerOut[3]!
            phs[r] = steerOut[4]!
          }
        })
      },
    })

  const Fire = defineSystem({
    name: 'Fire',
    read: [MainPin],
    write: [Player, Bullet],
    run({ query, world }) {
      const shots: { x: number; y: number; vx: number; vy: number; dmg: number }[] = []
      for (const e of query(write(Player)) as Iterable<{ player: { x: number; y: number; hp: number; cd: number; pow: number } }>) {
        const p = e.player
        if (p.hp <= 0 || p.cd > 0) continue
        // Aim from LAST tick's grid (positions only — never dereferenced), so aim never sees a
        // mid-tick despawn. One tick of aim lag is invisible at 60Hz.
        const target = ctx.grid.nearest(p.x, p.y, FIRE_RANGE)
        if (target === null) continue
        const dx = target.x - p.x
        const dy = target.y - p.y
        const d = Math.sqrt(dx * dx + dy * dy) + 1e-4
        const nx = dx / d
        const ny = dy / d
        const count = 1 + Math.min(3, Math.floor(p.pow / 3))
        const dmg = BULLET_DMG * (1 + 0.18 * p.pow)
        for (let s = 0; s < count; s++) {
          const a = count === 1 ? 0 : (s / (count - 1) - 0.5) * 0.055
          const ca = cos1(a)
          const sa = sin1(a)
          shots.push({ x: p.x, y: p.y, vx: (nx * ca - ny * sa) * BULLET_SPEED, vy: (nx * sa + ny * ca) * BULLET_SPEED, dmg })
        }
        p.cd = FIRE_CD / (1 + 0.13 * p.pow)
      }
      for (const s of shots) world.spawnWith([Bullet, { x: s.x, y: s.y, vx: s.vx, vy: s.vy, ttl: BULLET_TTL, dmg: s.dmg }])
    },
  })

  const Bullets = defineSystem({
    name: 'Bullets',
    read: [MainPin],
    write: [Bullet],
    run({ query, world }) {
      const dead: EntityHandle[] = []
      for (const e of query(write(Bullet)) as Iterable<{ handle: EntityHandle; bullet: { x: number; y: number; vx: number; vy: number; ttl: number } }>) {
        const b = e.bullet
        b.x += b.vx * DT
        b.y += b.vy * DT
        b.ttl -= DT
        if (b.ttl <= 0 || b.x < -8 || b.x > ARENA_W + 8 || b.y < -8 || b.y > ARENA_H + 8) dead.push(e.handle)
      }
      for (const h of dead) world.despawn(h)
    },
  })

  const Collide = defineSystem({
    name: 'Collide',
    read: [MainPin, ...EPos],
    write: [EMeta, Player, Bullet, Gem, Boss],
    run({ query, world }) {
      const grid = ctx.grid
      grid.reset()
      for (let c = 0; c < COHORTS; c++) {
        query(read(EPos[c]!)).eachChunk((chunk) => {
          const xs = chunk.column(EPos[c]!, 'x') as Float32Array
          const ys = chunk.column(EPos[c]!, 'y') as Float32Array
          const handles = chunk.entities
          const n = chunk.count
          for (let r = 0; r < n; r++) grid.add(xs[r]!, ys[r]!, handles[r]!)
        })
      }
      grid.build()

      const maxR = 5.5
      const deadEnemies: { h: number; x: number; y: number; kind: number }[] = []
      const deadBullets: EntityHandle[] = []
      const deadGems: EntityHandle[] = []

      // world.entity() reuses one pooled ref — every use below is read-copy or immediate write.
      const metaOf = (h: number): { hp: number; kind: number } =>
        world.entity(h as unknown as EntityHandle).write(EMeta) as { hp: number; kind: number }

      const hurtEnemy = (h: number, ex: number, ey: number, dmg: number): boolean => {
        const m = metaOf(h)
        if (m.hp <= 0) return false
        const wasAlive = m.hp > 0
        m.hp -= dmg
        if (wasAlive && m.hp <= 0) deadEnemies.push({ h, x: ex, y: ey, kind: m.kind })
        return true
      }

      // Snapshot the boss (one entity at most) into locals; write back at the end.
      let bossH: EntityHandle | null = null
      let bossX = 0
      let bossY = 0
      let bossHp = 0
      let bossActive = 0
      for (const e of query(write(Boss)) as Iterable<{ handle: EntityHandle; boss: { x: number; y: number; hp: number; active: number } }>) {
        bossH = e.handle
        bossX = e.boss.x
        bossY = e.boss.y
        bossHp = e.boss.hp
        bossActive = e.boss.active
        break
      }

      // Snapshot players into scratch (≤ MAX_LIVES entries); mutate locals, write back at the end.
      const players: PlayerScratch[] = []
      for (const e of query(write(Player)) as Iterable<{ handle: EntityHandle; player: { x: number; y: number; hp: number; pow: number; slot: number } }>) {
        players.push({ h: e.handle, x: e.player.x, y: e.player.y, hp: e.player.hp, pow: e.player.pow, slot: e.player.slot, dirty: false })
      }

      // Bullets → enemies (then the boss). Bullet fields copied to locals before any entity() call.
      for (const e of query(write(Bullet)) as Iterable<{ handle: EntityHandle; bullet: { x: number; y: number; dmg: number } }>) {
        const bh = e.handle
        const bx = e.bullet.x
        const by = e.bullet.y
        const dmg = e.bullet.dmg
        let consumed = false
        grid.query(bx, by, BULLET_RADIUS + maxR, (h, ex, ey) => {
          const m = metaOf(h)
          if (m.hp <= 0) return
          const rr = BULLET_RADIUS + KIND_RADIUS[m.kind]!
          const dx = ex - bx
          const dy = ey - by
          if (dx * dx + dy * dy > rr * rr) return
          hurtEnemy(h, ex, ey, dmg)
          consumed = true
          return true
        })
        if (!consumed && bossActive !== 0) {
          const dx = bossX - bx
          const dy = bossY - by
          const rr = BULLET_RADIUS + BOSS_RADIUS
          if (dx * dx + dy * dy <= rr * rr) {
            bossHp -= dmg
            consumed = true
            if (bossHp <= 0 && bossActive !== 0) {
              bossActive = 0
              ctx.bossDown = true
              ctx.kills += 1
              ctx.fx.push({ x: bossX, y: bossY, kind: FX_BOSS_DEATH })
            }
          }
        }
        if (consumed) deadBullets.push(bh)
      }

      // Enemies (and boss) → players.
      for (const p of players) {
        if (p.hp <= 0) continue
        let touching = false
        grid.query(p.x, p.y, PLAYER_RADIUS + maxR, (h, ex, ey) => {
          const m = metaOf(h)
          if (m.hp <= 0) return
          const rr = PLAYER_RADIUS + KIND_RADIUS[m.kind]!
          const dx = ex - p.x
          const dy = ey - p.y
          if (dx * dx + dy * dy <= rr * rr) {
            touching = true
            return true
          }
        })
        if (touching) {
          p.hp -= CONTACT_DPS * DT
          p.dirty = true
        }
        if (bossActive !== 0) {
          const dx = bossX - p.x
          const dy = bossY - p.y
          const rr = PLAYER_RADIUS + BOSS_RADIUS
          if (dx * dx + dy * dy <= rr * rr) {
            p.hp -= BOSS_CONTACT_DPS * DT
            p.dirty = true
          }
        }
        if (p.hp <= 0 && p.dirty) {
          p.hp = 0
          if (p.slot === ctx.liveSlot) {
            ctx.liveDead = true
            ctx.fx.push({ x: p.x, y: p.y, kind: FX_PLAYER_DEATH })
          } else {
            ctx.fx.push({ x: p.x, y: p.y, kind: FX_GHOST_FADE })
          }
        }
      }

      // Gem pickups — nearest alive player within reach takes the gem.
      for (const g of query(write(Gem)) as Iterable<{ handle: EntityHandle; gem: { x: number; y: number; kind: number } }>) {
        const gh = g.handle
        const gx = g.gem.x
        const gy = g.gem.y
        const gkind = g.gem.kind
        for (const p of players) {
          if (p.hp <= 0) continue
          const dx = p.x - gx
          const dy = p.y - gy
          if (dx * dx + dy * dy > GEM_PICKUP * GEM_PICKUP) continue
          if (gkind === 0) p.hp = Math.min(PLAYER_HP, p.hp + 30)
          else if (gkind === 1) p.pow += 1
          else {
            ctx.fx.push({ x: gx, y: gy, kind: FX_NOVA })
            grid.query(gx, gy, NOVA_RADIUS, (h, ex, ey) => {
              const m = metaOf(h)
              if (m.hp <= 0) return
              m.hp = 0
              deadEnemies.push({ h, x: ex, y: ey, kind: m.kind })
            })
          }
          p.dirty = true
          ctx.fx.push({ x: gx, y: gy, kind: FX_PICKUP })
          deadGems.push(gh)
          break
        }
      }

      // Apply structural effects + write-backs last (collect-then-apply discipline).
      for (const p of players) {
        if (!p.dirty) continue
        const w = world.entity(p.h).write(Player) as { hp: number; pow: number }
        w.hp = p.hp
        w.pow = p.pow
      }
      if (bossH !== null) {
        const w = world.entity(bossH).write(Boss) as { hp: number; active: number }
        w.hp = bossHp
        w.active = bossActive
      }
      for (const d of deadEnemies) {
        world.despawn(d.h as unknown as EntityHandle)
        ctx.kills += 1
        ctx.fx.push({ x: d.x, y: d.y, kind: FX_ENEMY_DEATH })
        const roll = ctx.rng()
        const dropChance = d.kind === KIND_BRUTE ? 0.5 : d.kind === KIND_MOTH ? 0.1 : 0.055
        if (roll < dropChance) {
          const kr = ctx.rng()
          const kind = kr < 0.45 ? 1 : kr < 0.8 ? 0 : 2
          world.spawnWith([Gem, { x: d.x, y: d.y, kind }])
        }
      }
      for (const h of deadBullets) world.despawn(h)
      for (const h of deadGems) world.despawn(h)
    },
  })

  const Director = defineSystem({
    name: 'Director',
    read: [MainPin],
    write: [EMeta],
    run({ query, world, tick }) {
      const t = tick as unknown as number
      if (t >= LOOP_TICKS) return
      const alive = query(write(EMeta)).count
      ctx.spawnAcc += spawnRate(t) * DT * ctx.overdrive * echoMultiplier(ctx.echoes)
      let n = Math.floor(ctx.spawnAcc)
      ctx.spawnAcc -= n
      if (alive + n > ENEMY_CAP) n = Math.max(0, ENEMY_CAP - alive)
      for (let i = 0; i < n; i++) {
        const c = ctx.spawnCounter & (COHORTS - 1)
        ctx.spawnCounter += 1
        // Spawn on the arena border, deterministic ring position.
        const u = ctx.rng()
        const per = u * 2 * (ARENA_W + ARENA_H)
        let x: number
        let y: number
        if (per < ARENA_W) {
          x = per
          y = -4
        } else if (per < ARENA_W + ARENA_H) {
          x = ARENA_W + 4
          y = per - ARENA_W
        } else if (per < 2 * ARENA_W + ARENA_H) {
          x = per - ARENA_W - ARENA_H
          y = ARENA_H + 4
        } else {
          x = -4
          y = per - 2 * ARENA_W - ARENA_H
        }
        const kr = ctx.rng()
        const late = t / LOOP_TICKS
        const kind = kr < 0.08 + late * 0.22 ? KIND_BRUTE : kr < 0.45 ? KIND_MOTH : 0
        const hp = KIND_HP[kind]! * (1 + ctx.echoes * 0.22)
        const agi = KIND_AGI[kind]! * (0.85 + ctx.rng() * 0.3)
        world.spawnWith(
          [EPos[c]!, { x, y }],
          [EVel[c]!, { vx: 0, vy: 0, phase: ctx.rng() * 4, agi }],
          [EMeta, { hp, kind }],
        )
      }
    },
  })

  const BossSys = defineSystem({
    name: 'BossSys',
    read: [MainPin, Player],
    write: [Boss],
    run({ query, world, tick }) {
      const t = tick as unknown as number
      if (t === BOSS_TICK) {
        world.spawnWith([Boss, { x: ARENA_W / 2, y: -16, vx: 0, vy: 0, hp: BOSS_HP * (1 + 0.3 * ctx.echoes), active: 1 }])
        ctx.fx.push({ x: ARENA_W / 2, y: 8, kind: FX_BOSS_SPAWN })
        return
      }
      // Collect alive players first (no nested query iteration).
      const targets: { x: number; y: number }[] = []
      for (const pe of query(read(Player)) as Iterable<{ player: { x: number; y: number; hp: number } }>) {
        if (pe.player.hp > 0) targets.push({ x: pe.player.x, y: pe.player.y })
      }
      for (const e of query(write(Boss)) as Iterable<{ boss: { x: number; y: number; vx: number; vy: number; hp: number; active: number } }>) {
        const b = e.boss
        if (b.active === 0) continue
        let tx = ARENA_W / 2
        let ty = ARENA_H / 2
        let best = Infinity
        for (const p of targets) {
          const d = (p.x - b.x) * (p.x - b.x) + (p.y - b.y) * (p.y - b.y)
          if (d < best) {
            best = d
            tx = p.x
            ty = p.y
          }
        }
        const dx = tx - b.x
        const dy = ty - b.y
        const d = Math.sqrt(dx * dx + dy * dy) + 1e-4
        b.vx += ((dx / d) * BOSS_SPEED - b.vx) * 1.6 * DT
        b.vy += ((dy / d) * BOSS_SPEED - b.vy) * 1.6 * DT
        b.x += b.vx * DT
        b.y += b.vy * DT
      }
    },
  })

  const systems: SystemDef[] = [Players]
  for (let c = 0; c < COHORTS; c++) systems.push(steer(c))
  systems.push(Fire, Bullets, Collide, Director, BossSys)
  return systems
}

export function spawnPlayers(world: World, defs: SimDefs, lives: number): void {
  for (let slot = 0; slot < lives; slot++) {
    // Deterministic ring around center — each life starts a step around the circle.
    const a = slot / 8
    const x = ARENA_W / 2 + 26 * cos1(a)
    const y = ARENA_H / 2 + 26 * sin1(a)
    world.spawnWith([defs.Player, { x, y, hp: PLAYER_HP, cd: 0, inv: 0, pow: 0, slot }])
  }
}
