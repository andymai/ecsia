// @ecsia/react — React bindings for ecsia. An OPT-IN package: it is deliberately NOT re-exported
// from the ecsia umbrella (the umbrella is pure static re-exports with no peer deps; a `react` peer
// on it would tax every non-React consumer). An app that wants the hooks installs `react` +
// `@ecsia/react` explicitly. This package depends ONLY on the @ecsia/core + @ecsia/schema public
// surface (and `react` as a PEER dep) and is NEVER imported by them.
//
// The contract, in one line: handles in, snapshots out. Hooks accept and return EntityHandle (a
// branded number — stable, comparable, correct as a React key) and copied frozen snapshots; the
// pooled EntityRef never crosses this surface, because a ref captured across renders throws by
// design. Hooks subscribe through a per-world bridge over the DEFERRED observer layer, so they see
// world state as of the last completed update()'s observer drain — the world must tick for the UI
// to move.

export { WorldProvider, useWorld } from './world.js'
export type { EcsiaWorld, EntityRefLike, WorldProviderProps } from './world.js'

export { useQuery, useQueryFirst, useComponent, useHas, useComponentEffect, useObserve } from './hooks.js'

export type { ComponentSnapshot } from './snapshot.js'
