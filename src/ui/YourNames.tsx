import { useState } from 'react'
import { formatPlayerNames, parsePlayerNames, savePlayerNames } from '../app/settings'

/**
 * Who you are, so a game of yours can be recognised as one (#130).
 *
 * Folded away because it is answered once and then never again. It lived on the
 * study control until #144, which needs the same answer on the review picker —
 * to put your losses first — so it moved here rather than being written twice
 * and drifting.
 *
 * A list and not a field: a site writes your handle into the `White` tag, a PGN
 * you exported by hand writes `Lastname, Firstname`, and both are you. One per
 * line, because that comma is part of a name. Nothing is guessed for you — the
 * list starts empty and stays on this machine.
 */
export function YourNames({
  names,
  onChange,
  claimed,
  summary,
  id = 'your-names',
}: {
  names: string[]
  onChange: (names: string[]) => void
  /** Whether the game in front of you was matched to one of these names. */
  claimed?: boolean
  /** Overrides the fold's label where "this game" is not what the screen is about. */
  summary?: string
  /** Distinct per instance: two of these on one screen would share a label target. */
  id?: string
}) {
  const [draft, setDraft] = useState(() => formatPlayerNames(names))
  const save = () => {
    const parsed = parsePlayerNames(draft)
    savePlayerNames(parsed)
    onChange(parsed)
    setDraft(formatPlayerNames(parsed))
  }
  return (
    <details className="study-you">
      <summary>
        {summary ?? (claimed ? 'This is one of your games' : 'Is this one of your games?')}
      </summary>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label htmlFor={id}>The names you play under — one per line</label>
        <textarea
          id={id}
          rows={2}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
        />
        <button className="btn ghost" type="submit">
          Save
        </button>
        <span className="study-note">
          Matched against the game&apos;s White and Black tags, ignoring case. Kept in this browser
          and nowhere else.
        </span>
      </form>
    </details>
  )
}
