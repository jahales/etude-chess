import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The layering rule from ADR 0015, enforced instead of merely documented.
 *
 * Dependencies point one way: `domain` ← `app` ← adapters (`engine`, `persist`)
 * ← `ui`. This existed only as prose until an adapter (`persist/db.ts`) started
 * importing reducer types, which made the on-disk schema depend on the
 * application layer and produced an app ⇄ persist cycle. Prose didn't catch it;
 * this does.
 */

const SRC = join(import.meta.dirname, '.')

/** Which layers each layer is allowed to import from. */
const ALLOWED: Record<string, string[]> = {
  // The domain is pure chess/grading logic with no knowledge of anything else.
  domain: [],
  // The application layer orchestrates the domain and the ports.
  app: ['domain', 'engine', 'persist'],
  // Adapters implement a port. They may speak the domain's vocabulary, never the app's.
  engine: ['domain'],
  persist: ['domain'],
  // The UI sits on top and may use everything.
  ui: ['domain', 'app', 'engine', 'persist', 'ui'],
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    // Tests are allowed to reach anywhere — they assert behaviour across layers.
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Cross-layer imports only ever look like `../<layer>/...` or `../../<layer>/...`. */
function importedLayers(source: string): string[] {
  const layers = new Set<string>()
  for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
    const spec = match[1]
    if (!spec) continue
    const layer = /(?:\.\.\/)+([a-z]+)\//.exec(spec)?.[1]
    if (layer && layer in ALLOWED) layers.add(layer)
  }
  return [...layers]
}

describe('module layering (ADR 0015)', () => {
  for (const layer of Object.keys(ALLOWED)) {
    it(`${layer} imports only from ${ALLOWED[layer]!.join(', ') || 'nothing'}`, () => {
      const violations: string[] = []
      for (const file of sourceFiles(join(SRC, layer))) {
        for (const imported of importedLayers(readFileSync(file, 'utf8'))) {
          if (imported !== layer && !ALLOWED[layer]!.includes(imported)) {
            violations.push(`${file.replace(SRC, 'src')} → ${imported}`)
          }
        }
      }
      expect(violations).toEqual([])
    })
  }

  it('has no cycle between the app layer and the persistence adapter', () => {
    // The specific regression this file was written for: persist/db.ts defining
    // its record shape in terms of app/playMachine's types.
    const persistImports = sourceFiles(join(SRC, 'persist')).flatMap((f) =>
      importedLayers(readFileSync(f, 'utf8')),
    )
    expect(persistImports).not.toContain('app')
  })
})
