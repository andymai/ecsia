// Ergonomic-path compiler: turn an `.each`-style body `(e, ctx) => { e.position.x += e.velocity.dx * ctx.dt }`
// into the same codegen'd raw-column loop `bindColumns` runs — so the readable accessor syntax pays the
// proxy-per-row tax (~10 ns/entity) only when it must, and lands near `eachChunk` (~1.5 ns/entity) when
// it can. The transform reads the callback's own `.toString()` and rewrites `e.<comp>.<field>` to direct
// column indexing, exactly the rewrite becsy performs.
//
// CORRECTNESS over speed, always. This analyzer is deliberately CONSERVATIVE: it compiles only
// straight-line numeric-scalar bodies and bails — returning null, so the caller runs the unchanged proxy
// `.each` — on ANYTHING it does not fully understand. An imperfect transform can therefore never corrupt;
// the worst case is a missed optimization. The bail set is wide on purpose:
//   - any control flow / short-circuit / nested function (`if for while switch case ? && || return
//     continue break => function`): a conditional write would make the after-body `trackWrite` over-report
//     `.changed()`, and `return`/`continue` mean per-row skip (proxy semantics) not loop-exit. Straight-line
//     only ⇒ every write always runs ⇒ the gated `trackWrite` block provably matches what was written.
//   - strings / template literals / comments: they could hide a fake `e.position.x` that string-replacement
//     would corrupt.
//   - any `e` use that is not exactly `e.<knownComponent>.<numericScalarField>`: `e.handle`, `e[expr]`,
//     `e.comp` bare, passing `e` along, a non-scalar (vec/bool/eid/bigint/rich) field, or a component the
//     query does not REQUIRE (may be absent from a future matching archetype).
//   - any non-read `ctx` use: per-row ctx mutation is rare and left to the proxy.
//
// Reactivity is PRESERVED: every component the body writes gets one gated `trackWrite(handleIndex(row), id)`
// emitted after the row body — the same component-granular record the scalar accessor setter makes — so
// `.changed()` filters and observers fire identically. The gate (`if (tracking.active)`) makes it free when
// no consumer exists, matching the accessor's own write-path fast-out.
//
// SECURITY: the generated source is built from the body's own `.toString()` plus component/field NAMES and
// integer ids drawn from the registered schema — never interpolated external strings. Same surface as the
// code the caller already wrote.

import type { ComponentDef, FieldDescriptor, Schema } from '@ecsia/schema'

/** One bound column the compiled loop reads/writes: which field of which component, and its column index. */
export interface EachViewSpec {
  readonly def: ComponentDef<Schema>
  readonly field: string
  /** Column index within the component's ColumnSet (ctor-backed fields only — the bindColumns rule). */
  readonly colIndex: number
}

export interface EachPlan {
  /** Views in binding order; `views[k]` in the generated source is this spec's column. */
  readonly specs: readonly EachViewSpec[]
  /** Component ids the body writes (each gets a gated per-row trackWrite). */
  readonly writtenIds: readonly number[]
  /**
   * The generated factory source: `(args) => { ...; return (ctx) => { ...loop... } }`. `args` carries
   * `{ views, rows, trackWrite, tracking, handleIndex, meta }`. Recompiled per archetype by the caller
   * (via the shared codegen path) so each runner is a specialized V8 singleton.
   */
  readonly factorySource: string
}

/** Lookups the analyzer needs from the query/world, kept injectable so the module imports no core internals. */
export interface EachAnalyzeDeps {
  /** Component the query exposes under `e.<name>` (its value term), or undefined if not a value term. */
  defByName(name: string): ComponentDef<Schema> | undefined
  /** Registered component id, or undefined if unregistered. */
  idOf(def: ComponentDef<Schema>): number | undefined
  /** True iff the component is REQUIRED by the query (present in every matching archetype). */
  isRequired(def: ComponentDef<Schema>): boolean
}

