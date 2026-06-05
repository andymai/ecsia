// HTML renderer: a PURE function over the data layer → a self-contained static HTML string with
// inline CSS and NO scripts (viewable by opening the file / writing it to a response body). No world
// access, no side effects.

import type { WorldReport, PlanExplain } from './types.js'

function isPlanExplain(r: WorldReport | PlanExplain): r is PlanExplain {
  return 'waves' in r && 'conflicts' in r
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function htmlTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
  return `<table>${head}${body}</table>`
}

const STYLE = `
:root{color-scheme:light dark}
body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:1.5rem;background:#0f1117;color:#d7dae0}
h1{font-size:1.3rem;margin:0 0 1rem;color:#9ecbff}
h2{font-size:1rem;margin:1.4rem 0 .5rem;color:#7ee787;border-bottom:1px solid #30363d;padding-bottom:.2rem}
table{border-collapse:collapse;margin:.3rem 0;min-width:240px}
th,td{text-align:left;padding:.18rem .7rem;border:1px solid #30363d}
th{background:#161b22;color:#9ecbff}
td{background:#0d1117}
.kv{margin:.3rem 0}
.pin{color:#ffa657}
.ww{color:#ff7b72}.rw{color:#d2a8ff}
.muted{color:#768390}
.batch{margin:.2rem 0 .2rem 1.2rem;padding:.2rem .6rem;border-left:2px solid #30363d}
.wave{margin:.5rem 0;padding:.3rem .5rem;background:#11151c;border:1px solid #30363d;border-radius:4px}
.sys{display:inline-block;margin-right:1rem}
.sys b{color:#79c0ff}
`

function doc(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`
}

export function renderHTML(report: WorldReport | PlanExplain): string {
  return isPlanExplain(report) ? renderPlanHTML(report) : renderWorldHTML(report)
}

function renderWorldHTML(r: WorldReport): string {
  const parts: string[] = []

  parts.push(`<div class="kv">Entities: <b>${r.entities.alive}</b> alive / <span class="muted">${r.entities.capacity} capacity</span></div>`)

  parts.push('<h2>Components</h2>')
  parts.push(
    htmlTable(
      ['name', 'id', 'fields', 'rich', 'bytes/row', 'total'],
      r.components.map((c) => [
        c.name,
        String(c.id),
        String(c.fields),
        c.richFields.length === 0 ? '-' : c.richFields.join(', '),
        String(c.bytesPerRow),
        String(c.totalBytes),
      ]),
    ),
  )

  parts.push('<h2>Archetypes</h2>')
  parts.push(
    htmlTable(
      ['id', 'temp', 'count', 'signature'],
      r.archetypes.map((a) => [String(a.id), a.temperature, String(a.count), a.signature.join(', ') || '(empty)']),
    ),
  )

  if (r.queries.length > 0) {
    parts.push('<h2>Queries</h2>')
    parts.push(
      htmlTable(
        ['terms', 'archetypes', 'size'],
        r.queries.map((q) => [q.terms.join(' '), String(q.matchedArchetypes), String(q.size)]),
      ),
    )
  }

  if (r.relations.length > 0) {
    parts.push('<h2>Relations</h2>')
    parts.push(htmlTable(['name', 'pairs'], r.relations.map((rel) => [rel.name, String(rel.pairCount)])))
  }

  parts.push('<h2>Memory</h2>')
  parts.push(`<div class="kv">column bytes: <b>${r.memory.columnsBytes}</b>, sidecar entries: <b>${r.memory.sidecarEntries}</b></div>`)

  return doc('ecsia world inspector', parts.join(''))
}

function renderPlanHTML(p: PlanExplain): string {
  const parts: string[] = []

  parts.push('<h2>Waves</h2>')
  for (const wave of p.waves) {
    const batches = wave.batches
      .map((batch, b) => {
        const sys = batch.systems
          .map((s) => {
            const pin = s.workerEligible ? '' : ' <span class="pin">(pinned)</span>'
            return `<span class="sys"><b>${esc(s.name)}</b>${pin}<br><span class="muted">r:[${esc(s.reads.join(', '))}] w:[${esc(s.writes.join(', '))}]</span></span>`
          })
          .join('')
        return `<div class="batch">batch ${b}: ${sys || '<span class="muted">(empty)</span>'}</div>`
      })
      .join('')
    parts.push(`<div class="wave"><b>wave ${wave.index}</b>${batches}</div>`)
  }

  if (p.conflicts.length > 0) {
    parts.push('<h2>Conflicts</h2>')
    parts.push(
      `<table><tr><th>a</th><th>b</th><th>on</th><th>kind</th></tr>${p.conflicts
        .map((c) => `<tr><td>${esc(c.a)}</td><td>${esc(c.b)}</td><td>${esc(c.on)}</td><td class="${c.kind === 'write-write' ? 'ww' : 'rw'}">${esc(c.kind)}</td></tr>`)
        .join('')}</table>`,
    )
  }

  if (p.pinned.length > 0) {
    parts.push('<h2>Pinned (main thread)</h2>')
    parts.push(htmlTable(['system', 'reason'], p.pinned.map((pin) => [pin.system, pin.reason])))
  }

  return doc('ecsia wave plan', parts.join(''))
}
