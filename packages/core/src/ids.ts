// Reserved ComponentId space (C3).
// ComponentId 0 is NEVER a user component: it is the NO_COMPONENT sentinel, doubling as the
// CREATE/DESTROY shape-log "no component" marker and the changeVersion sentinel.

import type { ComponentId } from '@ecsia/schema'

/** A dense component type id. The schema-level brand — every kernel surface is typed with it. */
export type { ComponentId } from '@ecsia/schema'

/** The reserved "no component" sentinel. Also the shape-log CREATE/DESTROY marker. */
export const NO_COMPONENT = 0 as ComponentId

/** First id handed out to user components; everything below is reserved. */
export const FIRST_USER_COMPONENT_ID = 1 as ComponentId
