import { meanAccuracy } from '../domain/accuracy'
import { swingFromWhitePercent } from '../domain/winPercent'
import type { PositionEval } from '../domain/gameRecord'
import type { StoredGame } from '../persist/db'

/**
 * Batch-analysing a whole stored game: which positions still need work, and how
 * far along we are. Pure — the hook drives the engine, this decides what to ask
 * it and how to fold the answers back in.
 *
 * The pass is typed **structurally** (`AnalysableGame`), so the one pass covers
 * a game you played against Maia and a game you imported (#133) — they live in
 * different tables and share no field but the moves. The figures about *your
 * play* below (`yourPlies`, `accuracyReport`) deliberately stay on `StoredGame`:
 * a coach log and a side of yours are things only a game you played has.
 */

/**
 * The budget this project's measurements are stated against.
 *
 * `npm run review`'s default, and the number every claim in the `game-review`
 * skill is calibrated on. **Not reachable in the browser** — it is here as the
 * yardstick the in-app budgets are described against, and as the budget an
 * off-app pass would file its results under (see `supersedes`).
 *
 * Measured on this machine: native Stockfish takes ~4.13 s per search at 4M
 * single-threaded, ~0.50 s effective across a pool of ten. A whole-game pass is
 * ~240 searches, so ~2 min on the native pool and ~16.5 min on one native
 * engine. WASM is 2–3× slower again than native single-thread and cannot run
 * that pool, which puts a 4M in-app pass at roughly three quarters of an hour
 * per game. That is not a budget, it is a different piece of software.
 */
export const REFERENCE_NODES = 4_000_000

/**
 * Nodes per position for the in-app full-game pass.
 *
 * **Read the honest framing below before changing this.** 150k was justified as
 * "coverage, not depth on one", which was defensible while the output was
 * annotation glyphs and is not defensible now that `domain/keyMoments.ts` (#132)
 * picks which positions you are quizzed on out of these same evaluations, and
 * #144 builds a mode on that.
 *
 * The project has measured the direction of the error. From
 * `scripts/review/game.mjs`: grading the reference game at **800k** against 4M
 * produced *one false negative* — 44…Nd4+ (−5.9%, Tier B) looked clean and would
 * never have reached the deep pass — *zero phantoms*, and understated the total
 * win% given away by 10% (53.4 vs 58.9). A cheap pass **misses** mistakes rather
 * than inventing them, which the `game-review` skill calls out as the worse
 * direction for coaching.
 *
 * So the honest position is not a bigger number. **No budget a browser can
 * afford makes an absence trustworthy** — 800k already loses a real Tier B move
 * and a WASM pass cannot get near 800k over a whole game in a tolerable time.
 * The consequences are two, and both are load-bearing:
 *
 * - The UI never says "the critical positions in this game". It says **the
 *   positions this pass could see**, everywhere, at every budget (§9, §12).
 * - The deep pass belongs off-app, where `scripts/` already has the engine pool,
 *   writing into the same `dbAnalysis` table. `supersedes` below is the seam:
 *   a stored complete pass at a deeper budget wins and no WASM work is done.
 *
 * Within that, this is a *time* choice, and it is set where a full game is a
 * couple of minutes rather than a coffee break — see `ANALYSIS_BUDGETS`.
 *
 * One budget serves both passes (`useGameAnalysis`, `useDbGameAnalysis`) and
 * both must keep taking it from here — evaluations recorded at two budgets and
 * differenced against each other manufacture swings out of nothing
 * (docs/architecture.md, cross-cutting rules).
 */
export const BATCH_NODES = 400_000

/**
 * A pass budget the user may choose, with what choosing it costs.
 *
 * The note is not marketing copy. It is on the type so a screen cannot offer a
 * budget without being able to say what it buys and what it does not
 * (constitution §9, §12) — and what none of them buys is a trustworthy absence.
 */
export interface AnalysisBudget {
  id: string
  label: string
  nodes: number
  /** What this budget is for, in one sentence, on screen. */
  note: string
}

/**
 * The in-app budgets, cheapest first.
 *
 * A time/thoroughness trade and nothing more — every one of them is far below
 * the budget at which a missing finding starts to mean something, so the caveat
 * that goes with them is the same caveat at all three and is written once, in
 * the UI, rather than varied per option as though the top one were safe.
 *
 * The old 150k is gone rather than kept as the fast option: it is the setting
 * this project's own measurement condemns most directly, and leaving it on the
 * menu would let the mode be opened at it by habit.
 */
