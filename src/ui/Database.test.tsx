// The chess.com sync panel (#145).
//
// The hook is faked, because what is worth asserting here is the wiring the hook
// cannot see: that the sync cannot be started without a deliberate choice of
// time control, that a failed sync says what failed instead of showing a
// summary, and that a re-sync's "already there" games are reported as such
// rather than as a fresh import.
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { EMPTY_ACCOUNT } from '../app/chesscomAccount'
import type { ChesscomSync } from '../app/useChesscomSync'
import { emptyReport, type ArchiveSection } from '../domain/historyArchive'
import type { HistoryTransfer } from '../app/useHistoryTransfer'
import { ChesscomPanel, HistoryTransferPanel } from './Database'

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

// ---------- moving your history between browsers (#152) ----------
//
// The hook is faked here too. What matters on this panel is not the merge (that
// is proven against a real IndexedDB in persist/historyArchive.roundtrip.test.ts)
// but the three things the *screen* is responsible for: saying what an export
// will cost before it is written, saying what an import did, and saying plainly
// that it took nothing away.

const size = (rows: number, bytes: number) => ({ rows, bytes, exact: false })

const transfer = (over: Partial<HistoryTransfer> = {}): HistoryTransfer => ({
  estimate: {
    sections: {
      attempt: size(412, 90_000),
      game: size(12, 40_000),
      dbSource: size(1, 200),
      dbGame: size(41_238, 38_000_000),
      dbAnalysis: size(40, 300_000),
    },
    historyBytes: 430_200,
    databaseBytes: 38_000_000,
  },
  exportState: { status: 'idle' },
  prepare: vi.fn(),
  discard: vi.fn(),
  importState: { status: 'idle', bytesRead: 0 },
  importFile: vi.fn(),
  completed: 0,
  ...over,
})

const reportWith = (counts: Partial<Record<ArchiveSection, Partial<{ added: number; updated: number; unchanged: number; skipped: number }>>>) => {
  const report = emptyReport()
  for (const [section, values] of Object.entries(counts)) {
    Object.assign(report.sections[section as ArchiveSection], values)
  }
  return report
}

describe('moving your history between browsers', () => {
  it('states the size before anything is written, and the database on its own', () => {
    // 200 kB or 2 GB is entirely a question of what is attached, and the user
    // should know which one they are about to save.
    render(<HistoryTransferPanel transfer={transfer()} />)

    expect(screen.getByText(/The file will be about/)).toHaveTextContent('37 MB')
    expect(
      screen.getByLabelText(/Include the 41,238 games in the attached database/),
    ).toBeChecked()
  })

  it('drops the database out of the total when it is not included', () => {
    render(<HistoryTransferPanel transfer={transfer()} />)

    fireEvent.click(screen.getByLabelText(/Include the 41,238 games/))

    // What is left is the part that cannot be re-fetched.
    expect(screen.getByText(/The file will be about/)).toHaveTextContent('420 KB')
  })

  it('asks for the export with the choice that was actually made', () => {
    const t = transfer()
    render(<HistoryTransferPanel transfer={t} />)

    fireEvent.click(screen.getByLabelText(/Include the 41,238 games/))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare an export' }))

    expect(t.prepare).toHaveBeenCalledWith({ includeDatabase: false })
  })

  it('puts the exact size on the control that writes the file', () => {
    render(
      <HistoryTransferPanel
        transfer={transfer({
          exportState: {
            status: 'ready',
            file: { url: 'blob:x', name: 'etude-history-2026-08-15.jsonl', bytes: 1_932_735_283 },
          },
        })}
      />,
    )

    const save = screen.getByRole('link', { name: /Save etude-history-2026-08-15.jsonl/ })
    expect(save).toHaveTextContent('1.8 GB')
    expect(save).toHaveAttribute('download', 'etude-history-2026-08-15.jsonl')
  })

  it('says nothing has been imported when a file is refused, and shows no report', () => {
    render(
      <HistoryTransferPanel
        transfer={transfer({
          importState: {
            status: 'error',
            bytesRead: 0,
            fileName: 'broken.jsonl',
            error: 'This history file ends part-way through — it has no end marker. Nothing has been imported.',
          },
        })}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Nothing has been imported')
    expect(screen.queryByText(/Already here/)).not.toBeInTheDocument()
  })

  it('says what it added and that it removed nothing', () => {
    render(
      <HistoryTransferPanel
        transfer={transfer({
          importState: {
            status: 'done',
            bytesRead: 0,
            report: reportWith({
              attempt: { added: 412 },
              dbAnalysis: { added: 38, updated: 1, unchanged: 1, skipped: 2 },
            }),
          },
        })}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'Nothing already on this device was removed',
    )
    // Four separate columns — added, updated, already here, not applicable —
    // because folding them together is how an idempotent operation comes to
    // look like a destructive one. The two skipped analyses are the #133 case:
    // a pass about a game this device holds a different starting position for.
    const summary = within(screen.getByRole('status').closest('.import-summary')!)
    expect(summary.getByRole('row', { name: /Engine analyses 38 1 1 2/ })).toBeInTheDocument()
    // A section the file had nothing for is not a row of zeroes.
    expect(summary.queryByRole('row', { name: /Games you played/ })).not.toBeInTheDocument()
  })

  it('reports a second import of the same file as having changed nothing', () => {
    render(
      <HistoryTransferPanel
        transfer={transfer({
          importState: {
            status: 'done',
            bytesRead: 0,
            report: reportWith({ attempt: { unchanged: 412 }, dbGame: { unchanged: 41_238 } }),
          },
        })}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Everything in that file was already here')
  })

  it('says when a played game had to be filed under a new id', () => {
    render(
      <HistoryTransferPanel
        transfer={transfer({
          importState: {
            status: 'done',
            bytesRead: 0,
            report: { ...reportWith({ game: { added: 3 } }), renamed: 1 },
          },
        })}
      />,
    )

    expect(screen.getByText(/arrived under a new id/)).toHaveTextContent('nothing was overwritten')
  })
})
