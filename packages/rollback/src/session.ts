// The GGPO-style predict → confirm → rollback → re-simulate loop over the capture/restore seam
// (rollback.ts): a bounded checkpoint ring, a per-player frame-indexed input buffer, and a
// re-simulation from the last known-good frame when a prediction turns out wrong.
//
// DELIBERATELY DECOUPLED, twice over. There is no @ecsia/scheduler dependency — the caller hands in
// `step`, ONE fixed-step advance of its own frame loop. And the engine is schema-agnostic — an input
// is opaque bytes it buffers, predicts and byte-compares; `applyInputs` is what writes those bytes
// into whatever components the systems read.

import { createRollbackSurface } from './rollback.js'
import type { RollbackImage, RollbackSurface } from './rollback.js'
import type { World } from '@ecsia/core'

/** A fixed-step simulation frame. Aligned 1:1 with `world.tick`: one `step()` == one tick. */
export type Frame = number

export type PlayerId = number | string

/** App-defined opaque input bytes. The engine never interprets them — it buffers and compares. */
export type InputImage = Uint8Array

/**
 * How to synthesize a remote player's input for a frame that has no confirmed one yet.
 * `lastConfirmed` is that player's most recently confirmed input, or null before their first.
 * Default: repeat it (the GGPO default — correct for held-button controls).
 */
export type PredictionPolicy = (player: PlayerId, frame: Frame, lastConfirmed: InputImage | null) => InputImage

/**
 * One frame's inputs, as handed to `applyInputs`. A REUSED view valid only for the duration of that
 * call — read it, don't retain it. The returned bytes alias the session's input buffer.
 */
export interface FrameInputs {
  readonly frame: Frame
  /** The session's players, in the order given to {@link RollbackOptions.players}. */
  readonly players: readonly PlayerId[]
  /** This frame's input for `player` — real or predicted. */
  get(player: PlayerId): InputImage
  /** True when this frame's input for `player` is a prediction rather than a confirmed input. */
  isPredicted(player: PlayerId): boolean
}

/** A rollback the session could not perform — the app must resync from a fresh authoritative state. */
export interface UnrecoverableRollback {
  /** The frame the correction was for. */
  readonly frame: Frame
  readonly currentFrame: Frame
  readonly maxRollbackFrames: number
  readonly message: string
}

export interface RollbackOptions {
  /**
   * Maximum rollback DEPTH in frames: a correction for a frame more than this far behind
   * `currentFrame` is unrecoverable. Must exceed worst-case input latency. (The ring itself holds
   * one more image than this — a rollback to the deepest allowed frame restores the checkpoint
   * taken BEFORE it.)
   */
  readonly maxRollbackFrames: number
  readonly players: readonly PlayerId[]
  /**
   * ONE fixed-step advance of the app's frame loop — typically `() => scheduler.update(dt)`. It MUST
   * advance `world.tick` exactly once and MUST end at a frame boundary (its observer drain done), or
   * the session throws: the checkpoint taken right after it would otherwise be mid-frame.
   */
  readonly step: () => void
  /** Write `inputs` into the world so `step()` reads them. Called before every step, re-sims included. */
  readonly applyInputs: (frame: Frame, inputs: FrameInputs) => void
  /** Default: repeat the player's last confirmed input (empty bytes before their first). */
  readonly predict?: PredictionPolicy
  /** Misprediction test. Default: byte equality. */
  readonly equalsInput?: (a: InputImage, b: InputImage) => boolean
  /** Called instead of throwing when a rollback is unrecoverable (the world is left untouched). */
  readonly onUnrecoverable?: (info: UnrecoverableRollback) => void
}

export interface RollbackSession {
  /**
   * Advance one frame: predict any missing input, `applyInputs`, `step()`, checkpoint. Returns the
   * frame just simulated.
   */
  advance(): Frame
  /**
   * Record a REAL input. A frame at or behind `currentFrame` whose prediction it contradicts
   * triggers the rollback + re-simulation synchronously, inside this call; one that matches the
   * prediction costs nothing but an advancing `confirmedFrame`. Future frames are buffered (up to
   * `maxRollbackFrames` ahead). Transport is the caller's job.
   */
  recordInput(player: PlayerId, frame: Frame, input: InputImage): void
  readonly currentFrame: Frame
  /** The latest simulated frame no player's input was predicted at. */
  readonly confirmedFrame: Frame
}

