// A scripted UCI engine, so engine.mjs can be tested without Stockfish.
//
// Speaks just enough UCI for the driver: `uci`/`uciok`, `isready`/`readyok`,
// and `go` replying with lines from a JSON script. Every received command is
// appended to FAKE_ENGINE_LOG, which is how tests assert on options the driver
// sends — `Threads value 1` is a reproducibility guarantee that otherwise rests
// on a comment.
import { createInterface } from 'node:readline'
import { appendFileSync, readFileSync } from 'node:fs'

const logPath = process.env.FAKE_ENGINE_LOG
const script = process.env.FAKE_ENGINE_SCRIPT
  ? JSON.parse(readFileSync(process.env.FAKE_ENGINE_SCRIPT, 'utf8'))
  : {}
let go = 0

createInterface({ input: process.stdin }).on('line', (line) => {
  if (logPath) appendFileSync(logPath, `${line}\n`)
  if (line === 'uci') return void process.stdout.write('id name FakeEngine\nuciok\n')
  if (line === 'isready') return void process.stdout.write('readyok\n')
  if (line.startsWith('go')) {
    const out = script.searches?.[go] ?? script.default ?? ['bestmove e2e4']
    go++
    return void process.stdout.write(`${out.join('\n')}\n`)
  }
  if (line === 'quit') process.exit(0)
})
