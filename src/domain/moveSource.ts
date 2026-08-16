/**
 * What to call the move the game itself contained (#158).
 *
 * At every reveal the guess session holds two moves: the one you just committed,
 * and the one played in the game you are studying. Calling the second one "the
 * master's" was true of the v0.1.0 pack and false of everything the database
 * made reachable. Reviewing his own ~1100 blitz game, the owner was told
 * "you played Qa5+ · **master** e4" and "Solid — as strong as the master's
 * choice" about a move *he* had played. That is the overstatement this project
 * exists not to make (constitution §9, §12), and it reached the LLM clipboard
 * too, where nobody proofreads it before it is pasted.
 *
 * So the name is **data**, decided where the game is built — `content/games.ts`
 * writes it as a literal, `studyGame.planStudy` derives it from the row and the
 * side being studied — and carried on the `StudyGame`. Nothing downstream
 * re-derives provenance; the fact bundle and the UI read their words from here.
 *
 * The wording is **one record with every phrase in it**, not a phrase computed
 * per site, because the phrases have to agree with each other. In your own game
 * *both* moves are yours, so the arrow legend's "your move" and the header's
 * "the move you played" are only distinguishable if they are written side by
 * side — which is what this table is.
 *
 * None of this touches what the reveal *grades*: `engine/grading.ts` compares
 * your move with Stockfish's and never with the move played in the game. The
 * game's move is context. Where these strings could imply otherwise, they say
 * "the engine" instead — that was the second half of #158, and it is a claim
 * about the mechanism rather than about the person.
 *
 * Deliberately **import-free** — plain strings, no chess.js — so `factBundle.ts`
 * can take it as a runtime import (with the explicit `.ts` extension, see the
 * note in `grade.ts`) without adding anything to what the Node scripts load.
 */

/** Who played the moves of the game being studied, on the side being studied. */
export type MoveSource =
  /** The curated pack (`content/games.ts`) — the only place "master" is true. */
  | { kind: 'master' }
  /** A game you played, studied from your own side (#130's `yourSide`). */
  | { kind: 'you' }
  /** Someone else's game, and the file named the player on this side. */
  | { kind: 'player'; name: string }
  /** Someone else's game, and the file never said who played it. */
  | { kind: 'unnamed' }

/**
 * Every phrase the reveal needs for one source, in one place.
 *
 * Two of these — `yourVerb` and `yourLegend` — are about *your* move rather than
 * the game's, and they are here for the case that made #158 a bug: when the game
 * is yours, "you played" is ambiguous between the move you just chose and the
 * move you chose a fortnight ago, and only naming both differently fixes it.
 */
export interface MoveWording {
  /** Reveal header, left half: what you just did. "you played" / "you chose". */
  yourVerb: string
  /** Reveal header, right half, before the SAN: "master" / "in the game you played". */
  tag: string
  /** Arrow legend for the game's move: "master's move" / "the move you played in the game". */
  legend: string
  /** Arrow legend for the move you just committed. Must not read as `legend`. */
  yourLegend: string
  /** Subject + verb for the "why": `${sentence} Nf3.` → "The master played Nf3." */
  sentence: string
  /** The whole Tier-A sentence for a move that *was* the game's move. */
  matched: string
  /**
   * The clipboard's field name for the game's move.
   *
   * First person, unlike `legend`, because the clipboard bundle is written from
   * the learner's side ("My move: …") for an LLM to read.
   */
  field: string
}

/** The Tier-A verdict when your move was not the game's: about the engine, which is what graded it. */
export const AS_STRONG_AS_ENGINE = 'Solid — the engine rates it as strong as its own top choice.'

export function moveWording(source: MoveSource): MoveWording {
  switch (source.kind) {
    case 'master':
      return {
        yourVerb: 'you played',
        tag: 'master',
        legend: 'master’s move',
        yourLegend: 'your move',
        sentence: 'The master played',
        matched: 'That’s the move — you matched the master.',
        field: "Master's move",
      }
    case 'you':
      return {
        // "you played" for both moves is exactly the confusion #158 is about.
        yourVerb: 'you chose',
        tag: 'in the game you played',
        legend: 'the move you played in the game',
        yourLegend: 'the move you just chose',
        sentence: 'In the game you played',
        // Worth saying plainly: agreeing with your past self is not a verdict,
        // so the sentence carries the engine's, which is the one that graded it.
        matched: 'You’d play it again — and the engine rates it as strong as its own top choice.',
        field: 'The move I played in the game',
      }
    case 'player':
      return {
        yourVerb: 'you played',
        tag: `${source.name} played`,
        legend: `${source.name}’s move`,
        yourLegend: 'your move',
        sentence: `${source.name} played`,
        matched: `That’s the move — you matched what ${source.name} played.`,
        field: `${source.name}'s move`,
      }
    case 'unnamed':
      return {
        yourVerb: 'you played',
        tag: 'in the game',
        legend: 'the move played in the game',
        yourLegend: 'your move',
        sentence: 'The game continued',
        matched: 'That’s the move — you matched what was played in the game.',
        field: 'The move played in the game',
      }
  }
}
