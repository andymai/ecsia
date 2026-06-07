// Command-buffer op ordinals. These numeric
// values are SHARED across command-buffer `Op`, serialization `DeltaOp`, and reactivity `ShapeKind`
// — the member names differ per spec but the numeric values are identical. Pinning them here is what
// lets the apply path be reused across command-buffer and serialization.
//
// declares the FORMAT only. The encode methods (CommandEncoder) and the
// per-worker SAB transport land at; ships the ordinals, the self-describing record-length
// function, and a direct main-thread apply seam so is purely additive.

export const enum Op {
  CREATE = 0, // OP_CREATE reservedEid
  DESTROY = 1, // OP_DESTROY eid
  ADD = 2, // OP_ADD eid componentId fieldWordCount [field words...]
  REMOVE = 3, // OP_REMOVE eid componentId
  ADD_PAIR = 4, // OP_ADD_PAIR eid relationId targetEid payloadWordCount [payload words...]
  REMOVE_PAIR = 5, // OP_REMOVE_PAIR eid relationId targetEid
  SET_PAYLOAD = 6, // OP_SET_PAYLOAD eid componentId fieldWordCount [field words...]
  PUBLISH = 7, // OP_PUBLISH topicId publisherSystemId fieldWordCount [field words...]
  CONSUMED = 8, // OP_CONSUMED topicId consumerSystemId seq — worker consume cursor advance (exclusive end)
}

/**
 * Self-describing record length in u32 words. Every record's length is
 * computable from its first word(s) WITHOUT consulting any schema — the variable-arity ops carry an
 * explicit count word — so the merge loop can skip/iterate records with no schema lookup.
 */
export function recordLen(words: Uint32Array, at: number): number {
  switch (words[at] as Op) {
    case Op.CREATE:
      return 2
    case Op.DESTROY:
      return 2
    case Op.REMOVE:
      return 3
    case Op.REMOVE_PAIR:
    case Op.CONSUMED:
      return 4
    case Op.ADD:
    case Op.SET_PAYLOAD:
    case Op.PUBLISH:
      return 4 + (words[at + 3] as number) // 4 + fieldWordCount
    case Op.ADD_PAIR:
      return 5 + (words[at + 4] as number) // 5 + payloadWordCount
    default:
      throw new Error(`corrupt command buffer: bad opcode ${words[at]} at ${at}`)
  }
}
