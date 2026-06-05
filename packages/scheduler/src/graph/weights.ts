// Priority-weighted conflict-edge scheme (becsy weight scheme). Highest weight
// wins for an ordered pair; a DENY removes the IMPLICIT edge only (it cannot remove a 3/5 edge).

export const enum EdgeWeight {
  EXPLICIT = 5, // before/after — user-declared, never overridden
  DENY = 4, // inAnyOrderWith(A,B) — suppresses an IMPLICIT edge between A,B
  CLASS_HINT = 3, // beforeWritersOf(C) / afterReadersOf(C)
  IMPLICIT = 1, // auto write-before-read / write-before-write conflict edge
}
