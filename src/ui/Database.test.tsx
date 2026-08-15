// The chess.com sync panel (#145).
//
// The hook is faked, because what is worth asserting here is the wiring the hook
// cannot see: that the sync cannot be started without a deliberate choice of
// time control, that a failed sync says what failed instead of showing a
// summary, and that a re-sync's "already there" games are reported as such
// rather than as a fresh import.
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EMPTY_ACCOUNT } from '../app/chesscomAccount'
import type { ChesscomSync } from '../app/useChesscomSync'
import { ChesscomPanel } from './Database'

const EMPTY_PROGRESS = {
  months: 0,
  monthsDone: 0,
  fetched: 0,
  kept: 0,
  skipped: 0,
  skippedByReason: {},
  monthsSkipped: 0,
}

const fake = (over: Partial<ChesscomSync> = {}): ChesscomSync => ({
  state: { status: 'idle', progress: EMPTY_PROGRESS, written: 0, alreadyPresent: 0 },
  account: EMPTY_ACCOUNT,
  sync: vi.fn(),
  cancel: vi.fn(),
  forget: vi.fn(),
  completed: 0,
  ...over,
})

describe('the chess.com sync panel', () => {
  it('will not sync until a handle and a time control are both chosen', () => {
    const chesscom = fake()
    render(<ChesscomPanel chesscom={chesscom} />)

    const button = screen.getByRole('button', { name: 'Sync' })
    expect(button).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'test-player' } })
    // A handle alone is not enough: pooling blitz with rapid and daily is an
    // analysis error, so there is no default set of classes to fall back on.
    expect(button).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Rapid'))
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(chesscom.sync).toHaveBeenCalledWith('test-player', ['rapid'])
  })

  it('comes back filled in with the account it last synced', () => {
    render(
      <ChesscomPanel
        chesscom={fake({ account: { user: 'test-player', classes: ['rapid', 'daily'], months: [] } })}
      />,
    )
    expect(screen.getByLabelText('Username')).toHaveValue('test-player')
    expect(screen.getByLabelText('Rapid')).toBeChecked()
    expect(screen.getByLabelText('Daily')).toBeChecked()
    expect(screen.getByLabelText('Blitz')).not.toBeChecked()
  })

  it('shows a failure instead of a summary, so a 404 cannot read as success', () => {
    render(
      <ChesscomPanel
        chesscom={fake({
          state: {
            status: 'error',
            failure: 'no-such-user',
            error: 'No such user on chess.com — check the spelling of the handle.',
            progress: EMPTY_PROGRESS,
            written: 0,
            alreadyPresent: 0,
          },
        })}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('No such user')
    expect(screen.queryByText(/Imported/)).not.toBeInTheDocument()
  })

  it('reports what was already stored separately from what was imported', () => {
    render(
      <ChesscomPanel
        chesscom={fake({
          state: {
            status: 'done',
            progress: {
              ...EMPTY_PROGRESS,
              months: 1,
              monthsDone: 1,
              monthsSkipped: 3,
              fetched: 30,
              kept: 12,
              skipped: 18,
              skippedByReason: { 'time-class': 18 },
            },
            written: 12,
            alreadyPresent: 10,
          },
        })}
      />,
    )
    // Two of thirty were new. Folding the other ten into the total would make an
    // idempotent re-sync look like it grew the database.
    expect(screen.getByText(/Imported/)).toHaveTextContent('Imported 2 new games from 30 fetched')
    expect(screen.getByText(/already in your database/)).toBeInTheDocument()
    expect(screen.getByText(/Skipped 18/)).toHaveTextContent('in a time control you did not pick')
    expect(screen.getByText(/3 months were already complete/)).toBeInTheDocument()
  })
})
