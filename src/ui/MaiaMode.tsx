import { useMemo, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import { materialBalance } from '../domain/material'
import type { Color, Tier } from '../domain/types'
import type { CoachVerdict } from '../domain/coach'
import { SHIPPED_LEVELS, type MaiaLevel } from '../engine/maia/opponent'
import { displayFen, sideToMove, type PendingPlayMove, type PlayResult } from '../app/playMachine'
import type { usePlaySession } from '../app/usePlaySession'
import { useBoardWidth } from './useBoardWidth'
import { EvalBar, MaterialStrip } from './Analysis'
import { sideName, TIER_CLASS, TIER_TEXT } from './format'

const LEVEL_BLURB: Record<number, string> = {
  1100: 'beginner',
  1300: 'improver',
  1500: 'club player',
}

type PlaySession = ReturnType<typeof usePlaySession>

// ---------- Home setup panel ----------

export function MaiaSetup({
  onPlay,
  defaultLevel,
}: {
  onPlay: (opts: { yourColor: Color; level: MaiaLevel }) => void
  defaultLevel: MaiaLevel
}) {
  const [color, setColor] = useState<'w' | 'b' | 'random'>('w')
  const [level, setLevel] = useState<MaiaLevel>(defaultLevel)

  const start = () => {
    const yourColor: Color = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color
    onPlay({ yourColor, level })
  }

  return (
    <div className="maia-setup">
      <h2>Play a human-like opponent — with a coach on every move</h2>
      <p className="maia-setup-lede">
        Maia plays like a real player at its rating. After each of your moves the coach grades
        it and shows why — take it back and rethink, or play on. It makes the mistakes you&apos;ll
        actually face.
      </p>
      <div className="maia-controls">
        <fieldset className="maia-field">
          <legend>You play</legend>
          <div className="seg">
            {(['w', 'b', 'random'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={`seg-btn ${color === c ? 'active' : ''}`}
                onClick={() => setColor(c)}
              >
                {c === 'w' ? 'White' : c === 'b' ? 'Black' : 'Random'}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="maia-field">
          <legend>Maia level</legend>
          <div className="seg">
            {SHIPPED_LEVELS.map((l) => (
              <button
                key={l}
                type="button"
                className={`seg-btn ${level === l ? 'active' : ''}`}
                onClick={() => setLevel(l)}
                title={LEVEL_BLURB[l]}
              >
                {l}
              </button>
            ))}
          </div>
          <span className="maia-level-blurb">{LEVEL_BLURB[level] ?? 'human-like'}</span>
        </fieldset>
      </div>
      <button className="btn primary" type="button" onClick={start}>
        Play vs Maia {level}
      </button>
    </div>
  )
}

// ---------- Game screen ----------

function describeResult(result: PlayResult): string {
  const REASON: Record<string, string> = {
    checkmate: 'by checkmate',
    stalemate: 'by stalemate',
    insufficient: 'by insufficient material',
    threefold: 'by repetition',
    'fifty-move': 'by the fifty-move rule',
    resignation: 'by resignation',
  }
  const tail = REASON[result.reason] ?? ''
  if (result.outcome === 'draw') return `Draw ${tail}`.trim()
  if (result.outcome === 'you') return `You won ${tail}`.trim()
  if (result.reason === 'resignation') return `You resigned — Maia wins`
  return `Maia won ${tail}`.trim()
}

/** The coach's verdict on your staged move, with take-back / continue. */
function CoachCard({
  verdict,
  pending,
  onTakeBack,
  onContinue,
}: {
  verdict: CoachVerdict | null
  pending: PendingPlayMove
  onTakeBack: () => void
  onContinue: () => void
}) {
  return (
    <div className="coach-card">
      {verdict ? (
        <>
          <div className={`coach-verdict ${TIER_CLASS[verdict.tier]}`}>
            <span className="tier-badge">{verdict.headline}</span>
            <span className="mono">
              you played {pending.san}
              {verdict.tier !== 'A' && <> · −{Math.round(verdict.swing)}%</>}
            </span>
          </div>
          {verdict.detail && <p className="coach-why">{verdict.detail}</p>}
        </>
      ) : (
        <p className="coach-why">Couldn&apos;t grade this move — playing on.</p>
      )}
      <div className="coach-actions">
        <button className="btn ghost" type="button" onClick={onTakeBack}>
          ← Take back
        </button>
        <button className="btn primary" type="button" onClick={onContinue}>
          Continue →
        </button>
      </div>
    </div>
  )
}

interface MoveRow {
  n: number
  w?: { san: string; tier?: Tier }
  b?: { san: string; tier?: Tier }
}

/** Pair SAN moves into numbered rows, tagging your moves with their coached tier. */
function buildRows(san: string[], tierByPly: (Tier | undefined)[]): MoveRow[] {
  const rows: MoveRow[] = []
  for (let i = 0; i < san.length; i += 2) {
    rows.push({
      n: i / 2 + 1,
      w: san[i] !== undefined ? { san: san[i]!, tier: tierByPly[i] } : undefined,
      b: san[i + 1] !== undefined ? { san: san[i + 1]!, tier: tierByPly[i + 1] } : undefined,
    })
  }
  return rows
}

function MoveCell({ move }: { move?: { san: string; tier?: Tier } }) {
  if (!move) return <span />
  return (
    <span className="mono mv-cell">
      {move.tier && <span className={`tier-dot ${TIER_CLASS[move.tier]}`} title={TIER_TEXT[move.tier]} />}
      {move.san}
    </span>
  )
}

export function MaiaPlay({
  play,
  onNewGame,
  onHome,
}: {
  play: PlaySession
  onNewGame: () => void
  onHome: () => void
}) {
  const { ref, width } = useBoardWidth()
  const [flipped, setFlipped] = useState(false)
  const { state, maiaReady, maiaError } = play
  const fen = displayFen(state)
  const yourColor = state.yourColor
  const whiteBottom = yourColor === 'w' ? !flipped : flipped
  const yourTurn = state.status === 'yourTurn'

  const squareStyles =
    state.selected && yourTurn
      ? { [state.selected]: { background: 'rgba(53, 96, 73, 0.35)' } }
      : undefined

  // Map each committed ply to the coached tier of your moves (Maia's stay blank).
  const tierByPly = useMemo(() => {
    const arr: (Tier | undefined)[] = new Array(state.sanHistory.length).fill(undefined)
    let k = 0
    for (let i = 0; i < arr.length; i++) {
      const moverIsYou = (i % 2 === 0) === (yourColor === 'w')
      if (moverIsYou) {
        arr[i] = state.coachLog[k]?.tier
        k += 1
      }
    }
    return arr
  }, [state.sanHistory, state.coachLog, yourColor])

  const rows = useMemo(() => buildRows(state.sanHistory, tierByPly), [state.sanHistory, tierByPly])

  return (
    <section className="play">
      <div className="board-col">
        <div className="board-row">
          <EvalBar whitePct={state.evalWhitePct} whiteBottom={whiteBottom} />
          <div className="board-frame" ref={ref}>
            <Chessboard
              id="maia-board"
              position={fen}
              boardWidth={width}
              boardOrientation={whiteBottom ? 'white' : 'black'}
              arePiecesDraggable={yourTurn && maiaReady}
              onPieceDrop={(from, to) => play.tryMove(from, to)}
              onSquareClick={play.selectSquare}
              customSquareStyles={squareStyles}
              customBoardStyle={{ borderRadius: '6px' }}
            />
          </div>
        </div>
        <MaterialStrip material={materialBalance(fen)} />
        <div className="turn-line">
          <span className="mono">{sideName(sideToMove(state))} to move</span>
          <button
            className="btn ghost flip"
            type="button"
            onClick={() => setFlipped((f) => !f)}
            aria-label="Flip board"
            title="Flip board"
          >
            ⇅ Flip
          </button>
        </div>
      </div>

      <div className="side-col">
        <div className="game-head">
          <h2>Maia {state.level}</h2>
          <p className="playing-as">
            You are <b>{sideName(yourColor)}</b>.
          </p>
        </div>

        {maiaError ? (
          <div className="maia-status">
            <span className="banner error">Maia failed to load: {maiaError}</span>
          </div>
        ) : state.status === 'over' && state.result ? (
          <div className="maia-status over" role="status">
            <span className="maia-result">{describeResult(state.result)}</span>
          </div>
        ) : !maiaReady ? (
          <div className="maia-status" role="status">
            Loading Maia {state.level}…
          </div>
        ) : state.status === 'coached' && state.pending ? (
          <CoachCard
            verdict={state.verdict}
            pending={state.pending}
            onTakeBack={play.takeBack}
            onContinue={play.continueMove}
          />
        ) : (
          <div className="maia-status" role="status">
            {state.status === 'grading' ? (
              <span className="thinking">Coach is checking your move…</span>
            ) : state.status === 'thinking' ? (
              <span className="thinking">Maia is thinking…</span>
            ) : (
              <span className="your-turn">Your move.</span>
            )}
          </div>
        )}

        <ol className="movelist" aria-label="Moves">
          {rows.map((r) => (
            <li key={r.n}>
              <span className="mv-no mono">{r.n}.</span>
              <MoveCell move={r.w} />
              <MoveCell move={r.b} />
            </li>
          ))}
        </ol>

        <div className="maia-actions">
          {state.status === 'over' ? (
            <>
              <button className="btn ghost" type="button" onClick={onHome}>
                Home
              </button>
              <button className="btn primary" type="button" onClick={onNewGame}>
                New game
              </button>
            </>
          ) : (
            state.status !== 'coached' && (
              <button className="btn ghost" type="button" onClick={play.resign} disabled={!maiaReady}>
                Resign
              </button>
            )
          )}
        </div>
      </div>
    </section>
  )
}
