// Planning across a *set* of crawls (ADR 0021, issue #88).
//
// One crawl produces one branch. A repertoire is many branches, and the moment
// there is more than one the branches can contradict each other: a sweeper run
// from `d4 d5 c4` picks its own answer to 2...e6, while a curated run forces
// 3.cxd5. Both are sound; a repertoire containing both is not a repertoire,
// because the one property it must have is that you know which move you play.
//
// This module is the arbitration. Each branch in the manifest **owns** its
// subtree; every other branch that would reach into it stops at the boundary and
// says who covers it. The rules are pure and stated in SAN, so they are testable
// without a board — see the note on transpositions in `delegationsFor`.
//
// Runtime-import-free, like its siblings, so scripts/repertoire/ can load it
// under Node's type stripping.

import type { Color } from './types'

/** One branch of the repertoire: a curated prefix plus how to crawl it. */
export interface PlanEntry {
  /** Stable identifier; also the output filename. */
  id: string
  /** Human name, carried into the PGN so a drill says what it is drilling. */
  name: string
  color: Color
  /**
   * The curated prefix in SAN, played verbatim before the crawler starts
   * choosing. Empty means "from the initial position".
   */
  line: string
  /** Why this branch is in the repertoire. Emitted as the PGN's opening comment. */
  why?: string
  /**
   * What the branch is *for*, which is what decides how deep it runs.
   *
   * `curated` (the default) is a line you are actually learning and gets the
   * full floor. `sweeper` covers the replies no curated branch owns, so you are
   * not surprised, and stops two plies earlier. `signpost` says "answer this
   * and transpose" and stops four earlier — its decision is the first move.
   *
   * The depths live in `scripts/repertoire/build.mjs` (`ROLE_DEPTH_OFFSET`),
   * because they are a property of a crawl rather than of the plan. Demoting a
   * branch is the first thing to reach for when the repertoire grows past what
   * one person can hold: at uniform depth the sweepers and signposts carried
   * 58% of the memorisation load.
   */
  role?: 'curated' | 'sweeper' | 'signpost'
  /** Per-entry crawl overrides; everything else comes from the run's defaults. */
  maxPly?: number
  minPly?: number
  trapThreshold?: number
  maxEvalPerNode?: number
  /**
   * Share of games to cover at an opponent node. Worth raising on a sweeper
   * whose popular replies all belong to other branches: the default target can
   * be met entirely by moves this branch hands away, leaving the tail it exists
   * to catch covered by nobody.
   */
  massTarget?: number
  maxOpponentMoves?: number
}

export function plies(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean)
}

/** True when the move at this 0-based ply index is ours. */
export function isOurPly(index: number, color: Color): boolean {
  return index % 2 === (color === 'w' ? 0 : 1)
}

function extends_(outer: readonly string[], inner: readonly string[]): boolean {
  return outer.length > inner.length && inner.every((san, i) => outer[i] === san)
}

/**
 * Where `entry` must stop because another branch owns what lies beyond, as
 * `SAN line → owning entry id`.
 *
 * The boundary sits **one ply past** this entry's own prefix: that is the first
 * position where the two branches could disagree. Ownership goes to the
 * shortest branch reaching through that point, so `d4` hands `1...d5` to the
 * Queen's Gambit sweeper rather than to the QGD Exchange buried under it.
 *
 * Keyed on the SAN path rather than the position, deliberately. Ownership is a
 * statement about *this manifest*, which is written in move order; a position
 * reached by a different order is a different line of study even when the board
 * is identical. Within a single crawl transpositions still collapse, as before.
 */
export function delegationsFor(
  entry: PlanEntry,
  entries: readonly PlanEntry[],
): Map<string, string> {
  const mine = plies(entry.line)
  const owners = new Map<string, PlanEntry>()

  for (const other of entries) {
    if (other.id === entry.id) continue
    // A White branch never owns part of a Black one: they are separate
    // repertoires that happen to share notation.
    if (other.color !== entry.color) continue
    const theirs = plies(other.line)
    if (!extends_(theirs, mine)) continue

    const point = theirs.slice(0, mine.length + 1).join(' ')
    const held = owners.get(point)
    if (!held || theirs.length < plies(held.line).length) owners.set(point, other)
  }

  return new Map([...owners].map(([point, owner]) => [point, owner.id]))
}

/** Something wrong with the manifest. Every one of these aborts the run. */
export interface PlanProblem {
  entryId: string
  message: string
}

