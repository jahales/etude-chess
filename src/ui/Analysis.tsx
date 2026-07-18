import type { AnalysisLine } from '../engine/analyser'
import type { Material } from '../domain/material'
import { pvToSan, formatScore } from '../domain/notation'

/** Lichess-style vertical eval bar; White fills from the bottom. */
export function EvalBar({ whitePct }: { whitePct: number | null }) {
  const pct = whitePct == null ? 50 : Math.max(0, Math.min(100, whitePct))
  return (
    <div
      className="evalbar"
      role="img"
      aria-label={whitePct == null ? 'evaluation pending' : `White ${Math.round(pct)} percent`}
    >
      <div className="evalbar-white" style={{ height: `${pct}%` }} />
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

/** The engine's top lines — each with its score and the concrete sequence. */
export function LinesPanel({ fen, lines }: { fen: string; lines: AnalysisLine[] }) {
  if (lines.length === 0) return null
  return (
    <div className="lines">
      <div className="lines-head">Engine lines</div>
      {lines.map((ln, i) => (
        <div key={ln.multipv} className={`line ${i === 0 ? 'best' : ''}`}>
          <span className="line-score mono">{formatScore(ln.score)}</span>
          <span className="line-pv mono">{pvToSan(fen, ln.pv, 6).join(' ')}</span>
        </div>
      ))}
    </div>
  )
}
