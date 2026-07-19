import { useEffect, useRef, useState } from 'react'

/** Track a container's width (clamped) so the board stays responsive. */
export function useBoardWidth(max = 560, min = 260) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(360)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setWidth(Math.max(min, Math.min(max, el.clientWidth)))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [max, min])

  return { ref, width }
}
