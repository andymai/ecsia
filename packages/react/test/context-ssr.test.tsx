// WorldProvider/useWorld context plumbing, and SSR: getServerSnapshot recomputes from the world on
// every server render (identity-preserved when values match), and a renderToString pass — which
// never commits — must leave zero entries behind in the bridge's store maps.

import { describe, expect, test } from 'vitest'
import { renderToString } from 'react-dom/server'
import { render } from '@testing-library/react'
import { defineComponent } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { read } from '@ecsia/schema'
import { WorldProvider, useComponent, useHas, useQuery, useWorld } from '../src/index.js'
import { liveObserverCount, liveStoreCount } from '../src/internal.js'
import { makeKit } from './helpers.js'

const mkHealth = () => defineComponent({ hp: 'i32' }, { name: 'health' })

describe('WorldProvider / useWorld', () => {
  test('useWorld returns the provided world', () => {
    const Health = mkHealth()
    const { world } = makeKit([Health])

    let seen: unknown
    function Probe() {
      seen = useWorld()
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe />
      </WorldProvider>,
    )
    expect(seen).toBe(world)
  })

  test('useWorld throws outside a WorldProvider', () => {
    function Probe() {
      useWorld()
      return null
    }
    expect(() => render(<Probe />)).toThrowError(/WorldProvider/)
  })
})

describe('SSR', () => {
  test('renderToString renders the current world state through getServerSnapshot', () => {
    const Health = mkHealth()
    const { world } = makeKit([Health])
    const a = world.spawnWith([Health, { hp: 11 }])
    const b = world.spawnWith([Health, { hp: 22 }])

    function Row({ handle }: { handle: EntityHandle }) {
      const health = useComponent(handle, Health)
      return <li>{health?.hp ?? 'gone'}</li>
    }
    function App() {
      const handles = useQuery(read(Health))
      return (
        <ul>
          {handles.map((h) => (
            <Row key={h} handle={h} />
          ))}
        </ul>
      )
    }

    const html = renderToString(
      <WorldProvider world={world}>
        <App />
      </WorldProvider>,
    )
    expect(html).toContain('11')
    expect(html).toContain('22')
    void a
    void b
  })

  test('two renderToString passes around a world mutation see fresh values', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 1 }])
    tick()

    function Row({ handle }: { handle: EntityHandle }) {
      const health = useComponent(handle, Health)
      return <span>{`hp:${health?.hp ?? 'gone'}`}</span>
    }
    const pass = (): string =>
      renderToString(
        <WorldProvider world={world}>
          <Row handle={e} />
        </WorldProvider>,
      )

    expect(pass()).toContain('hp:1')

    world.entity(e).write(Health).hp = 2
    tick()
    expect(pass()).toContain('hp:2')
  })

  test('getServerSnapshot recomputes through a client-cached store (never serves the stale cache)', () => {
    const Health = mkHealth()
    const { world } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 1 }])

    function Row({ handle }: { handle: EntityHandle }) {
      const health = useComponent(handle, Health)
      return <span data-testid="hp">{`hp:${health?.hp ?? 'gone'}`}</span>
    }
    // A mounted client hook inserts the store into the bridge map and caches hp:1.
    const view = render(
      <WorldProvider world={world}>
        <Row handle={e} />
      </WorldProvider>,
    )
    expect(view.getByTestId('hp').textContent).toBe('hp:1')

    // An un-ticked write: the client cache (deferred observers) still shows 1, but the server
    // render resolves the SAME cached store and must recompute from storage.
    world.entity(e).write(Health).hp = 2
    const html = renderToString(
      <WorldProvider world={world}>
        <Row handle={e} />
      </WorldProvider>,
    )
    expect(html).toContain('hp:2')
  })

  test('renderToString leaves zero entries in the bridge maps (render-phase stores are never inserted)', () => {
    const Health = mkHealth()
    const { world } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 5 }])

    function App() {
      const handles = useQuery(read(Health))
      const health = useComponent(e, Health)
      const present = useHas(e, Health)
      return <div>{`${handles.length}:${health?.hp}:${String(present)}`}</div>
    }
    const html = renderToString(
      <WorldProvider world={world}>
        <App />
      </WorldProvider>,
    )
    expect(html).toContain('1:5:true')

    expect(liveStoreCount(world)).toBe(0)
    expect(liveObserverCount(world)).toBe(0)
  })
})
