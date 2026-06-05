// Reserved ComponentId space (C3).
// ComponentId 0 is NEVER a user component: it is the NO_COMPONENT sentinel, doubling as the
// CREATE/DESTROY shape-log "no component" marker and the changeVersion sentinel.

/** A dense component type id. Branded so raw numbers can't be passed where a ComponentId is required. */
export type ComponentId = number & { readonly __ecsiaComponentId: unique symbol }

/** The reserved "no component" sentinel. Also the shape-log CREATE/DESTROY marker. */
export const NO_COMPONENT = 0 as ComponentId

/** First id handed out to user components; everything below is reserved. */
export const FIRST_USER_COMPONENT_ID = 1 as ComponentId
