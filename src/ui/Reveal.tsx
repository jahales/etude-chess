/**
 * The guess-mode reveal: the verdict, the why, and the arrow key.
 *
 * Its own module since #55, because that is where the honesty problem lives. An
 * imported game can carry annotations written by whoever made the file, and they
 * are shown **alongside** our engine-computed "why", never blended into it — two
 * blocks, each named, so a reader can always tell whose sentence they are
 * reading (constitution §9, §12). A game with no note renders exactly what it
 * rendered before: both captions are part of the note, so nothing appears for a
 * game that has nothing to attribute.
 *
 * The same rule reaches the *moves* since #158: this screen shows two of them
 * and used to call the game's one "master" whatever the game was. The words now
 * come from the game's own `MoveSource` (`domain/moveSource.ts`), which is why
 * there is no provenance test anywhere in this file — deciding it here is the
 * bug, not the fix.
 */

import { useState } from 'react'
import { explain, factBundleToText, type FactBundle } from '../domain/factBundle'
import { moveWording } from '../domain/moveSource'
import type { QuizItem } from '../domain/harness'
import type { ResultShift } from '../app/sessionMachine'
import {
  changedResultCategory,
  resultCategory,
  type NextImportant,
  type ResultCategory,
} from '../domain/resultCategory'
import { TIER_TEXT, TIER_CLASS } from './format'

/** A note from the source file, and the file it came from. Never one without the other. */
export interface SourceNote {
  text: string
  source: string
}