export const ANALYSIS_BUDGETS: AnalysisBudget[] = [
  {
    id: 'quick',
    label: 'Quick — 250k nodes per position',
    nodes: 250_000,
    note: 'For a long game you mainly want a shape of. Roughly two thirds the time of Standard, and correspondingly more likely to walk past something.',
  },
  {
    id: 'standard',
    label: 'Standard — 400k nodes per position',
    nodes: 400_000,
    note: 'The default. A whole game in a couple of minutes on this machine, and about two and a half times the search the old pass did per position.',
  },
  {
    id: 'thorough',
    label: 'Thorough — 800k nodes per position',
    nodes: 800_000,
    note: 'The most a browser pass is worth spending: twice Standard for a whole game. Still the budget measured to miss a real Tier B move on the reference game — deeper than this belongs in an off-app pass, not in this tab.',
  },
]

/** The budget matching a node count, when it is one we offer. */
export function budgetForNodes(nodes: number): AnalysisBudget | undefined {
  return ANALYSIS_BUDGETS.find((b) => b.nodes === nodes)
}

/**
 * Whether a pass at this budget is one whose **absences** can be trusted.
 *
 * False for every budget a browser can afford, and that is the point: it is not
 * a knob to get above, it is the flag that keeps the wording honest until a
 * deeper analysis is imported from off-app. When one is, the same stored
 * `analysisNodes` that drives `supersedes` flips this to true and the screens
 * stop hedging — which is the whole reason the check is a function of the budget
 * rather than a sentence hard-coded into a component.
 */
export function trustworthyAbsences(nodes: number): boolean {
  return nodes >= REFERENCE_NODES
}

/**
 * Whether stored work already answers a request for a pass at `wanted`.
 *
 * **This is the seam for an off-app deep pass** (filed separately). An import
 * writes a `DbGameAnalysis` row with `analysedAt` set and `analysisNodes` at the
 * budget it ran at; from that moment this returns true for every in-app budget,
 * the WASM pass is skipped entirely, and everything downstream reports the
 * deeper number. No screen has to learn where the evaluations came from.
 *
 * The rule is deliberately narrow. A *complete* pass at a budget at least as
 * deep is authoritative — nothing further is searched, so nothing can be mixed.
 * A **partial** deeper pass is not: topping it up with cheaper searches would
 * leave one game holding evaluations from two budgets, and differencing those
 * manufactures swings out of nothing. Such a row is reusable only by a pass at
 * exactly its own budget, which is what `useDbGameAnalysis` does with it.
 */
export function supersedes(record: AnalysisRecord, wanted: number): boolean {
  return record.analysedAt != null && (record.analysisNodes ?? 0) >= wanted
}

export interface AnalysisProgress {
  done: number
  total: number
  /** True once every position has an evaluation from a completed pass. */
  complete: boolean
}

/**
 * What an earlier pass recorded: when it finished, and at what budget.
 *
 * Its own type, and taken structurally, because the two fields are kept in two
 * places. A game you played carries them on its own row (`StoredGame`); a game
 * you *imported* keeps them in a table beside the row (`persist/dbGames`'s
 * `DbGameAnalysis`, and `db.ts`'s v7 comment says why). Neither is the pass's
 * business — it only needs to know whether the stored work still counts.
 *
 * Both optional, and absent means "not recorded" rather than an error: v0.2
 * records predate the fields entirely, and a game nobody has analysed simply
 * has nothing to say.
 */
export interface AnalysisRecord {
  /** When a full-game pass last completed. Absent ⇒ never analysed. */
  analysedAt?: number
  /** Nodes per position that pass used, so a later pass can tell if it must redo the work. */
  analysisNodes?: number
}

/**
 * A game this pass can walk: the moves, plus what an earlier pass recorded.
 *
 * `StoredGame` satisfies it, and so does an imported row once its movetext has
 * been split — the same trick `domain/studyGame.DatabaseGame` uses, so one pass
 * serves a game you played and a game you imported without either table
 * learning about the other (#133).
 */
export interface AnalysableGame extends AnalysisRecord {
  sanHistory: readonly string[]
}

/**
 * Plies still needing an evaluation.
 *
 * `evalByPly[p]` is the evaluation *after* move `p`, so a game of n moves needs
 * plies `0..n-1`. Evaluations recorded live are kept only when the whole game was
 * already analysed at the same budget — otherwise the pass redoes them, because
 * mixing node counts would make the resulting scores (and the annotation glyphs
 * derived from them) inconsistent across a single game for no visible reason.
 */
export function pliesNeedingAnalysis(
  game: AnalysableGame,
  nodes = BATCH_NODES,
  /**
   * Positions actually reconstructable from the move list. A record whose SAN
   * cannot be fully replayed has fewer, and asking for the rest means the pass
   * can never reach 100% — so it would never mark itself complete and would redo
   * every position on each attempt, forever.
   */
  replayablePositions = game.sanHistory.length + 1,
): number[] {
  if (isAnalysed(game, nodes)) return []
  const measurable = Math.max(0, Math.min(game.sanHistory.length, replayablePositions - 1))
  return Array.from({ length: measurable }, (_, ply) => ply)
}

