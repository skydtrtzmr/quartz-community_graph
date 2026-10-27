/** Owns one overlay rendering request, including work still awaiting data or Pixi initialization. */
export function createGraphRenderScope() {
  let generation = 0
  const cleanups = new Set<() => void>()

  function clear() {
    generation++
    for (const cleanup of cleanups) cleanup()
    cleanups.clear()
  }

  function start() {
    clear()
    const current = generation
    return {
      isCurrent: () => current === generation,
      add(cleanup: () => void) {
        if (current === generation) cleanups.add(cleanup)
        else cleanup()
      },
    }
  }

  return { start, clear }
}
