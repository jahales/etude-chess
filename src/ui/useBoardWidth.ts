import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * How far down the page the board starts, published to CSS as `--board-top`.
 *
 * It goes on the document element rather than on the board itself because the
 * rule that needs it — the `.play` grid track — sits on an *ancestor*, and
 * custom properties only inherit downwards. One board is on screen at a time,
 * so a single reading is never ambiguous.
 */
const TOP_VAR = '--board-top'

/**
 * The board's rendered size, from the space it has in *both* directions.
 *
 * Two directions, two owners. CSS caps the board against the viewport height
 * (`--board-cap` in styles.css) and against the width its column is given; this
 * hook feeds CSS the one term it cannot see — how far down the page the board
 * starts — and reads back the pixel width the layout settled on, because
 * `Chessboard` takes a number rather than a length.
 *
 * Sizing on width alone is the failure this exists to prevent (#150): on a
 * short, wide window a width-sized board is taller than the viewport, and then
 * the board and the controls under it scroll out of sight in the same motion,
 * which is worse than a board that is merely small.
 *
 * `min` is a floor for the measurement, not a design size: it keeps a board that
 * is briefly measured at zero (mount, a hidden tab) from rendering unusably
 * small. The real floor is `--board-min`.
 */
export function useBoardWidth(min = 260) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(360)

  /**
   * Republished on every render, not only on resize: the board's top moves when
   * something opens above it — the settings panel, the "not the game" ribbon —
   * and neither of those is a resize event. A window resize is not a render, so
   * that gets a listener of its own.
   */
  useLayoutEffect(() => {
    const publish = () => {
      const el = ref.current
      if (!el) return
      // Document space, so a scrolled page reports the same top. Measured from
      // the viewport the board would grow as you scrolled down, which makes more
      // page to scroll — a loop, not a layout.
      const top = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY))
      const root = document.documentElement
      // Writing an unchanged value invalidates style for nothing, and this runs
      // on every keystroke in the reason box.
      if (root.style.getPropertyValue(TOP_VAR) !== `${top}px`) {
        root.style.setProperty(TOP_VAR, `${top}px`)
      }
    }
    publish()
    window.addEventListener('resize', publish)
    return () => window.removeEventListener('resize', publish)
  })

  // Leaving a board screen must leave no measurement behind: a stale top would
  // size the next board against a position it no longer sits at.
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty(TOP_VAR)
    },
    [],
  )

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // The frame's width is set by CSS, so observing it cannot feed back into it.
    const update = () => setWidth(Math.max(min, Math.floor(el.clientWidth)))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [min])

  return { ref, width }
}
