// @ecsia/serialization — the snapshot/delta copy layer + the zero-copy worker bootstrap (serialization.md, M10).
//
// TWO TRANSPORTS, structurally separated (decision #9, S-1):
//   - bootstrapForWorker → WorldBootstrap (SAB handles, never bytes): intra-process worker handoff,
//     NO value serialization (§3).
//   - createSnapshotSerializer / createDeltaSerializer → Uint8Array bytes (never SAB handles):
//     network / persistence / cross-isolate copy layer (§4–§7).

// ---- Zero-copy worker bootstrap (Layer 1) ----
export { bootstrapForWorker, attachWorld, applyColumnsAdded } from './bootstrap.js'
export type { WorldBootstrap, WorkerWorldView, ColumnsAdded, SerializedRegistry } from './bootstrap.js'

// ---- Copy snapshot (Layer 3) ----
export { createSnapshotSerializer } from './snapshot.js'
export type { SnapshotSerializer, SnapshotOptions } from './snapshot.js'
export { createSnapshotDeserializer } from './deserialize.js'
export type { SnapshotDeserializer, DeserializeResult } from './deserialize.js'

// ---- Copy delta (Layer 3, version-stamp driven) ----
export { createDeltaSerializer, applyDelta } from './delta.js'
export type { DeltaSerializer, DeltaOptions } from './delta.js'

// ---- Structural delta stream / observer log (Layer 2) ----
export { encodeStructuralOps, applyStructuralOps, createObserverLog } from './structural.js'
export type { ObserverLog, DeltaRecord } from './structural.js'

// ---- Format constants / op enum ----
export {
  SERIALIZATION_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  DeltaOp,
} from './format.js'