// Statements we refuse to compile (see header). Word-boundaried for keywords; literal for operators. A
// match anywhere in the BODY BLOCK (not the outer signature — its own `=>` is fine) forces the proxy
// fallback. Local `const`/`let` are allowed: they keep the body straight-line. A nested `=>`/`function`
// (closures), control flow, short-circuit, and spread all bail.
const BANNED = /\b(?:if|for|while|switch|case|do|return|continue|break|function|yield|await|new|delete|void|throw|in|instanceof|typeof)\b|=>|\?|&&|\|\||\.\.\.|`/
// EVERY identifier the generated loop introduces is `__`-prefixed (`__v0`, `__trackWrite`, `__ctx`, …).
// So a single guard — reject ANY double-underscore in the body — makes a user local collision impossible:
// it can never shadow a generated name (which would silently corrupt under sloppy-mode `new Function`).
const RESERVED = /__/
// A destructuring-assignment target writes a column WITHOUT a trailing assign op, so write-detection would
// miss it (silent `.changed()` divergence). `]=`/`}=` is the LHS-bracket signature; bail on it.
const DESTRUCTURE_ASSIGN = /[\]}]\s*=(?!=)/
// A regex literal could spell a real `e.comp.field` that string-rewriting would corrupt. A `/` right after
// an operator/open-bracket starts a regex (division's `/` follows a value: identifier/`)`/`]`/number), so
// this flags regex literals without bailing on division.
const REGEX_LITERAL = /[=(,:[!&|?{;+\-*%<>~^]\s*\//

const ASSIGN_OPS = ['>>>=', '<<=', '>>=', '**=', '&&=', '||=', '??=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=']

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A field is codegen-eligible iff it is a single-slot column whose codec is the identity on numbers —
// i.e. a plain float/int column (f32, i32, u8, ...). bool/eid/bigint/staticString/rich all fail the
// identity probe (or carry no column) and route to the proxy, where their non-identity codec runs.
function scalarColIndex(def: ComponentDef<Schema>, field: string): number | null {
  let colIndex = 0
  for (const f of def.fields as readonly FieldDescriptor[]) {
    if (f.name === field) {
      if (f.ctor === null || f.stride !== 1 || f.rich !== undefined) return null
      if (f.decode(0) !== 0 || f.decode(1) !== 1 || f.encode(0) !== 0 || f.encode(1) !== 1) return null
      return colIndex
    }
    if (f.ctor !== null) colIndex += 1
  }
  return null
}

interface Params {
  readonly eParam: string
  readonly ctxParam: string | null
  readonly block: string
}

/** Pull the (e, ctx) parameter names and the body block out of a function's source. Returns null for any
 * shape we do not handle (destructured/defaulted/rest params, more than two params). */
function parseFn(src: string): Params | null {
  const s = src.trim()
  let paramsRaw: string
  let block: string
  const arrowAt = s.indexOf('=>')
  const braceAt = s.indexOf('{')
  if (arrowAt !== -1 && (braceAt === -1 || arrowAt < braceAt)) {
    let head = s.slice(0, arrowAt).trim()
    if (head.startsWith('async')) head = head.slice(5).trim()
    paramsRaw = head.replace(/^\(/, '').replace(/\)$/, '')
    let body = s.slice(arrowAt + 2).trim()
    if (body.startsWith('{')) {
      const end = body.lastIndexOf('}')
      if (end === -1) return null
      block = body.slice(1, end)
    } else {
      // concise arrow body: a single expression. Wrap as a statement so writes (the common case) run.
      block = body.replace(/;\s*$/, '') + ';'
    }
  } else {
    const lp = s.indexOf('(')
    if (lp === -1) return null
    const rp = s.indexOf(')', lp)
    if (rp === -1) return null
    paramsRaw = s.slice(lp + 1, rp)
    const bo = s.indexOf('{', rp)
    if (bo === -1) return null
    const be = s.lastIndexOf('}')
    if (be <= bo) return null
    block = s.slice(bo + 1, be)
  }
  const params = paramsRaw.trim() === '' ? [] : paramsRaw.split(',').map((p) => p.trim())
  if (params.length === 0 || params.length > 2) return null
  for (const p of params) if (!/^[A-Za-z_$][\w$]*$/.test(p)) return null // no destructure/default/rest
  return { eParam: params[0] as string, ctxParam: params[1] ?? null, block }
}

/**
 * Analyze an `.each` body. Returns a compile plan, or null to signal "run the proxy `.each` unchanged".
 * Pure and side-effect-free (it reads `.toString()` and the schema only), so it is trivially testable.
 */
export function analyzeEachBody(body: (...args: never[]) => unknown, deps: EachAnalyzeDeps): EachPlan | null {
  const src = String(body)
  const parsed = parseFn(src)
  if (parsed === null) return null
  const { eParam, ctxParam, block } = parsed
  // Hazard checks run on the BLOCK only — the outer arrow's `=>` and the params are not part of it.
  if (
    BANNED.test(block) ||
    RESERVED.test(block) ||
    DESTRUCTURE_ASSIGN.test(block) ||
    REGEX_LITERAL.test(block) ||
    block.includes('//') ||
    block.includes('/*') ||
    /['"]/.test(block)
  ) {
    return null
  }

  // --- map every e.<comp>.<field> to a view; bail on any other use of e ---------------------------
  const specs: EachViewSpec[] = []
  const specIndex = new Map<string, number>() // "comp.field" -> views[] index (dedups repeat accesses)
  const writtenIds = new Set<number>()
  const idByName = new Map<string, number>()

  const accessRe = new RegExp(escapeRe(eParam) + '\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*([A-Za-z_$][\\w$]*)', 'g')
  let transformed = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = accessRe.exec(block)) !== null) {
    const compName = m[1] as string
    const field = m[2] as string
    const def = deps.defByName(compName)
    if (def === undefined || !deps.isRequired(def)) return null
    const id = deps.idOf(def)
    if (id === undefined) return null
    const colIndex = scalarColIndex(def, field)
    if (colIndex === null) return null

    // The char right after the field must not extend the access (`.`, `[`, `(`) — that would be a deeper
    // member/index/call we do not model (`e.pos.x.foo`, `e.pos.x()`), so the whole body bails.
    const after = block[accessRe.lastIndex]
    if (after === '.' || after === '[' || after === '(') return null

    const key = compName + '.' + field
    let k = specIndex.get(key)
    if (k === undefined) {
      k = specs.length
      specs.push({ def, field, colIndex })
      specIndex.set(key, k)
      idByName.set(compName, id)
    }

    // Write detection: an assignment operator (or pre/post ++/--) on this access marks the component
    // written. Straight-line bodies guarantee the write always runs, so the after-body trackWrite is exact.
    const rest = block.slice(accessRe.lastIndex).replace(/^\s+/, '')
    const postInc = rest.startsWith('++') || rest.startsWith('--')
    const preInc = /(?:\+\+|--)\s*$/.test(block.slice(0, m.index)) // prefix ++/-- (any whitespace)
    let isWrite = postInc || preInc
    if (!isWrite) {
      for (const op of ASSIGN_OPS) {
        if (rest.startsWith(op)) {
          isWrite = true
          break
        }
      }
      // plain `=` but not `==`/`===`/`=>` (`=>` already banned globally)
      if (!isWrite && rest.startsWith('=') && rest[1] !== '=') isWrite = true
    }
    if (isWrite) writtenIds.add(id)

    transformed += block.slice(last, m.index) + '__v' + k + '[__i]'
    last = accessRe.lastIndex
  }
  transformed += block.slice(last)
  if (specs.length === 0) return null

  // Any remaining bare mention of e is something we did not model → bail.
  if (new RegExp('\\b' + escapeRe(eParam) + '\\b').test(transformed)) return null

  // --- hoist ctx.<ident> reads out of the loop -----------------------------------------------------
  let preamble = ''
  if (ctxParam !== null) {
    const ctxRe = new RegExp(escapeRe(ctxParam) + '\\s*\\.\\s*([A-Za-z_$][\\w$]*)', 'g')
    const hoisted = new Map<string, string>()
    let out = ''
    let lc = 0
    let cm: RegExpExecArray | null
    while ((cm = ctxRe.exec(transformed)) !== null) {
      const prop = cm[1] as string
      const after = transformed.slice(ctxRe.lastIndex).replace(/^\s+/, '')
      // a ctx write (`ctx.x =`, `ctx.x +=`, `ctx.x++`) is not a hoistable read → bail to proxy.
      if (after.startsWith('++') || after.startsWith('--')) return null
      if (after.startsWith('=') && after[1] !== '=') return null
      for (const op of ASSIGN_OPS) if (after.startsWith(op)) return null
      const local = '__c_' + prop
      if (!hoisted.has(prop)) hoisted.set(prop, local)
      out += transformed.slice(lc, cm.index) + local
      lc = ctxRe.lastIndex
    }
    out += transformed.slice(lc)
    // a bare ctx mention (computed access, passed along) left over → bail.
    if (new RegExp('\\b' + escapeRe(ctxParam) + '\\b').test(out)) return null
    transformed = out
    for (const [prop, local] of hoisted) preamble += 'const ' + local + ' = __ctx.' + prop + ';'
  }

  // --- assemble the factory source -----------------------------------------------------------------
  // EVERY introduced identifier is `__`-prefixed (columns `__v0`, seam `__trackWrite`/`__handleIndex`/
  // `__tracking`, runner param `__ctx`, …). The RESERVED guard rejected any `__` in the body, so none of
  // these can collide with — and silently shadow — a user local.
  const viewDecls = specs.map((_, k) => 'const __v' + k + ' = __views[' + k + '];').join('')
  const writeIds = [...writtenIds]
  const cleanLoop = 'for(let __i=0;__i<__count;__i++){' + transformed + '}'

  // When the body writes a component, reactivity must observe it — but ONLY when a `.changed`/observer
  // consumer is registered (`__tracking.active`). The branch is hoisted OUT of the loop: the common
  // no-consumer path runs `cleanLoop` (zero trackWrite references, so V8 compiles it like bindColumns),
  // and the tracked path runs a second loop that records one component-granular write per row — matching
  // the accessor setter exactly. `arch.rows` is re-read per frame (it is reassigned on growth).
  let loopSource: string
  if (writeIds.length > 0) {
    const trackedLoop =
      'const __rows=__arch.rows;' +
      'for(let __i=0;__i<__count;__i++){' +
      transformed +
      'const __ix=__handleIndex(__rows[__i]);' +
      writeIds.map((id) => '__trackWrite(__ix,' + id + ');').join('') +
      '}'
    loopSource = 'if(__tracking.active){' + trackedLoop + '}else{' + cleanLoop + '}'
  } else {
    loopSource = cleanLoop
  }

  const factorySource =
    '(__args)=>{' +
    'const __views=__args.views,__arch=__args.arch,__trackWrite=__args.trackWrite,__tracking=__args.tracking,__handleIndex=__args.handleIndex,__meta=__args.meta;' +
    viewDecls +
    'return (__ctx)=>{' +
    preamble +
    'const __count=__meta.count;' +
    loopSource +
    '};}'

  return { specs, writtenIds: writeIds, factorySource }
}
