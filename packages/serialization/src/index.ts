// @ecsia/serialization — the snapshot/delta copy layer + the zero-copy worker bootstrap.
//
// TWO TRANSPORTS, structurally separated (decision #9):
// - bootstrapForWorker → WorldBootstrap (SAB handles, never bytes): intra-process worker handoff,
// NO value serialization.
// - createSnapshotSerializer / createDeltaSerializer → Uint8Array bytes (never SAB handles):
// network / persistence / cross-isolate copy layer.

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

// Rich-field serialization policy hook — shared by SnapshotOptions + DeltaOptions.
export type { OnUnserializable, UnserializableContext } from './rich.js'

// ---- Replication envelope (Layer 3 recipe: ordered-reliable transports) ----
export {
  createReplicationStream,
  createReplicationReceiver,
  encodeReplicationMessage,
  decodeReplicationMessage,
  REPLICATION_MAGIC,
  REPLICATION_ENVELOPE_VERSION,
  REPLICATION_HEADER_BYTES,
} from './replication.js'
export type {
  ReplicationMessage,
  ReplicationStream,
  ReplicationStreamOptions,
  ReplicationReceiver,
  ReplicationApplyResult,
} from './replication.js'

// ---- Structural delta stream / observer log (Layer 2) ----
export { encodeStructuralOps, applyStructuralOps, createObserverLog } from './structural.js'
export type { ObserverLog, DeltaRecord } from './structural.js'

// ---- Format constants / op enum ----
export {
  SERIALIZATION_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  DeltaOp,
} from './format.js'
