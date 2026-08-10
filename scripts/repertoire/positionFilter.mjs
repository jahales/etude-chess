// A fixed-memory answer to "will this position survive the prune?"
//
// `buildBook` holds every position it sees in a Map and prunes the rare ones at
// the end. Almost all of them are rare: a 5M-game book at ply 16 keeps 342,105
// positions, and a 4M-game book at ply 20 reached **16,731,809** before V8's
// per-Map ceiling (2^24) stopped it outright. The memory is spent almost
// entirely on rows that are about to be thrown away.
//
// So count first, in one cheap pass, and let the real pass skip anything that
// cannot possibly survive. A position seen fewer than `minGames` times cannot
// have a *move* played `minGames` times, so the test is exact.
//
// The counters are saturating bytes in a fixed table indexed by a hash of the
// position key, which means:
//
//   - memory is constant — 64 MB at the default width, whatever the input —
//     rather than growing with distinct positions, so the Map ceiling stops
//     being reachable at all;
//   - collisions can only make a count too *high*, never too low. A collision
//     therefore keeps a position that would have been pruned. That is the safe
//     direction: the second pass tallies exactly and prunes exactly, so the
//     output is identical either way and a collision costs a little memory
//     rather than a missing line.

/** Table width in bits. 2^26 one-byte counters = 64 MB. */
export const DEFAULT_BITS = 26

/**
 * FNV-1a over the key's UTF-16 units.
 *
 * Chosen for being fast and dependency-free rather than for distribution: the
 * only consequence of a poor spread is over-counting, which is safe.
 */
export function hashKey(key) {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * @param {object} [opts]
 * @param {number} [opts.bits]      table width; memory is 2^bits bytes
 * @param {number} [opts.minGames]  the prune threshold this is predicting
 */
export function createPositionFilter({ bits = DEFAULT_BITS, minGames = 5 } = {}) {
  const size = 2 ** bits
  const mask = size - 1
  const counts = new Uint8Array(size)
  // Saturate rather than wrap: a byte that rolls over to 0 would drop the most
  // common positions in the book, which is the worst possible failure here.
  const ceiling = Math.min(255, Math.max(1, minGames))
  let counted = 0

  return {
    bits,
    minGames,
    bytes: size,

    /** Record one sighting of a position. */
    count(key) {
      const i = hashKey(key) & mask
      if (counts[i] < ceiling) counts[i]++
      counted++
    },

    /** Whether the position could still survive the prune. */
    keeps(key) {
      return counts[hashKey(key) & mask] >= ceiling
    },

    /**
     * Share of the table in use. Past roughly 50% collisions get common enough
     * that the filter stops discarding much — reported so a build can say so
     * rather than quietly losing its benefit.
     */
    stats() {
      let live = 0
      for (let i = 0; i < size; i++) if (counts[i] > 0) live++
      return { counted, live, load: live / size, bytes: size }
    },
  }
}