/**
 * Whether a completed pass already covers the game to at least this depth.
 *
 * "At least" rather than "exactly" (#144): a game carrying an imported off-app
 * pass at a deeper budget is *more* analysed than the in-app pass would leave
 * it, and asking for the shallower work to be redone over the top of it would
 * throw away better evaluations and replace them with worse. `supersedes` holds
 * the rule and the caveat about partial passes.
 *
 * A pass at a *shallower* budget than asked for is still not analysed, which is
 * what invalidates the old 150k work rather than serving it at a depth the
 * selection in `domain/keyMoments.ts` is no longer willing to rest on.
 */
export function isAnalysed(record: AnalysisRecord, nodes = BATCH_NODES): boolean {
  return supersedes(record, nodes)
}

/** Which colour moved at this ply, for a game starting at move 1 with White. */
function moverAt(ply: number): 'w' | 'b' {
  return ply % 2 === 0 ? 'w' : 'b'
}

/**
 * The plies you moved on. One definition, because every figure about *your*
 * play is a mean over this set and two of them disagreeing about which moves
 * were yours would be invisible until the numbers contradicted each other.
 *
 * Assumes the game starts at move 1 with White — true of every `kind: 'game'`
 * record, and the reason a play-out (#48) is not measured by these figures.
 */
export function yourPlies(game: StoredGame): number[] {
  return game.sanHistory
    .map((_, ply) => ply)
    .filter((ply) => moverAt(ply) === game.yourColor)
}

/**
 * A game's accuracy **and how much of the game it covers**.
 *
 * The coverage is the point. `coachLog` only holds moves the coach finished
 * grading before the game ended, so resigning (or simply moving fast) leaves it
 * holding a subset — usually the early, good moves — and the mean over that
 * subset reads far too high. A game could show "99.18% accuracy" directly above
 * a move flagged as a 16% mistake (#74).
 *
 * So: prefer a completed analysis pass, which covers every move by construction.
 * Fall back to the coach log, and report how many moves the figure actually rests
 * on so the UI can say when it is partial rather than implying it is the whole
 * game.
 */
export interface AccuracyReport {
  accuracy: number
  /** Your moves the figure is computed from. */
  covered: number
  /** Your moves in the game. */
  total: number
  source: 'analysis' | 'coach'
  /** True when the figure rests on every move you played. */
  complete: boolean
}

export function accuracyReport(game: StoredGame): AccuracyReport {
  const plies = yourPlies(game)
  const total = plies.length

  if (isAnalysed(game)) {
    const swings = plies
      .map((ply) => evalSwingAt(game.evalByPly, ply, game.yourColor, game.startEval))
      .filter((s): s is number => s !== undefined)
      // A move that gained ground is not better than perfect; clamp so it can't
      // pull a mediocre game's mean upward.
      .map((s) => Math.max(0, s))
    return {
      accuracy: meanAccuracy(swings),
      covered: swings.length,
      total,
      source: 'analysis',
      complete: swings.length === total,
    }
  }

  const swings = (game.coachLog ?? []).map((e) => e.swing)
  return {
    accuracy: meanAccuracy(swings),
    covered: swings.length,
    total,
    source: 'coach',
    complete: swings.length === total,
  }
}

/** Fold one position's result into the eval array without mutating the original. */
export function withEvalAt(
  evals: (PositionEval | undefined)[] | undefined,
  ply: number,
  evaluation: PositionEval,
): (PositionEval | undefined)[] {
  const next = (evals ?? []).slice()
  next[ply] = evaluation
  return next
}

export function progressOf(done: number, total: number): AnalysisProgress {
  return { done, total, complete: total > 0 && done >= total }
}

/**
 * How the game's evaluation moved across the move at `ply`, in win% — positive
 * means the mover gave up ground. This is what "where did the game turn" reads
 * off, and what per-move accuracy is computed from.
 *
 * Needs the evaluation on *both* sides of the move. For ply 0 that is the start
 * position, which `evalByPly` cannot hold (it is indexed by the move each
 * evaluation follows) — hence `startEval`. Without it the first move of every
 * game is permanently unmeasurable.
 *
 * What this decides is *which two readings* to difference; the arithmetic itself
 * is `domain/winPercent`'s, which `domain/keyMoments` (#132) also rests on. Two
 * modules differencing evaluations under their own sign conventions is a bug
 * that reads as a plausible number.
 */
export function evalSwingAt(
  evals: (PositionEval | undefined)[] | undefined,
  ply: number,
  yourColor: 'w' | 'b',
  startEval?: PositionEval,
): number | undefined {
  const before = ply === 0 ? startEval : evals?.[ply - 1]
  const after = evals?.[ply]
  if (!before || !after) return undefined
  return swingFromWhitePercent(before.whitePct, after.whitePct, yourColor)
}
