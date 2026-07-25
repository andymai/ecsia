// Recorded events → paint segments, and a headless driver that replays an event stream into a
// sim. Shared by the page (live input + replay), the bench mode, and the unit tests — one
// interpretation of a stroke stream, everywhere.

import type { RecEvent } from './codec.js'
import type { PaintEvent } from '../sim/particles.js'
import type { Sim } from '../sim/world.js'

export function toSegment(ev: RecEvent, last: { x: number; y: number } | null): PaintEvent {
  const from = ev.stroke || last === null ? { x: ev.x, y: ev.y } : last
  return { elem: ev.elem, x0: from.x, y0: from.y, x1: ev.x, y1: ev.y, r: ev.r }
}

/** Step `sim` to `untilTick`, queuing `events` (sorted by tick) as their ticks come up. */
export async function runEvents(sim: Sim, events: RecEvent[], untilTick: number): Promise<void> {
  let i = 0
  let last: { x: number; y: number } | null = null
  while (sim.tick() < untilTick) {
    // Systems observe currentTick()+1: the scheduler advances the tick at the START of update.
    const t = sim.tick() + 1
    const segs: PaintEvent[] = []
    while (i < events.length && events[i]!.tick <= t) {
      const ev = events[i++]!
      if (ev.tick === t) {
        segs.push(toSegment(ev, last))
        last = { x: ev.x, y: ev.y }
      }
    }
    if (segs.length > 0) sim.queue(t, segs)
    const p = sim.step()
    if (p !== undefined) await p
  }
}
