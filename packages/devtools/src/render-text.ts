// Text renderer: a PURE function over the data layer → an aligned, console-friendly string. No
// world access, no side effects — `renderText(inspectWorld(w))` / `renderText(explainPlan(s))`.

import type { WorldReport, PlanExplain } from './types.js'

function isPlanExplain(r: WorldReport | PlanExplain): r is PlanExplain {
  return 'waves' in r && 'conflicts' in r
}

/** Render a fixed-column table: header row + aligned body rows. */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)))
  const fmt = (cells: readonly string[]): string =>
    cells.map((cell, c) => cell.padEnd(widths[c]!)).join('  ').trimEnd()
  const sep = widths.map((w) => '-'.repeat(w)).join('  ')
  return [fmt(headers), sep, ...rows.map(fmt)].join('\n')
}

function section(title: string, body: string): string {
  return `== ${title} ==\n${body}`
}

export function renderText(report: WorldReport | PlanExplain): string {
  return isPlanExplain(report) ? renderPlanText(report) : renderWorldText(report)
}

function renderWorldText(r: WorldReport): string {
  const blocks: string[] = []

  blocks.push(
    section('Entities', `alive ${r.entities.alive} / capacity ${r.entities.capacity}`),
  )

  blocks.push(
    section(
      'Components',
      table(
        ['name', 'id', 'fields', 'rich', 'bytes/row', 'total'],
        r.components.map((c) => [
          c.name,
          String(c.id),
          String(c.fields),
          c.richFields.length === 0 ? '-' : c.richFields.join(','),
          String(c.bytesPerRow),
          String(c.totalBytes),
        ]),
      ),
    ),
  )

  blocks.push(
    section(
      'Archetypes',
      table(
        ['id', 'temp', 'count', 'signature'],
        r.archetypes.map((a) => [String(a.id), a.temperature, String(a.count), a.signature.join(',') || '(empty)']),
      ),
    ),
  )

  if (r.queries.length > 0) {
    blocks.push(
      section(
        'Queries',
        table(
          ['terms', 'archetypes', 'size'],
          r.queries.map((q) => [q.terms.join(' '), String(q.matchedArchetypes), String(q.size)]),
        ),
      ),
    )
  }

  if (r.relations.length > 0) {
    blocks.push(
      section(
        'Relations',
        table(
          ['name', 'pairs'],
          r.relations.map((rel) => [rel.name, String(rel.pairCount)]),
        ),
      ),
    )
  }

  blocks.push(
    section('Memory', `columns ${r.memory.columnsBytes} bytes, sidecar entries ${r.memory.sidecarEntries}`),
  )

  return blocks.join('\n\n')
}

function renderPlanText(p: PlanExplain): string {
  const blocks: string[] = []

  const waveLines: string[] = []
  for (const wave of p.waves) {
    waveLines.push(`wave ${wave.index}`)
    wave.batches.forEach((batch, b) => {
      const sys = batch.systems
        .map((s) => {
          const access = `r:[${s.reads.join(',')}] w:[${s.writes.join(',')}]`
          return `${s.name}${s.workerEligible ? '' : '*'} ${access}`
        })
        .join('  |  ')
      waveLines.push(`  batch ${b}: ${sys}`)
    })
  }
  blocks.push(section('Waves', waveLines.join('\n') || '(no systems)'))

  if (p.conflicts.length > 0) {
    blocks.push(
      section(
        'Conflicts',
        table(
          ['a', 'b', 'on', 'kind'],
          p.conflicts.map((c) => [c.a, c.b, c.on, c.kind]),
        ),
      ),
    )
  }

  if (p.pinned.length > 0) {
    blocks.push(
      section(
        'Pinned (main thread)',
        table(
          ['system', 'reason'],
          p.pinned.map((pin) => [pin.system, pin.reason]),
        ),
      ),
    )
  }

  return blocks.join('\n\n') + '\n\n(* = worker-ineligible)'
}