const EMPTY_INPUT: InputImage = new Uint8Array(0)

function bytesEqual(a: InputImage, b: InputImage): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function capacityFor(length: number): number {
  let cap = 1
  while (cap < length) cap *= 2
  return cap
}

interface InputSlot {
  /** The frame these bytes are for; -1 when never written. A mismatch means the slot went stale. */
  frame: Frame
  bytes: Uint8Array
  length: number
  confirmed: boolean
  /** Cached `bytes.subarray(0, length)` — dropped only when the buffer or the length changes. */
  view: InputImage | null
}

interface PlayerState {
  readonly id: PlayerId
  readonly slots: InputSlot[]
  lastConfirmedFrame: Frame
  lastConfirmed: Uint8Array
  lastConfirmedLength: number
  lastConfirmedView: InputImage | null
}

function writeSlot(slot: InputSlot, frame: Frame, input: InputImage, confirmed: boolean): void {
  if (slot.bytes.length < input.length) {
    slot.bytes = new Uint8Array(capacityFor(input.length))
    slot.view = null
  }
  if (slot.length !== input.length) slot.view = null
  slot.bytes.set(input, 0)
  slot.length = input.length
  slot.frame = frame
  slot.confirmed = confirmed
}

function slotView(slot: InputSlot): InputImage {
  slot.view ??= slot.bytes.subarray(0, slot.length)
  return slot.view
}

/**
 * Drive a world through a rollback-netcode loop. Creates its own {@link RollbackSurface} and
 * checkpoints the world as it stands NOW as frame `world.tick` — construct it at a frame boundary,
 * with the world in the state every peer agrees on.
 *
 * FRAME↔TICK: a session frame IS `world.tick`. `currentFrame` starts at the world's tick and every
 * `step()` must advance both by exactly one; the session asserts it rather than assuming it.
 *
 * BOUND: `world.tick` is u32 while `currentFrame` is an unbounded JS number, so a single session
 * running past 2^32 frames (~2.3 years at 60 Hz) trips that assert rather than silently desyncing.
 * Unhandled by design — no real session reaches it, and failing loudly beats a wrapped comparison.
 */
