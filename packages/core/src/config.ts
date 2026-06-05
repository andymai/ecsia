// WorldOptions, canonical defaults, and fail-fast resolution/validation.
// All feature knobs are nested under their feature key ( nesting rule).

export type ObserverCadence = 'frame-end' | 'per-system'
export type ChangeTracking = 'component' | 'field'
export type WorkerOption = number | 'no-sab'

export interface ReactivityOptions {
  maxWritesPerFrame?: number
  maxShapeChangesPerFrame?: number
  observerCadence?: ObserverCadence
  changeTrackingDefault?: ChangeTracking
  logEntryWords?: 1 | 2
  shrinkRings?: boolean
}

export interface SchedulerOptions {
  workers?: WorkerOption
}

export interface WorldOptions {
  // Registration (loosely typed until the component/relation/system specs land at).
  components?: readonly unknown[]
  relations?: readonly unknown[]
  systems?: readonly unknown[]

  // Entity identity.
  maxEntities?: number
  generationBits?: number

  // Threading / backing. Single-thread executor ships first.
  threaded?: boolean

  // Archetype fragmentation cap.
  maxHotArchetypes?: number

  // Feature knobs — NESTED, never flat.
  reactivity?: ReactivityOptions
  scheduler?: SchedulerOptions
}

export interface ResolvedReactivityOptions {
  readonly maxWritesPerFrame: number
  readonly maxShapeChangesPerFrame: number
  readonly observerCadence: ObserverCadence
  readonly changeTrackingDefault: ChangeTracking
  readonly logEntryWords: 1 | 2
  readonly shrinkRings: boolean
}

export interface ResolvedWorldOptions {
  readonly components: readonly unknown[]
  readonly relations: readonly unknown[]
  readonly systems: readonly unknown[]
  readonly maxEntities: number
  readonly generationBits: number
  /** Derived: 32 - generationBits. */
  readonly indexBits: number
  readonly threaded: boolean
  readonly maxHotArchetypes: number
  readonly reactivity: ResolvedReactivityOptions
  readonly scheduler: { readonly workers: WorkerOption }
}

/** Thrown synchronously at construction for any invalid configuration. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
  constructor(message: string) {
    super(message)
  }
}

const isPositiveInt = (n: number): boolean => Number.isInteger(n) && n > 0

export function resolveOptions(options: WorldOptions = {}): ResolvedWorldOptions {
  const generationBits = options.generationBits ?? 10
  if (!Number.isInteger(generationBits) || generationBits < 0 || generationBits > 31) {
    throw new ConfigError(
      `generationBits must be an integer in [0, 31] (so indexBits = 32 - generationBits is valid); got ${generationBits}`,
    )
  }
  const indexBits = 32 - generationBits
  const threaded = options.threaded ?? false

  // Generations are the worker stale-handle detection mechanism; 0 is unsafe under threading.
  if (generationBits === 0 && threaded) {
    throw new ConfigError('generationBits must be > 0 when threaded === true (worker stale-handle detection)')
  }

  const maxEntities = options.maxEntities ?? 1 << 20
  if (!isPositiveInt(maxEntities)) {
    throw new ConfigError(`maxEntities must be a positive integer; got ${maxEntities}`)
  }
  const maxIndex = 2 ** indexBits
  if (maxEntities > maxIndex) {
    throw new ConfigError(
      `maxEntities (${maxEntities}) exceeds the index space 2^${indexBits} = ${maxIndex} for generationBits=${generationBits}`,
    )
  }

  const maxHotArchetypes = options.maxHotArchetypes ?? Math.max(256, maxEntities >>> 8)
  if (!isPositiveInt(maxHotArchetypes)) {
    throw new ConfigError(`maxHotArchetypes must be a positive integer; got ${maxHotArchetypes}`)
  }

  const relations = options.relations ?? []
  const r = options.reactivity ?? {}
  const maxWritesPerFrame = r.maxWritesPerFrame ?? maxEntities * 4
  const maxShapeChangesPerFrame = r.maxShapeChangesPerFrame ?? maxEntities * 2
  if (!isPositiveInt(maxWritesPerFrame)) {
    throw new ConfigError(`reactivity.maxWritesPerFrame must be a positive integer; got ${maxWritesPerFrame}`)
  }
  if (!isPositiveInt(maxShapeChangesPerFrame)) {
    throw new ConfigError(`reactivity.maxShapeChangesPerFrame must be a positive integer; got ${maxShapeChangesPerFrame}`)
  }
  // Two-word log entries when any relation is registered ( C2).
  const logEntryWords: 1 | 2 = r.logEntryWords ?? (relations.length > 0 ? 2 : 1)

  const workers: WorkerOption = options.scheduler?.workers ?? 0
  if (typeof workers === 'number' && (!Number.isInteger(workers) || workers < 0)) {
    throw new ConfigError(`scheduler.workers must be a non-negative integer or 'no-sab'; got ${workers}`)
  }

  return {
    components: options.components ?? [],
    relations,
    systems: options.systems ?? [],
    maxEntities,
    generationBits,
    indexBits,
    threaded,
    maxHotArchetypes,
    reactivity: {
      maxWritesPerFrame,
      maxShapeChangesPerFrame,
      observerCadence: r.observerCadence ?? 'frame-end',
      changeTrackingDefault: r.changeTrackingDefault ?? 'component',
      logEntryWords,
      shrinkRings: r.shrinkRings ?? false,
    },
    scheduler: { workers },
  }
}
