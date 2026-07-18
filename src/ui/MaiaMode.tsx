import { useMemo, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import { materialBalance } from '../domain/material'
import type { Color } from '../domain/types'
import { SHIPPED_LEVELS, type MaiaLevel } from '../engine/maia/opponent'
import { currentFen, sideToMove, type PlayResult } from '../app/playMachine'
import type { usePlaySession } from '../app/usePlaySession'
import { useBoardWidth } from './useBoardWidth'
import { MaterialStrip } from './Analysis'
import { sideName } from './format'

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
      <h2>Play a human-like opponent</h2>
      <p className="maia-setup-lede">
        Maia plays like a real player at its rating — it makes the mistakes you&apos;ll actually
        face. Play a full game; review comes next.
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

function describeResult(result: PlayResult, yourColor: Color): string {
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
  if (result.reason === 'resignation') return `You resigned — Maia ${sideName(yourColor === 'w' ? 'b' : 'w')} wins`
  return `Maia won ${tail}`.trim()
}

/** Pair SAN moves into numbered rows for the move list. */
function pairMoves(san: string[]): { n: number; w?: string; b?: string }[] {
  const rows: { n: number; w?: string; b?: string }[] = []
  for (let i = 0; i < san.length; i += 2) {
    rows.push({ n: i / 2 + 1, w: san[i], b: san[i + 1] })
  }
  return rows
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
  const fen = currentFen(state)
  const yourColor = state.yourColor
  const whiteBottom = yourColor === 'w' ? !flipped : flipped
  const yourTurn = state.status === 'yourTurn'

  const squareStyles = state.selected
    ? { [state.selected]: { background: 'rgba(53, 96, 73, 0.35)' } }
    : undefined

  const rows = useMemo(() => pairMoves(state.sanHistory), [state.sanHistory])

  return (
    <section className="play">
      <div className="board-col">
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

        <div className={`maia-status ${state.status}`} role="status">
          {maiaError ? (
            <span className="banner error">Maia failed to load: {maiaError}</span>
          ) : state.status === 'over' && state.result ? (
            <span className="maia-result">{describeResult(state.result, yourColor)}</span>
          ) : !maiaReady ? (
            <span>Loading Maia {state.level}…</span>
          ) : state.status === 'thinking' ? (
            <span className="thinking">Maia is thinking…</span>
          ) : (
            <span className="your-turn">Your move.</span>
          )}
        </div>

        <ol className="movelist" aria-label="Moves">
          {rows.map((r) => (
            <li key={r.n}>
              <span className="mv-no mono">{r.n}.</span>
              <span className="mono">{r.w}</span>
              <span className="mono">{r.b ?? ''}</span>
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
            <button className="btn ghost" type="button" onClick={play.resign} disabled={!maiaReady}>
              Resign
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