export function createRollbackSession(world: World, opts: RollbackOptions): RollbackSession {
  const maxRollbackFrames = opts.maxRollbackFrames
  if (!Number.isInteger(maxRollbackFrames) || maxRollbackFrames < 1) {
    throw new Error(`rollback session: maxRollbackFrames must be a positive integer (got ${String(maxRollbackFrames)})`)
  }
  if (opts.players.length === 0) throw new Error('rollback session: players must not be empty')

  const players: readonly PlayerId[] = [...opts.players]
  const playerIndex = new Map<PlayerId, number>()
  for (const id of players) {
    if (playerIndex.has(id)) throw new Error(`rollback session: duplicate player id ${String(id)}`)
    playerIndex.set(id, playerIndex.size)
  }

  const predict: PredictionPolicy = opts.predict ?? ((_player, _frame, lastConfirmed) => lastConfirmed ?? EMPTY_INPUT)
  const equals = opts.equalsInput ?? bytesEqual

  const surface: RollbackSurface = createRollbackSurface(world)
  // Held-row census only: the frame-boundary proof below. No state is installed by reading it.
  const host = world.__installRollback()

  // depth + 1: rolling back to depth `maxRollbackFrames` restores the checkpoint of the frame BEFORE
  // it, so the ring must still hold one image older than the deepest re-simulated frame.
  const ringSize = maxRollbackFrames + 1
  const images: RollbackImage[] = []
  const imageFrames: number[] = []
  for (let i = 0; i < ringSize; i++) {
    images.push(surface.newImage())
    imageFrames.push(-1)
  }

  // The input window must cover the deepest re-simulated frame (currentFrame - maxRollbackFrames + 1)
  // through the furthest buffered future one (currentFrame + maxRollbackFrames) at once.
  const inputCapacity = maxRollbackFrames * 2
  const states: PlayerState[] = players.map((id) => ({
    id,
    slots: Array.from({ length: inputCapacity }, () => ({
      frame: -1,
      bytes: new Uint8Array(0),
      length: 0,
      confirmed: false,
      view: null,
    })),
    lastConfirmedFrame: -1,
    lastConfirmed: new Uint8Array(0),
    lastConfirmedLength: 0,
    lastConfirmedView: null,
  }))

  const stateOf = (player: PlayerId): PlayerState => {
    const i = playerIndex.get(player)
    if (i === undefined) {
      throw new Error(`rollback session: unknown player ${String(player)} — players are fixed at createRollbackSession`)
    }
    return states[i] as PlayerState
  }

  const startFrame = world.tick
  let currentFrame = startFrame
  let confirmedFrame = startFrame
  let viewFrame = startFrame

  const slotAt = (state: PlayerState, frame: Frame): InputSlot => state.slots[frame % inputCapacity] as InputSlot

  const inputs: FrameInputs = {
    get frame(): Frame {
      return viewFrame
    },
    players,
    get(player: PlayerId): InputImage {
      const slot = slotAt(stateOf(player), viewFrame)
      if (slot.frame !== viewFrame) {
        throw new Error(`rollback session: no buffered input for player ${String(player)} at frame ${viewFrame}`)
      }
      return slotView(slot)
    },
    isPredicted(player: PlayerId): boolean {
      const slot = slotAt(stateOf(player), viewFrame)
      return slot.frame !== viewFrame || !slot.confirmed
    },
  }

  const lastConfirmedOf = (state: PlayerState): InputImage | null => {
    if (state.lastConfirmedFrame < 0) return null
    state.lastConfirmedView ??= state.lastConfirmed.subarray(0, state.lastConfirmedLength)
    return state.lastConfirmedView
  }

  const noteConfirmed = (state: PlayerState, frame: Frame, input: InputImage): void => {
    if (frame < state.lastConfirmedFrame) return
    if (state.lastConfirmed.length < input.length) {
      state.lastConfirmed = new Uint8Array(capacityFor(input.length))
      state.lastConfirmedView = null
    }
    if (state.lastConfirmedLength !== input.length) state.lastConfirmedView = null
    state.lastConfirmed.set(input, 0)
    state.lastConfirmedLength = input.length
    state.lastConfirmedFrame = frame
  }

  const applyFrame = (frame: Frame): void => {
    for (const state of states) {
      const slot = slotAt(state, frame)
      // A re-simulated frame that is STILL unconfirmed re-predicts: a correction that landed since
      // moved `lastConfirmed`, and the better guess is the whole point of replaying it.
      if (slot.frame === frame && slot.confirmed) continue
      writeSlot(slot, frame, predict(state.id, frame, lastConfirmedOf(state)), false)
    }
    viewFrame = frame
    opts.applyInputs(frame, inputs)
  }

  const runStep = (frame: Frame): void => {
    opts.step()
    if (world.tick !== frame) {
      throw new Error(
        `rollback session: step() left world.tick at ${world.tick}, expected ${frame} — one session frame is exactly ONE fixed step (one world.tick increment). ` +
          'Pass a step that runs a single frame (e.g. scheduler.update(dt)) and never advance the tick outside the session.',
      )
    }
  }

  const captureInto = (frame: Frame): void => {
    // An image rewinds STATE, not the EVENT STREAM (see RollbackSurface): the reactivity log rings
    // and the pending observer window sit OUTSIDE it, so a checkpoint taken mid-frame lets an event
    // journaled after it still drain once the restore has revoked what it describes. A checkpoint is
    // therefore only ever taken here — immediately after `step()` returns, which is a post-drain
    // frame boundary — and the observable symptom of a step that ended early is asserted, not
    // assumed: held rows are what the drain releases, so any left mean the drain has not run.
    let held = 0
    for (const arch of host.archetypes.byId) held += arch.held
    if (held > 0) {
      throw new Error(
        `rollback session: frame ${frame} cannot be checkpointed — ${held} deferred-dead rows are still held for an observer drain that step() has not run. ` +
          'A checkpoint must be taken at a frame boundary: an image rewinds state, not the event stream, so those events would drain after a restore that revoked them.',
      )
    }
    const slot = frame % ringSize
    surface.captureImage(images[slot] as RollbackImage)
    imageFrames[slot] = frame
  }

  const unrecoverable = (frame: Frame, message: string): void => {
    if (opts.onUnrecoverable === undefined) throw new Error(`rollback session: ${message}`)
    opts.onUnrecoverable({ frame, currentFrame, maxRollbackFrames, message })
  }

  const rollbackTo = (frame: Frame): void => {
    const depth = currentFrame - frame
    if (depth >= maxRollbackFrames) {
      unrecoverable(
        frame,
        `frame ${frame} is ${depth} frames behind frame ${currentFrame}, past the ${maxRollbackFrames}-frame rollback window — the world is untouched (no partial rewind); resync from a fresh authoritative state`,
      )
      return
    }
    const baseline = frame - 1
    const slot = baseline % ringSize
    if (imageFrames[slot] !== baseline) {
      unrecoverable(
        frame,
        `the checkpoint for frame ${baseline} is no longer in the ring (slot holds frame ${String(imageFrames[slot])}) — the world is untouched (no partial rewind); resync from a fresh authoritative state`,
      )
      return
    }
    surface.restoreImage(images[slot] as RollbackImage)
    // The image carries the tick, so this is a check of frame↔tick alignment, not a repair: a
    // disagreement means a checkpoint was keyed to a frame it was not taken at.
    if (world.tick !== baseline) {
      throw new Error(
        `rollback session: the checkpoint keyed to frame ${baseline} restored world.tick ${world.tick} — frame/tick alignment is broken`,
      )
    }
    for (let f = frame; f <= currentFrame; f++) {
      applyFrame(f)
      runStep(f)
      captureInto(f)
    }
  }

  const allConfirmedAt = (frame: Frame): boolean => {
    for (const state of states) {
      const slot = slotAt(state, frame)
      if (slot.frame !== frame || !slot.confirmed) return false
    }
    return true
  }

  const advanceConfirmed = (): void => {
    while (confirmedFrame < currentFrame && allConfirmedAt(confirmedFrame + 1)) confirmedFrame += 1
  }

  // The frame-`startFrame` checkpoint: what a rollback to `startFrame + 1` rewinds to. Nothing has
  // been stepped yet, so this is a frame boundary by construction.
  captureInto(startFrame)

  return {
    advance(): Frame {
      const frame = currentFrame + 1
      applyFrame(frame)
      runStep(frame)
      captureInto(frame)
      currentFrame = frame
      advanceConfirmed()
      return frame
    },

    recordInput(player: PlayerId, frame: Frame, input: InputImage): void {
      const state = stateOf(player)
      if (!Number.isInteger(frame) || frame <= startFrame) {
        throw new Error(
          `rollback session: frame ${String(frame)} is not a frame this session simulates — its first frame is ${startFrame + 1} (frames are world ticks)`,
        )
      }
      if (frame > currentFrame + maxRollbackFrames) {
        throw new Error(
          `rollback session: input for frame ${frame} is more than ${maxRollbackFrames} frames ahead of frame ${currentFrame} — the input buffer cannot hold it without evicting a frame a rollback still needs`,
        )
      }
      const slot = slotAt(state, frame)
      if (frame <= currentFrame && slot.frame !== frame) {
        unrecoverable(
          frame,
          `frame ${frame} has already left the ${inputCapacity}-frame input buffer, so its prediction cannot be checked — the world is untouched (no partial rewind); resync from a fresh authoritative state`,
        )
        return
      }
      const mispredicted = slot.frame === frame && !slot.confirmed && !equals(input, slotView(slot))
      writeSlot(slot, frame, input, true)
      noteConfirmed(state, frame, input)
      if (frame <= currentFrame && mispredicted) rollbackTo(frame)
      advanceConfirmed()
    },

    get currentFrame(): Frame {
      return currentFrame
    },

    get confirmedFrame(): Frame {
      return confirmedFrame
    },
  }
}