export function Reveal({
  fb,
  item,
  note,
  resultShift,
  skip,
  onNext,
  onSkip,
  last,
}: {
  fb: FactBundle
  item: QuizItem
  /** The source file's note on this move, when it wrote one (#55). */
  note?: SourceNote | null
  /** Win/draw/loss either side of your move, when the engine reported it (#161). */
  resultShift?: ResultShift
  /**
   * Where skipping ahead would land, and what could not be looked at (#161).
   * Absent means the control has no business here — a critical-positions
   * session, or a game with no pass behind it.
   */
  skip?: NextImportant | null
  onNext: () => void
  onSkip?: () => void
  last: boolean
}) {
  // What this game's own moves may be called (#158) — decided when the game was
  // built and carried on the fact bundle, so this screen never has to guess
  // whether it is showing a master, a stranger, or the reader's own blitz game.
  const wording = moveWording(fb.moveSource)
  const [copied, setCopied] = useState(false)
  const copyFacts = async () => {
    try {
      await navigator.clipboard.writeText(factBundleToText(fb))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="reveal">
      <div className={`verdict ${TIER_CLASS[fb.grade.tier]}`}>
        <span className="tier-badge">{TIER_TEXT[fb.grade.tier]}</span>
        <span className="your-move mono">
          {wording.yourVerb} {fb.userMoveSan} · {wording.tag} {item.masterMoveSan}
        </span>
      </div>
      <p className="why">{explain(fb)}</p>
      {resultShift && <ResultShiftLine shift={resultShift} />}
      {note && <SourceAnnotation note={note} />}
      {/* The swatch classes are colours and stay put: #158 changed the words on
          the legend, never which arrow is which. */}
      <ul className="arrow-key">
        <li>
          <span className="swatch master" /> {wording.legend}
        </li>
        {fb.bestMoveSan && fb.bestMoveSan !== item.masterMoveSan && (
          <li>
            <span className="swatch engine" /> engine’s pick ({fb.bestMoveSan})
          </li>
        )}
        {!fb.matchedGameMove && (
          <li>
            <span className="swatch user" /> {wording.yourLegend}
          </li>
        )}
      </ul>
      <div className="reveal-actions">
        <button className="btn ghost" type="button" onClick={copyFacts}>
          {copied ? 'Copied ✓' : 'Copy facts for an LLM'}
        </button>
        <button className="btn primary" type="button" onClick={onNext}>
          {last ? 'See summary' : 'Next position →'}
        </button>
      </div>
      {skip && onSkip && <SkipAhead skip={skip} onSkip={onSkip} />}
    </div>
  )
}

/**
 * "Skip to the next move that changed the result" (#161), and the three
 * different reasons it might not be offered.
 *
 * The button is the easy half. The hard half is what to say when there is
 * nowhere to jump to, because #132 established the distinction this has to
 * preserve: **"no later move changed the result" is a claim, and "we could not
 * measure the rest" is not the same sentence.** A game whose pass was
 * interrupted, or whose stored evaluations predate WDL being recorded at all,
 * has no answer to give — and quietly reporting "nothing more to skip to" would
 * tell the reader they played a clean second half of a game nobody looked at.
 * So the copy is driven off `measured`/`unmeasured`, never off the empty target
 * alone.
 *
 * The wording never grades. It says which *positions* are ahead, not how bad
 * any move was — the tier is the badge above, on the one scale this app has
 * (ADR 0010, constitution §9).
 */
function SkipAhead({ skip, onSkip }: { skip: NextImportant; onSkip: () => void }) {
  const { target, measured, unmeasured } = skip
  // Nothing ahead at all — this is the last question, and `Next` already says
  // "See summary". A note about skipping would be noise.
  if (measured === 0 && unmeasured === 0) return null

  if (target) {
    return (
      <div className="skip-ahead">
        <button className="btn ghost skip" type="button" onClick={onSkip}>
          Skip to the next move that changed the result →
        </button>
        {unmeasured > 0 && (
          <p className="skip-note">
            {unmeasured} of the {measured + unmeasured} positions ahead have no win/draw/loss
            recorded, so this jumps to the next one we could measure — not necessarily the next
            one there is.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="skip-ahead">
      <p className="skip-note">
        {measured === 0 ? (
          <>
            No win/draw/loss recorded for the {unmeasured} positions ahead, so there is nothing to
            skip by. Re-run the analysis pass to record it.
          </>
        ) : unmeasured === 0 ? (
          <>No later move in this game changed the result.</>
        ) : (
          <>
            No later move changed the result, of the {measured} positions ahead we could measure.
            The other {unmeasured} have no win/draw/loss recorded.
          </>
        )}
      </p>
    </div>
  )
}

/** What each result category is called on screen. White's perspective throughout. */
const CATEGORY_TEXT: Record<ResultCategory, string> = {
  'white-wins': 'White wins',
  draw: 'a draw',
  'black-wins': 'Black wins',
  unclear: 'anyone’s game',
}

/** Permille as the whole percent the rest of the app talks in. */
function pct(permille: number): number {
  return Math.round(permille / 10)
}

/**
 * The win/draw/loss picture either side of your move (#161).
 *
 * Here, next to the verdict, because it is the thing that says how much the
 * verdict *meant*: the tier is win% swing, and the `game-review` skill §4 is
 * explicit that a swing in a decided position is not a swing in a close one. A
 * −12% move that leaves `1000/0/0` untouched cost win% and never risked the
 * result; the reveal used to have no way to tell you that, and would let a
 * "Mistake" badge imply the game hung on a move that was already over.
 *
 * It reads as one sentence and then the numbers, rather than numbers alone,
 * because three permille figures are not self-explaining and the whole reason
 * this is here is that a reader mis-weights the swing without them.
 */
function ResultShiftLine({ shift }: { shift: ResultShift }) {
  const { before, after } = shift
  const changed = changedResultCategory(before, after)
  const beforeText = CATEGORY_TEXT[resultCategory(before)]
  const afterText = CATEGORY_TEXT[resultCategory(after)]
  return (
    <div className={`result-shift ${changed ? 'changed' : 'held'}`}>
      <p className="result-verdict">
        {changed ? (
          <>
            <b>Your move changed the likely result</b> — from {beforeText} to {afterText}.
          </>
        ) : (
          <>
            <b>The likely result did not change</b> — {beforeText} either side of your move.
          </>
        )}
      </p>
      {/* Labelled as the engine's expectancy, not a forecast of your game: it
          is what Stockfish reports at this position and this node budget, and
          it says nothing about how a human would hold it (constitution §12). */}
      <p className="result-numbers mono">
        <span className="wdl-label">win/draw/loss for White</span>
        <span className="wdl-before">
          {pct(before.win)}/{pct(before.draw)}/{pct(before.loss)}
        </span>
        <span className="wdl-arrow" aria-hidden="true">
          →
        </span>
        <span className="wdl-after">
          {pct(after.win)}/{pct(after.draw)}/{pct(after.loss)}
        </span>
      </p>
      <p className="result-caveat">
        The engine’s expectancy for this position at this budget — not a prediction about your
        game.
      </p>
    </div>
  )
}

/**
 * Someone else's note on this move, and the line that says the paragraph above
 * it was ours.
 *
 * Both captions live here rather than one of them living on the "why", so that
 * a game with no annotation renders the reveal it has always rendered — and so
 * that it is impossible to ship the quote without the attribution, since
 * deleting one deletes the other.
 */
function SourceAnnotation({ note }: { note: SourceNote }) {
  return (
    <div className="source-note">
      {/* Outside the quote's rule, because it is about the paragraph above it. */}
      <p className="whose ours">Above: étude&apos;s reading, computed from the engine.</p>
      <figure className="source-quote">
        <blockquote>{note.text}</blockquote>
        <figcaption className="whose theirs">
          From <b>{note.source}</b> — the file&apos;s own note on this move, shown as written. Not
          ours, and not checked against anything.
        </figcaption>
      </figure>
    </div>
  )
}
