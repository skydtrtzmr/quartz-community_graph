import { describe, expect, it, vi } from "vitest"
import { createGraphRenderScope } from "../src/components/scripts/graphRenderScope"

describe("overlay rendering lifecycle", () => {
  it("discards a pending render when the overlay closes", async () => {
    const scope = createGraphRenderScope()
    const pending = scope.start()
    const cleanup = vi.fn()
    scope.clear()
    await Promise.resolve()
    expect(pending.isCurrent()).toBe(false)
    pending.add(cleanup)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it("a late completion cannot replace a reopened overlay", () => {
    const scope = createGraphRenderScope()
    const previous = scope.start()
    const active = scope.start()
    const oldCleanup = vi.fn()
    const activeCleanup = vi.fn()
    active.add(activeCleanup)
    previous.add(oldCleanup)
    expect(oldCleanup).toHaveBeenCalledOnce()
    expect(activeCleanup).not.toHaveBeenCalled()
    expect(active.isCurrent()).toBe(true)
    scope.clear()
    scope.clear()
    expect(activeCleanup).toHaveBeenCalledOnce()
  })

  it("cleans a visible render before switching the overlay view", () => {
    const scope = createGraphRenderScope()
    const cleanup = vi.fn()
    scope.start().add(cleanup)
    scope.start()
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
