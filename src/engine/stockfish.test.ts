import { describe, it, expect, afterEach } from 'vitest'
import { StockfishAnalyser } from './stockfish'

/**
 * The browser adapter's UCI conversation, against a scripted worker.
 *
 * There is no real engine here on purpose — the repo does not run one in the
 * suite (`scripts/repertoire/engine.test.mjs` scripts a fake the same way). What
 * these pin is the half that is ours: that the option is asked for at all, and
 * that a WDL reading can never end up captioning a position it was not computed
 * for.
 *
 * **The other half was measured rather than asserted here.** `UCI_ShowWDL` is
 * documented as display-only, and the whole of #161 rests on that, so it was
 * checked against the exact WASM build in `public/engine` rather than trusted:
 * nine positions — opening, sharp Italian, K+P endgame, decided middlegame,
 * tablebase-ish endgame, a tactic, a delivered mate and a declined mate-in-one —
 * graded twice at the app's 700k nodes, once with the option on and once off.
 * Tier, win% swing (to six decimal places) and `bestmove` came back identical in
 * every case. The option adds a field to the output and moves no search, so no
 * grade in the app changes because this adapter turns it on.
 */

type Script = (cmd: string, reply: (line: string) => void) => void

/** A Worker that answers UCI commands from a script, recording what it was sent. */
class FakeWorker {
  static last: FakeWorker
  onmessage: ((e: MessageEvent) => void) | null = null
  sent: string[] = []
  terminated = false
  constructor(private script: Script) {
    FakeWorker.last = this
  }
  postMessage(cmd: string): void {
    this.sent.push(cmd)
    // Asynchronous, like a real worker: a reply that arrived before the caller
    // had installed its listener would make the tests pass for the wrong reason.
    this.script(cmd, (line) => {
      queueMicrotask(() => this.onmessage?.({ data: line } as MessageEvent))
    })
  }
  terminate(): void {
    this.terminated = true
  }
}

/** Install the scripted worker as the global `Worker` jsdom does not provide. */
function withWorker(script: Script): StockfishAnalyser {
  ;(globalThis as { Worker?: unknown }).Worker = class extends FakeWorker {
    constructor() {
      super(script)
    }
  }
  return new StockfishAnalyser('unused.js')
}

/** Handshake replies, shared by every script below. */
function handshake(cmd: string, reply: (line: string) => void): boolean {
  if (cmd === 'uci') return reply('uciok'), true
  if (cmd === 'isready') return reply('readyok'), true
  return false
}

afterEach(() => {
  delete (globalThis as { Worker?: unknown }).Worker
})

describe('the browser adapter and UCI_ShowWDL', () => {
  it('asks for win/draw/loss during the handshake, while the engine is idle', async () => {
    const engine = withWorker((cmd, reply) => {
      handshake(cmd, reply)
    })
    await engine.ready()
    const sent = FakeWorker.last.sent
    expect(sent).toContain('setoption name UCI_ShowWDL value true')
    // UCI only permits `setoption` between searches. Sending it after `uciok`
    // and before `isready` is the one window that is guaranteed idle.
    expect(sent.indexOf('setoption name UCI_ShowWDL value true')).toBeGreaterThan(
      sent.indexOf('uci'),
    )
    expect(sent.indexOf('setoption name UCI_ShowWDL value true')).toBeLessThan(
      sent.indexOf('isready'),
    )
    engine.dispose()
  })

  it('carries the WDL of the last complete info line onto the evaluation', async () => {
    const engine = withWorker((cmd, reply) => {
      if (handshake(cmd, reply)) return
      if (cmd.startsWith('go')) {
        reply('info depth 10 score cp 60 wdl 300 650 50 pv e2e4')
        reply('info depth 20 score cp 494 wdl 1000 0 0 pv a7a5 b2b4')
        reply('bestmove a7a5')
      }
    })
    const ev = await engine.evaluate('startpos-ish')
    expect(ev.wdl).toEqual({ win: 1000, draw: 0, loss: 0 })
    expect(ev.score).toEqual({ type: 'cp', value: 494 })
    engine.dispose()
  })

  it('drops a stale WDL when a later score line carries none', async () => {
    // The failure this prevents is not cosmetic. A leftover `1000/0/0` from an
    // earlier iteration, shown against a later score, reads as "the result was
    // never in doubt" — a claim about the position, and the exact claim the
    // game-review skill §4 tells a reader to check before discounting a swing.
    const engine = withWorker((cmd, reply) => {
      if (handshake(cmd, reply)) return
      if (cmd.startsWith('go')) {
        reply('info depth 10 score cp 494 wdl 1000 0 0 pv a7a5')
        reply('info depth 22 score cp 12') // a score with no pv and no wdl
        reply('bestmove a7a5')
      }
    })
    const ev = await engine.evaluate('fen')
    expect(ev.score).toEqual({ type: 'cp', value: 12 })
    expect(ev.wdl).toBeUndefined()
    expect(ev.pv).toBeUndefined()
    engine.dispose()
  })

  it('leaves wdl absent when the engine reports none at all', async () => {
    const engine = withWorker((cmd, reply) => {
      if (handshake(cmd, reply)) return
      if (cmd.startsWith('go')) {
        reply('info depth 12 score cp 34 pv e2e4')
        reply('bestmove e2e4')
      }
    })
    const ev = await engine.evaluate('fen')
    // Absent, never a zeroed triple: `{0,0,0}` would be read as a position with
    // no possible outcome, and `{0,1000,0}` as a dead draw. Neither was said.
    expect('wdl' in ev).toBe(false)
    engine.dispose()
  })

  it('carries WDL per line through analyseLines, and omits it where absent', async () => {
    const engine = withWorker((cmd, reply) => {
      if (handshake(cmd, reply)) return
      if (cmd.startsWith('go')) {
        reply('info depth 18 multipv 1 score cp 80 wdl 700 290 10 pv d2d4 d7d5')
        reply('info depth 18 multipv 2 score cp 10 pv e2e4 e7e5')
        reply('bestmove d2d4')
      }
    })
    const lines = await engine.analyseLines('fen', { multipv: 2 })
    expect(lines[0]!.wdl).toEqual({ win: 700, draw: 290, loss: 10 })
    expect('wdl' in lines[1]!).toBe(false)
    engine.dispose()
  })
})
