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
  onNext,
  last,
}: {
  fb: FactBundle
  item: QuizItem
  /** The source file's note on this move, when it wrote one (#55). */
  note?: SourceNote | null
  onNext: () => void
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
