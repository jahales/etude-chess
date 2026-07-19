import type { AnalysisLine } from '../engine/analyser'
import type { Material } from '../domain/material'
import { pvToSan, whiteScoreLabel } from '../domain/notation'
import { sideToMoveOf } from '../domain/replay'

/**
 * Lichess-style vertical eval bar. White's fill grows from White's side of the
 * board, so it follows the board orientation (flip / Black-hero) — review #2.
 */
export function EvalBar({
  whitePct,
  whiteBottom = true,
}: {
  whitePct: number | null
  whiteBottom?: boolean
}) {
  const pct = whitePct == null ? 50 : Math.max(0, Math.min(100, whitePct))
  return (
    <div
      className="evalbar"
      role="img"
      aria-label={whitePct == null ? 'evaluation pending' : `White ${Math.round(pct)} percent`}
    >
      <div
        className="evalbar-white"
        style={{ height: `${pct}%`, top: whiteBottom ? 'auto' : 0, bottom: whiteBottom ? 0 : 'auto' }}
      />
    </div>
  )
}

const GLYPH: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' }

/** Captured pieces + net material advantage, at a glance. */
export function MaterialStrip({ material }: { material: Material }) {
  const leader = material.diff > 0 ? 'White' : material.diff < 0 ? 'Black' : null
  return (
    <div className="material">
      <span className="cap dark">{material.capturedByWhite.map((t) => GLYPH[t] ?? '').join('')}</span>
      <span className="cap light">{material.capturedByBlack.map((t) => GLYPH[t] ?? '').join('')}</span>
      <span className="mat-diff mono">
        {leader ? `${leader} +${Math.abs(material.diff)}` : 'Even material'}
      </span>
    </div>
  )
}

/**
 * The engine's top lines — each with its score and the concrete sequence.
 *
 * Scores are shown from **White's** perspective, like every other score in the
 * UI (architecture.md: "bar, chip, move list, lines"). UCI reports them relative
 * to the side to move, so with Black to move the raw number has the opposite
 * sign to the eval bar and the score chip sitting next to it.
 */
export function LinesPanel({ fen, lines }: { fen: string; lines: AnalysisLine[] }) {
  if (lines.length === 0) return null
  const sideToMove = sideToMoveOf(fen)
  return (
    <div className="lines">
      <div className="lines-head">Engine lines</div>
      {lines.map((ln, i) => (
        <div key={ln.multipv} className={`line ${i === 0 ? 'best' : ''}`}>
          <span className="line-score mono">{whiteScoreLabel(ln.score, sideToMove)}</span>
          <span className="line-pv mono">{pvToSan(fen, ln.pv, 6).join(' ')}</span>
        </div>
      ))}
    </div>
  )
}
