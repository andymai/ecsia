// jsdom project setup: React's act() guard expects this flag in non-preset test environments, and
// RTL's automatic cleanup only registers itself when test globals exist — vitest runs without
// globals here, so register cleanup explicitly.

import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
})
