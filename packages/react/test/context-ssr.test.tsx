// WorldProvider/useWorld context plumbing, and SSR: getServerSnapshot is the same synchronous
// snapshot computation, so renderToString emits the world's tick-zero state.

import { describe, expect, test } from 'vitest'
import { renderToString } from 'react-dom/server'
import { render } from '@testing-library/react'
import { defineComponent } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { read } from '@ecsia/schema'
import { WorldProvider, useComponent, useQuery, useWorld } from '../src/index.js'
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
})