/**
 * Check the manifest before spending an hour of engine time on it.
 *
 * The check that earns its keep is the **coverage gap**. When a branch stops at
 * a boundary, the owner picks up from its own prefix — so every ply the owner
 * forces beyond that boundary is a position neither branch examined. That is
 * harmless when the forced plies are *ours* (a single choice we were going to
 * make anyway), and a hole when any of them is the opponent's: their
 * alternatives at that point belong to nobody. `e4 c6` handing the whole 2.d4
 * complex to a branch that opens `2.d4 d5 3.e5` silently drops 3.Nc3, 3.Nd2 and
 * 3.exd5 — a repertoire that looks complete and loses to the second-most-common
 * move.
 */
export function validatePlan(entries: readonly PlanEntry[]): PlanProblem[] {
  const problems: PlanProblem[] = []
  const byId = new Map<string, PlanEntry>()
  const byLine = new Map<string, PlanEntry>()

  for (const entry of entries) {
    if (byId.has(entry.id)) {
      problems.push({ entryId: entry.id, message: 'duplicate id' })
    }
    byId.set(entry.id, entry)

    const lineKey = `${entry.color}|${plies(entry.line).join(' ')}`
    const clash = byLine.get(lineKey)
    if (clash) {
      problems.push({
        entryId: entry.id,
        message: `same colour and line as "${clash.id}" — one of them decides nothing`,
      })
    }
    byLine.set(lineKey, entry)
  }

  for (const entry of entries) {
    for (const [point, ownerId] of delegationsFor(entry, entries)) {
      const owner = byId.get(ownerId)
      if (!owner) continue
      const boundary = plies(point).length
      const forced = plies(owner.line).slice(boundary)
      const gap = forced.findIndex((_, i) => !isOurPly(boundary + i, entry.color))
      if (gap === -1) continue
      problems.push({
        entryId: entry.id,
        message:
          `stops at "${point}" for "${ownerId}", which then assumes ${forced[gap]} — ` +
          `the opponent's alternatives there are covered by nothing. ` +
          `Add an entry whose line is "${[...plies(point), ...forced.slice(0, gap)].join(' ')}".`,
      })
    }
  }

  return problems
}

// ---------------------------------------------------------------------------
// What it costs to learn
// ---------------------------------------------------------------------------

/** The shape `theoryLoad` needs from a crawled node. */
export interface LoadedNode {
  ours?: boolean
  ply?: number
  terminal?: boolean
  terminalReason?: string
  children?: readonly unknown[]
}

export interface TheoryLoad {
  /** Positions where we must know which move to play. The thing to memorise. */
  ourDecisions: number
  /** Opponent moves we have a prepared answer to. The thing being covered. */
  preparedReplies: number
  /** Quiet terminal positions — the items actually worth training. */
  quietTargets: number
  /** Positions handed to another branch. */
  delegated: number
  /** Positions where the book ran dry before the line went quiet. */
  outOfBook: number
  deepestPly: number
}

/**
 * How much of this branch you actually have to hold in your head.
 *
 * `ourDecisions` is the honest cost of a repertoire and the number
 * [repertoire-v1](../../docs/repertoire-v1.md) promised rather than guessed
 * when it cut the London: "a number we will have, not a guess."
 */
export function theoryLoad(nodes: Iterable<LoadedNode>): TheoryLoad {
  const load: TheoryLoad = {
    ourDecisions: 0,
    preparedReplies: 0,
    quietTargets: 0,
    delegated: 0,
    outOfBook: 0,
    deepestPly: 0,
  }
  for (const node of nodes) {
    const children = node.children?.length ?? 0
    if (node.ours && children > 0) load.ourDecisions++
    if (!node.ours) load.preparedReplies += children
    if (node.terminalReason === 'quiet') load.quietTargets++
    if (node.terminalReason === 'delegated') load.delegated++
    if (node.terminalReason === 'out-of-book') load.outOfBook++
    if (typeof node.ply === 'number') load.deepestPly = Math.max(load.deepestPly, node.ply)
  }
  return load
}

/**
 * Add per-branch loads into the repertoire's total.
 *
 * Every field, not a chosen four. An aggregate that quietly drops `delegated`
 * and `deepestPly` is a different shape from the thing it claims to sum, and a
 * consumer typing it as `TheoryLoad` gets `undefined` for both.
 */
export function sumLoads(loads: Iterable<TheoryLoad>): TheoryLoad {
  const total = theoryLoad([])
  for (const load of loads) {
    total.ourDecisions += load.ourDecisions
    total.preparedReplies += load.preparedReplies
    total.quietTargets += load.quietTargets
    total.delegated += load.delegated
    total.outOfBook += load.outOfBook
    // Depth is the deepest anywhere, not a sum: adding plies across branches
    // would describe a game nobody plays.
    total.deepestPly = Math.max(total.deepestPly, load.deepestPly)
  }
  return total
}
