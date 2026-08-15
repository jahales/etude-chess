import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The layering rule from ADR 0015, enforced instead of merely documented.
 *
 * Dependencies point one way: `domain` ← adapters (`engine`, `persist`) ← `app`
 * ← `ui`. Read the arrows as "is imported by": the adapters import the domain,
 * `app` imports the domain and the adapters, `ui` imports everything. Nothing
 * points back up — an adapter importing `app` is exactly the violation the
 * ALLOWED table below forbids and the cycle test at the bottom pins down.
 *
 * This existed only as prose until an adapter (`persist/db.ts`) started
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

  /**
   * Every **runtime** import inside `src/domain` carries an explicit `.ts`.
   *
   * The domain is the one layer the off-app scripts import directly, and they
   * run under raw Node's type stripping, which does not resolve an
   * extensionless relative specifier. Vite and vitest both do — so a missing
   * `.ts` passes the whole suite and CI, and fails the moment a script reaches
   * for that module:
   *
   *     ERR_MODULE_NOT_FOUND  .../src/domain/harness
   *
   * Documented in architecture.md and violated by five modules before this test
   * existed, four of them predating the fifth by months. Nothing caught it
   * because nothing could: the failure lives outside the bundler.
   *
   * Type-only imports are exempt, and must stay extensionless — stripping
   * deletes the statement before anything resolves it.
   */
  it('domain runtime imports carry an explicit .ts, so a script can load them', () => {
    const violations: string[] = []
    for (const file of sourceFiles(join(SRC, 'domain'))) {
      const source = readFileSync(file, 'utf8')
      // The clause may span lines, but it must not span another `import` — a
      // plain `[^;]+?` lets a non-relative import (`from 'chess.js'`, which
      // this pattern deliberately does not match) run on into the next
      // statement and report *its* specifier, which is how the first draft of
      // this test accused three `import type` lines of being runtime imports.
      for (const match of source.matchAll(
        /^import\s+(?!type\s)((?:(?!^import)[\s\S])*?)\s+from\s+'(\.[^']+)'/gm,
      )) {
        const [, clause = '', spec = ''] = match
        // `import { type Foo }` is still erased entirely; only a value binding
        // survives to need resolving.
        const everyBindingIsAType = /^\{[^}]*\}$/.test(clause.trim())
          && clause.replace(/[{}]/g, '').split(',').every((b) => /^\s*type\s/.test(b) || !b.trim())
        if (everyBindingIsAType) continue
        if (!spec.endsWith('.ts')) violations.push(`${file.replace(SRC, 'src')} → '${spec}'`)
      }
    }
    expect(violations).toEqual([])
  })

  it('has no cycle between the app layer and the persistence adapter', () => {
    // The specific regression this file was written for: persist/db.ts defining
    // its record shape in terms of app/playMachine's types.
    const persistImports = sourceFiles(join(SRC, 'persist')).flatMap((f) =>
      importedLayers(readFileSync(f, 'utf8')),
    )
    expect(persistImports).not.toContain('app')
  })
})
