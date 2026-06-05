// Compile-only inference obligations. Type-checked standalone (see the
// runtime guard test that compiles this file); no assertions run. Contracts are pinned by mutual
// assignability rather than a brittle `Equal` helper (deferred conditionals defeat strict Equal,
// while bidirectional assignment proves the same equivalence).
import type { ComponentDef, EntityHandle, ReadOf, ReadView, StaticStringToken, WriteOf, WriteView } from '@ecsia/core'
import type { FieldValue, VecView } from '../src/internal.js'
import { defineComponent, vec, staticString } from '@ecsia/core'

// Field token → value type (assignable both directions == equal).
export const _f1a: FieldValue<'f32'> = 0
export const _f1b: number = _f1a
export const _f2a: FieldValue<'bool'> = true
export const _f3a: FieldValue<'eid'> = 0 as EntityHandle
export const _f4a: FieldValue<StaticStringToken<['idle', 'run']>> = 'idle'
// @ts-expect-error 'walk' is not a choice
export const _f4b: FieldValue<StaticStringToken<['idle', 'run']>> = 'walk'

// ReadView is readonly; WriteView is mutable.
type PosSchema = { x: 'f32'; y: 'f32' }
declare const rp: ReadView<PosSchema>
declare const wp: WriteView<PosSchema>
export const _r1: Readonly<{ x: number; y: number }> = rp
export const _r1b: ReadView<PosSchema> = { x: 1, y: 2 } as Readonly<{ x: number; y: number }>
export const _w1: { x: number; y: number } = wp
wp.x = 5 // mutable
// @ts-expect-error shorthand/read is deeply readonly
rp.x = 5

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'c1' })
declare const rPos: ReadOf<typeof Position>
declare const wPos: WriteOf<typeof Position>
export const _r2: Readonly<{ x: number; y: number }> = rPos
export const _w2: { x: number; y: number } = wPos

// vec / staticString through a full component.
const Body = defineComponent({ v: vec('f32', 3), state: staticString('idle', 'run') }, { name: 'c2' })
declare const wBody: WriteOf<typeof Body>
declare const rBody: ReadOf<typeof Body>
export const _v1: VecView<'f32', 3> = wBody.v
export const _s1: 'idle' | 'run' = rBody.state

// A ComponentDef is assignable to the generic def (query/scheduler seam).
export const _asDef: ComponentDef<PosSchema> = Position

// --- Rich fields: 'string' types as string; object<T> read=Readonly<T>, write=T ---
import { object, field } from '@ecsia/core'
import type { ObjectToken } from '@ecsia/core'

export const _rich1: FieldValue<'string'> = 'hello'
export const _rich1b: string = _rich1
// @ts-expect-error 'string' is not a number
export const _rich1c: FieldValue<'string'> = 5
export const _rich2: FieldValue<ObjectToken<{ tags: string[] }>> = { tags: ['a'] }

// A FieldSpec wrapper unwraps to the inner token's value type.
export const _rich3: FieldValue<typeof _wrappedToken> = 'x'
const _wrappedToken = field('string', { default: 'd' })

const Label = defineComponent({ text: 'string' }, { name: 'rich_label' })
declare const rLabel: ReadOf<typeof Label>
declare const wLabel: WriteOf<typeof Label>
export const _rl1: string = rLabel.text
wLabel.text = 'mutable on write'

const Node = defineComponent({ meta: object<{ tags: string[] }>() }, { name: 'rich_node' })
declare const rNode: ReadOf<typeof Node>
declare const wNode: WriteOf<typeof Node>
export const _rn1: Readonly<{ tags: string[] }> = rNode.meta
export const _rn2: { tags: string[] } = wNode.meta
wNode.meta = { tags: ['w'] } // re-assignable on write
// @ts-expect-error the object<T> read fork is Readonly<T> (no top-level re-assign)
rNode.meta = { tags: ['x'] }

// A rich-field-bearing def is still assignable to the generic def.
export const _asRichDef: ComponentDef<{ text: 'string' }> = Label
